Type: task
Status: blocked
Depends on: [02](02-cascade-mvp.md), [03](03-unified-workbench-shell.md)

# Ticket 4 — Cascade: diarization + per-speaker voice

Size check: right-sized (~1.5-2 hrs). Considered merging with
[Ticket 5](05-llm-hybrid-segmentation.md) (both touch the
segmentation/speaker subsystem) — kept separate: distinct demo scenario
(two-party correctness vs. mid-utterance segmentation quality) and distinct
test surface (direction-resolution correctness vs. Ticket 5's race-condition
logic).

Cut candidate #2 if time runs short — see [index](00-index.md).

## What to build

**Backend**
- `diarize=true` + `detect_language=True` on `DeepgramSTTProvider`.
- Per-segment translation-direction resolution (of the 2 configured
  languages, detect which one the segment is in, translate to the other — no
  manual toggle).
- Consistent `speaker → ElevenLabs voice_id` mapping across the session.
- `speaker` threaded through `source_transcript`/`target_transcript`/
  `tts_audio_meta` messages.

**Frontend**
- Per-speaker color-coded badges (blue/orange per ticket 09) in both
  transcript panes, matching each speaker's distinct TTS voice.

## Acceptance criteria

- Two people alternating speech in different languages (e.g., one in
  English, one in Spanish) each get correctly labeled with a consistent
  speaker badge and correctly translated in the right direction, without any
  manual per-turn toggle.
- Each of the two speakers is audibly spoken back in a distinct TTS voice,
  consistent across the whole session.
- This capability exists in Cascade mode only — Realtime mode has no
  equivalent (a deliberately named difference for the write-up, per
  [ticket 06](../issues/06-provider-abstraction-design.md)).

## API / contract notes

- `TranscriptSegment.speaker: int | None` — labeling + voice assignment only,
  never translation direction.
- Two known caveats to verify while building (flagged, not resolved, in
  ticket 06): whether Deepgram's `detect_language` can be constrained to the
  2-language candidate set vs. its full supported list; a segment spanning a
  mid-utterance speaker change is an unresolved edge case.
