Type: prototype
Status: resolved
Blocked by: 04, 05, 12

## Question

Sketch the actual STT/Translation/TTS provider interfaces (Python protocols/ABCs) so
swapping a provider is a contained change, per the brief's code-quality bar.

Should reflect the real shapes learned from the Deepgram/ElevenLabs/translation research
([Cascade provider streaming APIs research](04-cascade-provider-research.md)) and fit the
pipeline architecture
([Cascade pipeline architecture](05-cascade-pipeline-architecture.md)) — e.g.
async-generator-based streaming interfaces, structured error types for
rate-limit/timeout/empty-result. Produce a rough stub/prototype of the interfaces plus one
concrete provider implementation to react to.

[Prior-art research](12-prior-art-reference-implementations.md) found the same swap-point
shape independently in Pipecat, LiveKit, and Vocode — "one streaming method, in: raw
input, out: an async stream of typed events" — which validates this direction. It also
found LiveKit deliberately does **not** unify its cascade provider interfaces with its
realtime speech-to-speech interface (separate object families, sharing only
transport/orchestration) — this cascade-mode interface does not need to (and per that
finding, probably should not try to) also cover the Realtime API. LiveKit's
`STTCapabilities`-style capability-declaration dataclass (a provider self-declares what
it supports) is worth considering if providers turn out to differ on feature support.

## Answer

Resolved via a live prototype-review session as a Lavish artifact:
[.lavish/ticket-06-provider-abstraction-design.html](../../../.lavish/ticket-06-provider-abstraction-design.html).
Confirmed: "agree, the shape works."

**Two files sketched**: `providers/base.py` (the three `Protocol` interfaces —
`STTProvider`, `TranslationProvider`, `TTSProvider` — plus event types and structured
`ProviderError`) and `providers/deepgram_stt.py` (one concrete implementation showing
how Deepgram's SDK maps onto the protocol). Key design choices: `Protocol` not `ABC`
(structural typing — test doubles for ticket 10's provider-boundary tests don't need
inheritance); `is_final` and `speech_final` both preserved on `TranscriptSegment` rather
than collapsed (the orchestrator's LLM clause-check needs `is_final`, the fallback
boundary needs `speech_final`); `TTSFlush` as an explicit event in the TTS input stream
mapping directly to ElevenLabs' `flush: true`; an empty final STT result treated as a
valid outcome, not a `ProviderError`; translation doesn't decide segmentation, it only
translates one already-segmented unit.

**Self-reviewed gap, not fixed (deliberately out of prototype scope)**: the sketched
`DeepgramSTTProvider.stream()` doesn't actually run as written — `_pump_audio()` is
defined but never scheduled, and there's no queue/yield bridge from the SDK's
callback-based `"Results"` event to a real async generator. The concrete shape needed:
an `asyncio.Queue`, the callback does `queue.put_nowait(segment)`, `_pump_audio()` runs
as a concurrent `asyncio.create_task`, and the generator does
`while True: yield await queue.get()`. Real implementation work, correctly deferred
per the map's Notes (implementation happens afterward as a normal build).

**Significant scope addition from grilling feedback — diarization + per-segment
language detection.** The brief's stability benchmark ("5-minute back-and-forth
conversation") implies two people alternating in two languages — the original design
implicitly assumed one fixed session-wide translation direction, which doesn't actually
support that without a manual per-turn toggle. Resolved as:
- `TranscriptSegment` gains `speaker: int | None` (from Deepgram's `diarize=true`) —
  used only for transcript labeling and consistent per-speaker TTS voice assignment,
  **not** for deciding translation direction.
- Translation direction comes from **per-segment language detection** instead
  (`detect_language=True`): since the pair is always exactly 2 languages, detect which
  one a segment is in, translate to the other. No speaker-identity calibration needed.
- `STTProvider.stream()`'s signature changed from a single `language: str` to
  `languages: tuple[str, ...]` (the candidate set) to reflect this.
- **Scope call: Cascade mode only, not Realtime mode.** `gpt-realtime` has no
  equivalent multi-party/diarization lever; forcing symmetry would mean guessing at
  unresearched Realtime API behavior. This becomes a deliberate, named difference
  between the two modes for the comparison write-up (cascade's "more control" made
  concrete).
- Two more honest caveats flagged inline in the code: whether Deepgram's
  `detect_language` can be constrained to a specific 2-language candidate set (vs. its
  full supported-language list) is unverified — worth a quick primary-source check
  before implementing; and a segment spanning a mid-utterance speaker change is an
  unresolved edge case.

**Downstream amendments made as a result** (see those tickets' own Answer sections for
the actual updates): [Cascade pipeline architecture](05-cascade-pipeline-architecture.md)'s
WebSocket protocol needs a `speaker` field threaded alongside `segmentId` in every
message. [UI/UX layout](09-ui-ux-layout.md) (not yet started) needs to design
per-speaker transcript display and per-speaker TTS voice assignment.
