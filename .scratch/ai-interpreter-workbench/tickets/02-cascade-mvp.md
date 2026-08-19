Type: task
Status: ready
Depends on: none — FRONTIER, buildable now in parallel with [01](01-realtime-mvp.md)

# Ticket 2 — Cascade mode: end-to-end voice-in/voice-out MVP with provider abstraction

Size check: right-sized, but large (~4-5 hrs — the thickest ticket in the
set). Considered splitting into "text-only pipeline" (STT→Translation,
transcripts only) + "add TTS" as two tickets; rejected because the TTS-only
remainder (ElevenLabs wiring + Web Audio scheduling on an already-working text
pipeline, ~1-1.5 hrs) would be too thin to justify its own orchestration
overhead. This ticket's thickness matches the architecture's own inherent
complexity, not a slicing failure — hand-building this pipeline is
"meaningfully more engineering" than Realtime mode per the wayfinder's own
framing (tickets 04/05/12).

**Includes its own tests** (provider-boundary contract tests, per the brief's
"targeted tests on the cascade pipeline and provider boundaries" — not
deferred to a later ticket): each Protocol implementation tested against a
mocked SDK, normal streaming maps to typed events, each failure mode maps to
the right `ProviderError` kind + `retryable` flag. pytest + pytest-asyncio,
hand-mocked SDKs, no live network calls.

## What to build

**Backend**
- `providers/base.py` — `STTProvider`, `TranslationProvider`, `TTSProvider`
  as `Protocol` (structural typing, not `ABC`), plus event types and
  structured `ProviderError`.
- `TranscriptSegment` carries `is_final` *and* `speech_final` (not collapsed),
  `is_empty`, and `speaker: int | None` (unused until
  [Ticket 4](04-diarization.md)). `STTProvider.stream()` takes
  `languages: tuple[str, ...]`.
- Concrete implementations:
  - `DeepgramSTTProvider` — WS `wss://api.deepgram.com/v1/listen`,
    `endpointing=500`, bridge the SDK's callback-based `"Results"` event to an
    async generator via `asyncio.Queue` + a concurrent `_pump_audio()` task
    (the wayfinder's own prototype flags this bridge as sketched-but-not-wired
    — real work here).
  - `OpenAITranslationProvider` — streaming chat completions.
  - `ElevenLabsTTSProvider` — WS `stream-input`, TOKEN mode, explicit
    `flush: true` at segment boundaries.
- Orchestrator wires STT → single-utterance segmentation (Deepgram's
  `speech_final` only for now — the LLM-hybrid upgrade is
  [Ticket 5](05-llm-hybrid-segmentation.md)) → translation → TTS, over one
  full-duplex WebSocket per session.

**Frontend**
- AudioWorklet capture (Float32→Int16 scale-and-clamp, ~20-40ms buffering per
  WS frame).
- Minimal UI (unstyled — two text blocks for source/target, no dual-column
  yet).
- Web Audio API buffer scheduling (`AudioBufferSourceNode.start(nextTime)`)
  for gapless playback of raw-PCM TTS chunks.

## Acceptance criteria

- Speaking English produces a live (unstyled) text transcript in English, a
  live translated Spanish text block, and spoken Spanish audio out, for a
  hardcoded EN↔ES pair, single speaker/direction.
- STT/Translation/TTS calls go through the `Protocol` interfaces, not
  directly against SDKs in the orchestrator — swapping `ElevenLabsTTSProvider`
  for a different TTS provider should touch only one file.
- An empty final STT result (silence) does not raise a `ProviderError` — it's
  a valid `TranscriptSegment.is_empty=True` outcome.
- Provider contract tests pass for all three providers, covering both the
  happy path and each documented failure→`ProviderError` mapping.
- Streaming throughout — no full-utterance blocking at any stage (per the
  brief's explicit "Other Specific Requirements").

## API / contract notes

- One full-duplex WebSocket per Cascade session (JSON envelope + binary audio
  frames, ordering preserved on one connection). Path not specified by the
  wayfinder — pick one (e.g. `/ws/cascade`) as an implementation detail.
- `start_session` (client) — language pair.
- Binary audio frames (client) — continuous raw PCM mic audio.
- `source_transcript` / `target_transcript` (server) — carry `segmentId`,
  `isFinal`.
- `segment_boundary` (server) — which mechanism cut the segment (`llm` or
  Deepgram signal — `llm` unused until Ticket 5, always Deepgram's
  `speech_final` for now).
- `tts_audio_meta` (server) immediately followed by a binary audio frame
  (small JSON header, since binary frames can't carry metadata inline).
- Deepgram signals: `is_final` (buffer), `speech_final` (flush boundary,
  `endpointing=500ms`).
- Translation provider: OpenAI (tie-breaker over Anthropic per ticket 05:
  already a required dependency for Realtime mode).
