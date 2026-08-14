# 02 — A Cascade session shows up as one trace (fail-open)

**What to build:** An operator looking at Langfuse (or an in-memory exporter in tests) sees `cascade.session → cascade.segment → stt.deepgram / llm.translate / tts.elevenlabs`. WS resume inside the grace window continues the **same** session trace. Provider errors become ERROR spans. A dead collector or a telemetry bug never drops audio. Span text over 8000 chars is truncated; the span is kept.

**Blocked by:** 01 — Empty `.env` is a no-op; optional Langfuse compose comes up

**Size:** Right-sized — one demoable behaviour (Cascade in Langfuse) including the failure/resume paths that belong to that same trace. Splitting “happy path” vs “errors” would leave the second ticket unable to stand alone.

**Status:** ready-for-agent

**Backend scope:** Orchestrator span seams; `_DetachedSession` carries OTel context; truncation helper; `metrics.py` recording at those seams; `openai_translation.py` usage; extract `origins.py` from the existing Origin check (so 03 can reuse it).

**Frontend scope:** None

## Acceptance criteria

- [ ] In-memory exporter: parent/name/text shape matches the brief tree (AC1). No audio bytes on any span.
- [ ] `llm.translate` carries `gen_ai.*` model/tokens/cost when the fake OpenAI stream ends with a usage-only chunk (`stream_options={"include_usage": True}`).
- [ ] WS drop + `resume_session` within the grace window → **one** `cascade.session` trace; grace expiry ends the span ERROR with `session.end_reason=grace_window_expired`.
- [ ] `ProviderError` sets span status ERROR + `error.provider` / `error.kind` / `error.retryable`; standalone `provider.error` when there is no live stage span (AC2).
- [ ] Text > 8000 chars → truncated, `<attr>.truncated=true`, span still exported.
- [ ] `_emit_latency` attaches `translation_first_token` / `tts_first_byte` events at the same instants as the existing WS latency messages — **no change to the `/ws/cascade` wire protocol** (AC17 constraint).
- [ ] Dead collector (black-holed `OTEL_EXPORTER_OTLP_ENDPOINT`): Cascade session completes within its normal time budget (AC9).
- [ ] Injected raising tracer/exporter does not drop the segment or kill the session.
- [ ] Cascade seams record `interpreter.stage.duration`, `interpreter.turn.duration`, `interpreter.llm.tokens`, `interpreter.llm.cost`, `interpreter.errors` (AC6, Cascade half).
- [ ] Mic `/ws/cascade` still requires no cookie (AC16).

## Brief anchors

- Brief: `.scratch/briefs/observability-technical-brief.md` — Cascade instrumentation seams table; Background flow (Cascade); truncation; token/cost seam in `openai_translation.py`.
- Trace shape (never tool-call demos): `cascade.session → cascade.segment → stt.deepgram / llm.translate / tts.elevenlabs`.
- Seams (wrap, not rewrite): `_start_new_session`, `_resume_session`, `_expire_after_grace_window` / `_teardown_session`, `_cut_segment`, `_process_segment`, `_run_translation_with_retry`, `_run_tts_with_retry`, `_send_error` / `_record_failure_and_maybe_trip`, `_emit_latency`.
- Streaming: set text attributes immediately before the span ends, never per-delta. Retries: each attempt is its own child span with `retry.attempt`.
- Tests: `backend/tests/test_telemetry_spans.py`, dead-collector case in `test_telemetry_noop.py`.
- Shared files `spans.py` / `metrics.py` / `origins.py` — if 03 lands in parallel, reconcile on those names from the brief. This ticket extracts `origins.py` from the existing orchestrator Origin check (same precedent as `app/languages.py`).

## Locked substitutions (gate 7)

- WS resume = same `cascade.session` trace.
- Truncate span text at 8000 chars, keep the span.
- Fail-open: telemetry exceptions never propagate into the audio path.
