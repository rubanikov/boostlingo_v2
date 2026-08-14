"""Langfuse Metrics API v2 + Observations API v2 client.

Maps upstream rows onto the owned dashboard JSON. Never calls the deprecated
GET /api/public/traces. Transport failures become LangfuseUnreachable (503);
non-2xx or unusable bodies become LangfuseUnusable (502).
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.config import settings

TIMEOUT_SECONDS = 10.0

_ROOT_FILTER = {
    "column": "isRootObservation",
    "operator": "=",
    "value": True,
    "type": "boolean",
}
_PARENT_NULL_FILTER = {
    "column": "parentObservationId",
    "operator": "is null",
    "type": "null",
    "value": None,
}

_WINDOW_DELTAS = {
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}


class LangfuseUnreachable(Exception):
    """Langfuse could not be reached (maps to HTTP 503)."""


class LangfuseUnusable(Exception):
    """Langfuse responded, but the body cannot be used (maps to HTTP 502)."""


class TraceNotFound(Exception):
    """Well-formed trace id with no observations (maps to HTTP 404)."""


def utc_now() -> datetime:
    return datetime.now(UTC)


def langfuse_configured() -> bool:
    return bool(
        settings.langfuse_host.strip()
        and settings.langfuse_public_key.strip()
        and settings.langfuse_secret_key.strip()
    )


def iso_z(dt: datetime) -> str:
    dt = dt.astimezone(UTC).replace(microsecond=0)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def window_bounds(window: str) -> tuple[datetime, datetime]:
    end = utc_now()
    start = end - _WINDOW_DELTAS[window]
    return start, end


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def format_iso(value: str | datetime) -> str:
    dt = value if isinstance(value, datetime) else _parse_iso(value)
    dt = dt.astimezone(UTC)
    ms = dt.microsecond // 1000
    if ms == 0:
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


def _optional_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_int(value: object) -> int | None:
    number = _optional_float(value)
    if number is None:
        return None
    return round(number)


def _seconds_to_ms(value: object) -> int | None:
    number = _optional_float(value)
    if number is None:
        return None
    return round(number * 1000)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=settings.langfuse_host.rstrip("/"),
        auth=httpx.BasicAuth(
            settings.langfuse_public_key, settings.langfuse_secret_key
        ),
        timeout=TIMEOUT_SECONDS,
    )


async def _request(
    client: httpx.AsyncClient, path: str, params: dict[str, str]
) -> httpx.Response:
    try:
        return await client.get(path, params=params)
    except httpx.HTTPError as exc:
        raise LangfuseUnreachable("Failed to reach Langfuse.") from exc


def _parse_json(response: httpx.Response) -> dict[str, Any]:
    if response.status_code < 200 or response.status_code >= 300:
        raise LangfuseUnusable("Langfuse returned an unusable response.")
    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise LangfuseUnusable("Langfuse returned an unusable response.") from exc
    if not isinstance(payload, dict):
        raise LangfuseUnusable("Langfuse returned an unusable response.")
    return payload


def _require_list(payload: dict[str, Any], key: str = "data") -> list[Any]:
    if key not in payload:
        raise LangfuseUnusable("Langfuse returned an unusable response.")
    data = payload[key]
    if not isinstance(data, list):
        raise LangfuseUnusable("Langfuse returned an unusable response.")
    return data


async def _metrics(client: httpx.AsyncClient, query: dict[str, Any]) -> list[dict]:
    response = await _request(
        client, "/api/public/v2/metrics", {"query": json.dumps(query)}
    )
    payload = _parse_json(response)
    rows = _require_list(payload)
    return [row for row in rows if isinstance(row, dict)]


def _map_latency(rows: list[dict], series_rows: list[dict]) -> dict[str, Any]:
    row = rows[0] if rows else {}
    series: list[dict[str, Any]] = []
    for item in series_rows:
        stamp = item.get("time_dimension")
        if not stamp:
            continue
        series.append(
            {
                "t": format_iso(str(stamp)),
                "p50Ms": _seconds_to_ms(item.get("p50_latency")),
                "p95Ms": _seconds_to_ms(item.get("p95_latency")),
            }
        )
    return {
        "p50Ms": _seconds_to_ms(row.get("p50_latency")) if rows else None,
        "p95Ms": _seconds_to_ms(row.get("p95_latency")) if rows else None,
        "series": series,
    }


def _error_counts(rows: list[dict]) -> tuple[int, int]:
    error_count = 0
    total = 0
    for row in rows:
        count = _optional_int(row.get("count_count")) or 0
        total += count
        if str(row.get("level") or "").upper() == "ERROR":
            error_count += count
    return error_count, total


def _map_error_series(rows: list[dict]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        stamp = row.get("time_dimension")
        if not stamp:
            continue
        buckets[format_iso(str(stamp))].append(row)
    series: list[dict[str, Any]] = []
    for stamp, group in sorted(buckets.items()):
        error_count, total = _error_counts(group)
        if total == 0:
            continue
        series.append({"t": stamp, "rate": error_count / total})
    return series


def _map_error(rows: list[dict], series_rows: list[dict]) -> dict[str, Any]:
    series = _map_error_series(series_rows)
    empty = {
        "rate": None,
        "errorCount": None,
        "totalCount": None,
        "series": series,
    }
    if not rows:
        return empty
    error_count, total = _error_counts(rows)
    if total == 0:
        return empty
    return {
        "rate": error_count / total,
        "errorCount": error_count,
        "totalCount": total,
        "series": series,
    }


def _map_cost(rows: list[dict]) -> dict[str, Any]:
    if not rows:
        return {
            "totalUsd": None,
            "totalTokens": None,
            "inputTokens": None,
            "outputTokens": None,
        }
    row = rows[0]
    return {
        "totalUsd": _optional_float(row.get("sum_totalCost")),
        "totalTokens": _optional_int(row.get("sum_totalTokens")),
        "inputTokens": _optional_int(row.get("sum_inputTokens")),
        "outputTokens": _optional_int(row.get("sum_outputTokens")),
    }


def _map_sessions(rows: list[dict]) -> dict[str, Any]:
    realtime = None
    cascade = None
    for row in rows:
        name = row.get("traceName") or row.get("name")
        count = _optional_int(row.get("count_count"))
        if name == "realtime.session":
            realtime = count
        elif name == "cascade.session":
            cascade = count
    return {"realtime": realtime, "cascade": cascade}


async def fetch_summary(window: str) -> dict[str, Any]:
    start, end = window_bounds(window)
    from_z, to_z = iso_z(start), iso_z(end)
    latency_metrics = [
        {"measure": "latency", "aggregation": "p50"},
        {"measure": "latency", "aggregation": "p95"},
    ]
    count_metric = [{"measure": "count", "aggregation": "count"}]
    queries = {
        "latency": {
            "view": "observations",
            "metrics": latency_metrics,
            "filters": [_ROOT_FILTER],
            "fromTimestamp": from_z,
            "toTimestamp": to_z,
        },
        "latency_series": {
            "view": "observations",
            "metrics": latency_metrics,
            "filters": [_ROOT_FILTER],
            "timeDimension": {"granularity": "auto"},
            "fromTimestamp": from_z,
            "toTimestamp": to_z,
        },
        "error": {
            "view": "observations",
            "metrics": count_metric,
            "dimensions": [{"field": "level"}],
            "filters": [_ROOT_FILTER],
            "fromTimestamp": from_z,
            "toTimestamp": to_z,
        },
        "error_series": {
            "view": "observations",
            "metrics": count_metric,
            "dimensions": [{"field": "level"}],
            "filters": [_ROOT_FILTER],
            "timeDimension": {"granularity": "auto"},
            "fromTimestamp": from_z,
            "toTimestamp": to_z,
        },
        "cost": {
            "view": "observations",
            "metrics": [
                {"measure": "totalCost", "aggregation": "sum"},
                {"measure": "totalTokens", "aggregation": "sum"},
                {"measure": "inputTokens", "aggregation": "sum"},
                {"measure": "outputTokens", "aggregation": "sum"},
            ],
            "filters": [],
            "fromTimestamp": from_z,
            "toTimestamp": to_z,
        },
        "sessions": {
            "view": "observations",
            "metrics": count_metric,
            "dimensions": [{"field": "traceName"}],
            "filters": [_ROOT_FILTER],
            "fromTimestamp": from_z,
            "toTimestamp": to_z,
        },
    }
    async with _client() as client:
        latency, latency_series, error, error_series, cost, sessions = await asyncio.gather(
            _metrics(client, queries["latency"]),
            _metrics(client, queries["latency_series"]),
            _metrics(client, queries["error"]),
            _metrics(client, queries["error_series"]),
            _metrics(client, queries["cost"]),
            _metrics(client, queries["sessions"]),
        )
    return {
        "window": window,
        "from": from_z,
        "to": to_z,
        "latency": _map_latency(latency, latency_series),
        "errorRate": _map_error(error, error_series),
        "cost": _map_cost(cost),
        "sessions": _map_sessions(sessions),
    }


def _mode_of(row: dict[str, Any]) -> str | None:
    for candidate in (row.get("name"), row.get("traceName")):
        if candidate == "cascade.session":
            return "cascade"
        if candidate == "realtime.session":
            return "realtime"
    return None


def _latency_ms(row: dict[str, Any]) -> int | None:
    start = row.get("startTime")
    end = row.get("endTime")
    if start and end:
        try:
            delta = _parse_iso(str(end)) - _parse_iso(str(start))
            return round(delta.total_seconds() * 1000)
        except (TypeError, ValueError):
            pass
    if row.get("latency") is not None:
        return _seconds_to_ms(row.get("latency"))
    return None


def _map_trace_row(row: dict[str, Any]) -> dict[str, Any] | None:
    trace_id = row.get("traceId")
    start = row.get("startTime")
    mode = _mode_of(row)
    if not trace_id or not start or mode is None:
        return None
    level = str(row.get("level") or "").upper()
    return {
        "traceId": trace_id,
        "timestamp": format_iso(str(start)),
        "mode": mode,
        "latencyMs": _latency_ms(row),
        "totalTokens": _optional_int(row.get("totalUsage")),
        "costUsd": _optional_float(row.get("totalCost")),
        "status": "error" if level == "ERROR" else "success",
    }


def _group_roots(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_trace: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        trace_id = row.get("traceId")
        if not trace_id:
            continue
        by_trace[str(trace_id)].append(row)
    roots: list[dict[str, Any]] = []
    for group in by_trace.values():
        null_parent = [
            row
            for row in group
            if row.get("parentObservationId") in (None, "")
        ]
        if null_parent:
            chosen = null_parent
        else:
            flagged = [row for row in group if row.get("isRootObservation") is True]
            chosen = flagged or group
        roots.append(min(chosen, key=lambda row: str(row.get("startTime") or "")))
    roots.sort(key=lambda row: str(row.get("startTime") or ""), reverse=True)
    return roots


def _observation_filters(*, mode: str, status: str) -> list[dict[str, Any]]:
    filters: list[dict[str, Any]] = [dict(_PARENT_NULL_FILTER)]
    if mode == "cascade":
        filters.append(
            {
                "column": "traceName",
                "operator": "=",
                "value": "cascade.session",
                "type": "string",
            }
        )
    elif mode == "realtime":
        filters.append(
            {
                "column": "traceName",
                "operator": "=",
                "value": "realtime.session",
                "type": "string",
            }
        )
    if status == "error":
        filters.append(
            {
                "column": "level",
                "operator": "any of",
                "value": ["ERROR"],
                "type": "stringOptions",
            }
        )
    return filters


async def fetch_traces(
    window: str,
    mode: str,
    status: str,
    limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    start, end = window_bounds(window)
    from_z, to_z = iso_z(start), iso_z(end)
    filters = _observation_filters(mode=mode, status=status)
    params: dict[str, str] = {
        "fields": "core,basic,usage,model,trace_context",
        "fromStartTime": from_z,
        "toStartTime": to_z,
        "limit": str(limit),
        "filter": json.dumps(filters),
    }
    if cursor:
        params["cursor"] = cursor

    grouped = False
    async with _client() as client:
        response = await _request(client, "/api/public/v2/observations", params)
        if response.status_code == 400:
            filters = [
                item
                for item in filters
                if item.get("column") != "parentObservationId"
            ]
            if filters:
                params["filter"] = json.dumps(filters)
            else:
                params.pop("filter", None)
            response = await _request(client, "/api/public/v2/observations", params)
            grouped = True
        payload = _parse_json(response)
        rows = [row for row in _require_list(payload) if isinstance(row, dict)]
        if grouped:
            rows = _group_roots(rows)
        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
        next_cursor = meta.get("cursor") or None

    traces = [mapped for row in rows if (mapped := _map_trace_row(row)) is not None]
    return {
        "traces": traces,
        "nextCursor": next_cursor,
        "hasMore": bool(next_cursor),
    }


def _as_text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)


def _maybe_truncate(text: str | None) -> tuple[str | None, bool]:
    if text is None:
        return None, False
    limit = settings.observability_max_span_text_chars
    if limit > 0 and len(text) > limit:
        return text[:limit], True
    return text, False


def _metadata_truncated(meta: object) -> bool:
    if not isinstance(meta, dict):
        return False
    if meta.get("truncated") is True:
        return True
    return any(
        str(key).endswith(".truncated") and value is True
        for key, value in meta.items()
    )


def _span_metadata(obs: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    raw = obs.get("metadata")
    if isinstance(raw, dict):
        meta.update(raw)
    if obs.get("providedModelName"):
        meta.setdefault("model", obs["providedModelName"])
    if obs.get("inputUsage") is not None:
        meta.setdefault("inputTokens", _optional_int(obs["inputUsage"]))
    if obs.get("outputUsage") is not None:
        meta.setdefault("outputTokens", _optional_int(obs["outputUsage"]))
    if obs.get("totalCost") is not None:
        meta.setdefault("costUsd", _optional_float(obs["totalCost"]))
    return meta


def _map_span(obs: dict[str, Any], depth: int, origin: datetime | None) -> dict[str, Any]:
    start = None
    if obs.get("startTime"):
        try:
            start = _parse_iso(str(obs["startTime"]))
        except (TypeError, ValueError):
            start = None
    offset = 0
    if origin is not None and start is not None:
        offset = round((start - origin).total_seconds() * 1000)
    input_text, in_trunc = _maybe_truncate(_as_text(obs.get("input")))
    output_text, out_trunc = _maybe_truncate(_as_text(obs.get("output")))
    level = str(obs.get("level") or "").upper()
    parent = obs.get("parentObservationId")
    if parent == "":
        parent = None
    return {
        "spanId": str(obs.get("id") or ""),
        "parentSpanId": parent,
        "name": obs.get("name") or "",
        "startOffsetMs": offset,
        "durationMs": _latency_ms(obs),
        "status": "error" if level == "ERROR" else "success",
        "depth": depth,
        "input": input_text,
        "output": output_text,
        "truncated": in_trunc or out_trunc or _metadata_truncated(obs.get("metadata")),
        "metadata": _span_metadata(obs),
    }


def flatten_spans(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {str(obs["id"]): obs for obs in observations if obs.get("id")}
    children: dict[str | None, list[dict[str, Any]]] = defaultdict(list)
    for obs in observations:
        parent = obs.get("parentObservationId")
        if parent == "":
            parent = None
        children[parent].append(obs)
    for group in children.values():
        group.sort(key=lambda obs: (str(obs.get("startTime") or ""), str(obs.get("id") or "")))

    roots = list(children.get(None, []))
    seen = {str(obs.get("id")) for obs in roots}
    for obs in observations:
        parent = obs.get("parentObservationId") or None
        oid = str(obs.get("id") or "")
        if parent and parent not in by_id and oid not in seen:
            roots.append(obs)
            seen.add(oid)
    roots.sort(key=lambda obs: (str(obs.get("startTime") or ""), str(obs.get("id") or "")))

    origin: datetime | None = None
    starts: list[datetime] = []
    for obs in observations:
        if not obs.get("startTime"):
            continue
        try:
            starts.append(_parse_iso(str(obs["startTime"])))
        except (TypeError, ValueError):
            continue
    if starts:
        origin = min(starts)

    ordered: list[dict[str, Any]] = []
    visited: set[str] = set()

    def walk(obs: dict[str, Any], depth: int) -> None:
        oid = str(obs.get("id") or "")
        if not oid or oid in visited:
            return
        visited.add(oid)
        ordered.append(_map_span(obs, depth, origin))
        for child in children.get(oid, []):
            walk(child, depth + 1)

    for root in roots:
        walk(root, 0)
    for obs in observations:
        walk(obs, 0)
    return ordered


def _sum_int(rows: list[dict[str, Any]], key: str) -> int | None:
    present = [_optional_int(row.get(key)) for row in rows]
    values = [value for value in present if value is not None]
    if not values:
        return None
    return sum(values)


def _sum_float(rows: list[dict[str, Any]], key: str) -> float | None:
    present = [_optional_float(row.get(key)) for row in rows]
    values = [value for value in present if value is not None]
    if not values:
        return None
    return sum(values)


def _usage_source(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    children = [obs for obs in observations if obs.get("parentObservationId")]
    if any(_optional_int(obs.get("totalUsage")) is not None for obs in children):
        return children
    if any(_optional_float(obs.get("totalCost")) is not None for obs in children):
        return children
    return observations


def _trace_totals(
    trace_id: str, observations: list[dict[str, Any]], spans: list[dict[str, Any]]
) -> dict[str, Any]:
    mode = next((_mode_of(obs) for obs in observations if _mode_of(obs)), None)
    if mode is None:
        root_name = spans[0]["name"] if spans else ""
        mode = "realtime" if root_name.startswith("realtime") else "cascade"
    status = "error" if any(span["status"] == "error" for span in spans) else "success"
    starts = [str(obs["startTime"]) for obs in observations if obs.get("startTime")]
    timestamp = format_iso(min(starts)) if starts else iso_z(utc_now())
    root = next((span for span in spans if span["parentSpanId"] is None), None)
    source = _usage_source(observations)
    model = None
    session_id = None
    for obs in observations:
        if model is None and obs.get("providedModelName"):
            model = obs["providedModelName"]
        if session_id is None and obs.get("sessionId"):
            session_id = obs["sessionId"]
        raw = obs.get("metadata") if isinstance(obs.get("metadata"), dict) else {}
        if session_id is None:
            session_id = raw.get("session.id")
    return {
        "traceId": trace_id,
        "mode": mode,
        "status": status,
        "timestamp": timestamp,
        "totalLatencyMs": root["durationMs"] if root else None,
        "totalTokens": _sum_int(source, "totalUsage"),
        "inputTokens": _sum_int(source, "inputUsage"),
        "outputTokens": _sum_int(source, "outputUsage"),
        "costUsd": _sum_float(source, "totalCost"),
        "model": model,
        "sessionId": session_id,
        "spans": spans,
    }


async def fetch_trace(trace_id: str) -> dict[str, Any]:
    params = {
        "traceId": trace_id,
        "fields": "core,basic,io,usage,model,trace_context",
        "limit": "1000",
    }
    async with _client() as client:
        response = await _request(client, "/api/public/v2/observations", params)
        payload = _parse_json(response)
        rows = [row for row in _require_list(payload) if isinstance(row, dict)]
    if not rows:
        raise TraceNotFound()
    spans = flatten_spans(rows)
    return _trace_totals(trace_id, rows, spans)
