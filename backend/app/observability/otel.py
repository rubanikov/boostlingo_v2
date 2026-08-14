"""OpenTelemetry SDK bootstrap.

Installed once from the FastAPI lifespan. An empty `OTEL_EXPORTER_OTLP_ENDPOINT`
installs no TracerProvider at all, so the OTel API's built-in no-op tracer is
what every later `start_as_current_span` call hits: no branching at those
call sites, and no outbound OTLP. Metrics are a separate gate:
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` unset means no MeterProvider (Langfuse's
OTLP endpoint is traces-only).

Export is HTTP protobuf via `BatchSpanProcessor` only. Anything that blows up
in here is logged and swallowed: a telemetry bug must not take down the app.
"""

from __future__ import annotations

import logging
import os

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

logger = logging.getLogger(__name__)

_METRICS_EXPORT_INTERVAL_MS = 60_000


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def init_telemetry() -> None:
    try:
        _maybe_install_tracer_provider()
    except Exception:
        logger.exception("OTel traces init failed; continuing without a TracerProvider")
    try:
        _maybe_install_meter_provider()
    except Exception:
        logger.exception("OTel metrics init failed; continuing without a MeterProvider")


def shutdown_telemetry() -> None:
    try:
        provider = trace.get_tracer_provider()
        if isinstance(provider, TracerProvider):
            provider.shutdown()
    except Exception:
        logger.exception("OTel traces shutdown failed")
    try:
        provider = metrics.get_meter_provider()
        if isinstance(provider, MeterProvider):
            provider.shutdown()
    except Exception:
        logger.exception("OTel metrics shutdown failed")


def _maybe_install_tracer_provider() -> None:
    if not _env("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    # Resource.create() picks up OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES.
    # TracerProvider() reads OTEL_TRACES_SAMPLER (documented as always_on).
    provider = TracerProvider(resource=Resource.create())
    # OTLPSpanExporter reads OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / etc.
    # HTTP protobuf by construction; this is not the gRPC exporter.
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)


def _maybe_install_meter_provider() -> None:
    if not _env("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"):
        return
    reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(),
        export_interval_millis=_METRICS_EXPORT_INTERVAL_MS,
    )
    metrics.set_meter_provider(
        MeterProvider(resource=Resource.create(), metric_readers=[reader])
    )
