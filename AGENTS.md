# Agent Usage

This project was built almost entirely by directing Claude Code (an agentic coding
assistant) rather than hand-writing code, in two distinct phases.

## Phase 1: Wayfinder (decide before building)

Before any application code was written, every architecture and provider decision was
worked through as a structured "wayfinder" process: a map (`.scratch/ai-interpreter-
workbench/map.md`) named 14 open questions, each charted as its own ticket in
`.scratch/ai-interpreter-workbench/issues/`, and resolved one at a time via research
subagents (for factual questions: provider API capabilities, prior-art survey) or live
"grilling" sessions (for judgment calls: transport choice, segmentation design, latency
instrumentation shape), each recorded as a Lavish HTML review artifact under `.lavish/`
before being written up as the ticket's answer. This phase has its own real, iterative git
history: one commit to claim a ticket, one to resolve it, and `git log` shows all 14 pairs.

Notable resolutions from this phase (see the linked tickets for full reasoning):
[03](.scratch/ai-interpreter-workbench/issues/03-realtime-transport-architecture.md)
(WebRTC direct + `gpt-realtime` as literally specified, `gpt-realtime-translate`
deferred to the write-up), 
[06](.scratch/ai-interpreter-workbench/issues/06-provider-abstraction-design.md)
(diarization added as a Cascade-only capability once a "two-party conversation" test
implied it was needed), and
[08](.scratch/ai-interpreter-workbench/issues/08-latency-instrumentation-design.md)
(the asymmetric-by-mode latency design that COMPARISON.md's §1/§4 build on directly).

## Phase 2: Implementation (ticket-by-ticket, parallel subagents)

Once the map was complete, 9 implementation tickets
(`.scratch/ai-interpreter-workbench/tickets/`) were built in order. Most tickets that
touched both sides of the stack were split into a backend-builder subagent and a
frontend-builder subagent run in parallel against the same ticket's brief, then
reconciled against the shared WebSocket/REST contract the ticket specified (message
shapes, field names, session lifecycle) once both reported back. The contract, not a
shared codebase, is what kept the two halves consistent. Tickets 1-8 built the working
app; this ticket (9) is the documentation capstone.

## Corrections made along the way (worth being transparent about)

Two real corrections surfaced during implementation, both left as comments in the code
they touched rather than hidden:

- **Deepgram's `detect_language` doesn't support streaming.** Ticket 6's provider-
  abstraction design assumed `detect_language=True` would work on Deepgram's live
  streaming connection the same way it does on pre-recorded audio. It doesn't. That flag
  is pre-recorded-audio-only. The verified fix, `language=multi` (Nova-3's streaming
  equivalent, which reports a per-word `language` field instead), is documented directly
  in `backend/app/providers/deepgram_stt.py`'s `_url()` method.
- **The Realtime target-language transcript event name.** Ticket 3
  ([03-unified-workbench-shell.md](.scratch/ai-interpreter-workbench/tickets/03-unified-workbench-shell.md))
  flagged its own guess at this event name as an assumption needing verification before
  building. The guess (`response.audio_transcript.delta`) was wrong; the verified name,
  used in `frontend/src/pages/useRealtimeSession.ts`, is
  `response.output_audio_transcript.delta`, confirmed against OpenAI's current docs
  during the build rather than left as a silent guess.
- **OpenAI's Realtime session payload shape changed (beta → GA).** An earlier draft used
  the flat `voice`/`input_audio_format`/`turn_detection` session shape from OpenAI's
  beta-era docs. That shape predates the current `/v1/realtime/client_secrets` schema,
  which nests audio config under `session.audio.{input,output}` and expiration under
  `expires_after.seconds`. The corrected nested shape (verified against the pinned
  `openai` SDK's generated GA types) is what actually ships in
  `backend/app/api/realtime.py`; the comment there records both what changed and how it
  was verified.

## Validation pass and fix round

After all 9 tickets were built, three more read-only agents checked the result before
any polish: a test-verifier traced the brief's 8 functional requirements to real code and
found every one met (or met-but-unverifiable without live keys, never fabricated), an
implementation-validator looked for gaps/pattern drift/duplicated logic, and a
security-auditor reviewed the OWASP-relevant surface. Neither found a Critical issue, but
both surfaced legitimate, cheap-to-fix Important ones, closed in one fix round rather than
left as known gaps: the WebSocket endpoint (`/ws/cascade`) had no `Origin` check, so any
webpage open in the same browser could silently open a session against a developer's real
API keys (fixed in `backend/app/orchestrator.py`); the Cascade `languages` field wasn't
validated the way the Realtime endpoint's equivalent already was, letting an arbitrary
string reach LLM prompts (fixed by extracting the shared allow-list into
`backend/app/languages.py`); and malformed WebSocket frames from Deepgram or ElevenLabs
could silently hang a session instead of surfacing an error (fixed by catching
`json.JSONDecodeError` alongside the other transport failures already handled). All four
fixes shipped with regression tests confirmed red before the fix and green after.

A final polish pass followed: a deslop/code-humanizer cleanup, a prose humanize pass over
comments and docs (this file included), and the removal of two leftover placeholder pages
(`frontend/src/pages/CascadePage.tsx`/`RealtimePage.tsx`) that Ticket 3's real UI had fully
superseded but nobody had deleted.

## A build-environment constraint that shaped everything

**No live provider API keys (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`)
have existed at any point in this build environment**: not during implementation, not
while writing this comparison. Every provider boundary (`backend/app/providers/*.py`) was
built and tested against mocked/faked SDK clients and fake WebSocket sockets, never a real
network call. This is a deliberate, consistent constraint, not an oversight per ticket:
`backend/tests/` skips (rather than fails) every test that needs a real key, with a
message naming exactly which one; [COMPARISON.md](COMPARISON.md) is explicit about which
of its numbers are real (cost, computed from current public pricing) versus placeholders
a human with real keys needs to fill in (latency, quality; exact commands given inline).

## A known gap in the current submission state

The wayfinder phase (Phase 1 above) has a real, iterative commit history: `git log`
shows one commit per ticket claimed and one per ticket resolved, 31 commits total. **The
implementation phase's actual code does not yet share that history**: as of this write-up,
everything under `backend/` and `frontend/` (all 8 implementation tickets' worth of work)
is present in the working tree but untracked by git (`git status` shows both
directories as untracked, not modified). The brief explicitly calls out "commits scoped
to logical units of work... no single 'initial commit' dumps" as a code-quality
expectation, so committing this now as one bulk dump would not satisfy that expectation
either. This is flagged here rather than silently fixed by this documentation-only ticket
(which was explicitly asked not to touch application code or run `git commit`). Whoever
finalizes this submission should commit `backend/` and `frontend/` in a small number of
logical increments (e.g., one per implementation ticket, matching the wayfinder phase's
own convention) rather than as a single commit.
