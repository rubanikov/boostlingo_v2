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

## A build-environment constraint that shaped the build (later lifted)

**During implementation (tickets 1–9), no live provider API keys (`OPENAI_API_KEY`,
`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`) existed in the build environment.** Every
provider boundary (`backend/app/providers/*.py`) was built and tested against
mocked/faked SDK clients and fake WebSocket sockets, never a real network call. This was
a deliberate, consistent constraint, not an oversight per ticket: `backend/tests/` skips
(rather than fails) every test that needs a real key, with a message naming exactly
which one.

**That constraint was lifted after the build was complete.** Real keys were added and
the app was exercised live: the live testing surfaced and fixed two real bugs (Deepgram
finalization and a long-utterance timeout, commit `7b355fc`), a real-speech testing
harness was added (`da54a71`, `eafeef7`), and [COMPARISON.md](COMPARISON.md)'s latency
and quality numbers were replaced with measured results from those live runs (`5aa54a4`).
COMPARISON.md states exactly how each number was obtained and how to reproduce it. The
key-gated tests still self-skip without keys, so the suites pass in either environment.

## Phase 3: Audio Tuning & Denoise Lab (feature-factory)

The tuning panel was built with a different harness again: the `feature-factory` skill,
which takes one feature from idea to merge-ready through fixed steps with human approval
gates. The feature was cut into **18 vertical tickets** (each one a knob or a group of
knobs wired end to end, never a "backend layer" ticket) and run in **6 waves** with a
concurrency cap of 5 agents, the cap being a human decision at the planning gate. Most
tickets were built as a backend-builder and a frontend-builder in parallel against the
same brief, then a reconcile pass checked the two halves against the wire contract the
ticket specified — the same contract-not-codebase discipline Phase 2 used, only with the
reconcile written down as its own step. `.scratch/tuning-lab/06-build-log.md` is the
running record: one entry per ticket half and per reconcile.

### Deviations adopted during the build

A brief is a plan, not a promise. These are the places the build contradicted its own
brief, each adopted deliberately and recorded at the reconcile that found it:

- `postFilterBeta`'s step is **0.01**, not the brief's 0.05 — its default 0.02 is off a
  0.05 grid, so the panel would have quantised the default away.
- Only **two `connect()` call sites** (mic button, Try again); switching mode tears down
  and does not auto-reconnect, because an existing test forbids exactly that.
- `tuning_applied{reconnectedStt: true}` **waits for the first result** off the new
  Deepgram connection, so it can lag until someone speaks. The client therefore never
  times out a reconnect apply (it does keep a 20 s timeout for live ones).
- The server **echoes the latest rider's `requestId`** when several applies pile up
  behind a parked reconnect, so the client settles every pending apply on any of them.
- `rnnoise.voiceProbThreshold` is **inert**: the package we use exposes no VAD threshold.
  The knob stays visible-but-disabled and still hashes into the fingerprint.
- The client DSP `AudioContext` is **always 48 kHz** (RNNoise's only rate); Cascade
  decimates to 16 kHz in its own worklet instead.
- Provider parameters travel **per call** — `model=`, `params=`, `voice=` — never as
  module state, so one tab's Apply cannot re-parameterise another tab's session.
- A Cascade session opens with **two** unsolicited messages, `session_started` then
  `tuning_applied{requestId: null}`; every test helper drains both.
- The `bench` and `denoise` extras are **never synced into `.venv`** (torch is a ~200 MB
  CPU wheel even with the CUDA runtime pinned out, and DeepFilterNet holds `numpy` below
  2). They run through `uv run --with …` or an isolated venv.
- `ruff check` is the only static gate. The repo has no ruff config and
  `ruff format --check` fails on pre-existing files, so `ruff format --line-length 100`
  was run on new files only, matching the house ~100-column style.

### Test and verify rounds

Step 11 put a read-only test-verifier over the finished 18: it traced all 42 acceptance
criteria and wrote acceptance suites for both halves (`backend/tests/
test_acceptance_tuning_lab.py`, `frontend/src/pages/tuningLab.acceptance.test.tsx`), and
one of its new tests failed on a real defect — the sweep runner was still passing the
ticket-09 placeholder instead of `DeepgramParams.from_tuning`, so fingerprinted rows
weren't actually applying the Deepgram knobs they were labelled with. Step 12 ran an
implementation-validator and a security-auditor in parallel. Neither found a Critical
security issue; the validator found one (COMPARISON.md section 7 had no measured rows).

### Known gaps left open

- **AC 3.7 is partly unmeasurable by design.** The Cascade sweep replays audio
  server-side, so the client-side stages (mic constraints, RMS gate, RNNoise) can't
  produce WER rows there, and the Realtime capture measures judge acceptance and
  end-to-end latency rather than WER. COMPARISON.md section 7 now carries the rows that
  *are* measurable and says plainly which stages have no row and why.
- **Security Important I1–I3** are documented, not fixed: no per-session cap on
  reconnect-triggering `update_tuning` messages, an unbounded audio queue with a
  synchronous denoise `process()` on the event loop, and an unauthenticated
  `POST /api/tuning/transcript-check` that is an unmetered LLM proxy to any local process.

## Commit history

Phases 1 and 2 have a real, iterative commit history. The wayfinder phase (Phase 1) shows
one commit per ticket claimed and one per ticket resolved. The implementation phase was
committed in the same convention — one commit per implementation ticket (1–9), followed
by separate commits for the validation/fix round, final polish, and the post-build live
testing round described above. (An earlier draft of this file flagged the implementation
work as still untracked at write-up time; that gap was closed by exactly the per-ticket
commit sequence recommended then.)

Phase 3 is the exception, and worth stating plainly rather than implying otherwise: at the
time this section was written the tuning lab was still one uncommitted working tree, so
`git log` shows none of its 18 tickets. `.scratch/tuning-lab/06-build-log.md` is the
per-ticket record standing in for that history until the work is committed.
