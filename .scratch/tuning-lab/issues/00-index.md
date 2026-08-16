# Audio Tuning & Denoise Lab — Implementation Tickets

Status: **approved 2026-08-15** via feature-factory Step 9 gate (Lavish review:
`.lavish/step9-tickets-tuning-lab.html`); approved as drafted, granularity 18
kept, concurrency cap 5. Sliced from the approved chain: `00-idea-brief.md`
(locked decisions, priority tiers 1–6) → `02-story.md` (5 sub-stories, 42 ACs,
Step 3 gate) → `03-wireframe-notes.md` (Step 5 gate) → `04-brief.md` (the
contract: `TuningConfig` schema, fingerprint algorithm, API changes, reconnect
flow, frontend design, benchmark flow, tests S1–S31 / F1–F17 / E1–E16, "Files
that will change", Step 7 gate). Format mirrors the previous run's
`.scratch/ai-interpreter-workbench/tickets/`.

**18 vertical tickets, ≈56.5 hrs.** Every ticket cuts UI → transport → backend
(or harness → JSON → printed table). Three tickets are deliberately
single-sided; each says why.

## The cut protocol (read this before cutting anything)

Tiers are cut from the bottom (locked decision 7). A cut must not leave a dead
control in the panel, because locked decision 11 makes the panel the single
inventory of processing steps. So:

> **Cutting a ticket flips the knob rows it owns to the panel's `disabled` +
> visible-reason treatment — the same treatment ticket 02 already ships for
> Demucs / DNS64 ("benchmark only") and for the not-installed server denoise
> stages.** No knob is ever rendered live with nothing behind it, and no seam
> is left half-built.

That treatment is built once, in ticket 02, precisely so every later tier can
be dropped cheaply.

## Waves (parallel frontier)

```
Wave 0 (start now, parallel):   [01] Fingerprint spine + capabilities      [08] Noisy corpus
                                     + fingerprint chip                          generator
                                          |                        \                 |
Wave 1:                              [02] Tuning panel shell         `------.        |
                                          |                                  \       |
                                          |                              [09] Cascade sweep runner
                                     _____|_____________                       + COMPARISON §7
                                    /      |            \
Wave 2 (parallel):        [03] Persist  [04] Realtime   [06] Cascade start-of-session
                          presets I/O        start          + non-connection-level apply
                                 |    \      |    \             |          \        \
                                 |     \     |     \            |           \        \
Wave 3 (wide, parallel):   [10] Capture  [05] Realtime    [07] Cascade   [11] Mic   [14] Cascade
                             --tuning      live apply      reconnect     constraints  transcript
                                                           + dialog          |          check
                                                                             |            |
                                          [16] Server denoise chain          |            |
                                          [18] Model/voice pickers           |            |
                                                     |                       |            |
Wave 4:                          [17] DeepFilterNet  |          [12] RMS gate + Realtime   |
                                          + torch extra              client-DSP plumbing   |
                                                                             |     [15] Realtime
Wave 5:                                                              [13] RNNoise      flag endpoint
```

Critical path: **01 → 02 → 06 → 07** (tier 1 complete) and **01 → 02 → 04 →
12 → 13** (tier 3 complete). Tier 2 (08 → 09, and 10) runs almost entirely off
the critical path — 08 has **no dependencies at all** and can start on day one
alongside 01. Concurrency cap: **5** parallel builders at any wave.

## Tickets

| # | Title | Tier | Depends on | Size | Status |
|---|-------|------|-----------|------|--------|
| [01](01-fingerprint-spine-capabilities.md) | Fingerprint spine, `/api/tuning/capabilities`, fingerprint chip | 1 | none | ~3.5 hrs | ready |
| [02](02-tuning-panel-shell.md) | Tuning panel shell: sections, knob primitives, Apply/Revert, disabled inventory rows | 1 | 01 | ~3.5 hrs | ready |
| [03](03-persistence-presets-import-export.md) | Persistence, presets, export/import, reset | 1 | 02 | ~3 hrs | ready |
| [04](04-realtime-start-tuning.md) | Realtime start-of-session tuning (+ OpenAI `noise_reduction`) | 1 | 01, 02 | ~4 hrs | ready |
| [05](05-realtime-live-apply.md) | Realtime live apply (`session.update`, deferral, coalescing) | 1 | 04 | ~2.5 hrs | ready |
| [06](06-cascade-start-tuning-live-apply.md) | Cascade start-of-session tuning + non-connection-level live apply | 1 | 01, 02 | ~4.5 hrs | ready |
| [07](07-cascade-reconnect-failure-dialog.md) | Cascade connection-level apply: deliberate Deepgram reconnect + failure dialog | 1 | 06 | ~4.5 hrs | ready |
| [08](08-noisy-corpus.md) | Noisy corpus generator + manifest | 2 | none | ~2.5 hrs | ready |
| [09](09-cascade-sweep-runner.md) | Cascade tuning sweep runner + paste-ready table + COMPARISON §7 | 2 | 01, 08 | ~3.5 hrs | ready |
| [10](10-capture-harness-tuning.md) | Realtime capture harness `--tuning` + fingerprint through the report | 2 | 01, 02, 03, 04 | ~2 hrs | ready |
| [11](11-mic-constraints.md) | Microphone constraint toggles, both modes | 3 | 04, 06 | ~1.5 hrs | ready |
| [12](12-rms-gate-realtime-dsp.md) | RMS noise gate + Realtime client-DSP re-plumbing | 3 | 05, 06, 11 | ~4 hrs | ready |
| [13](13-rnnoise.md) | RNNoise (48 kHz contexts, 3:1 decimator) | 3 | 12 | ~3.5 hrs | ready |
| [14](14-cascade-transcript-check.md) | Cascade transcript check: off / flag / correct | 4 | 06 | ~3.5 hrs | ready |
| [15](15-realtime-transcript-check.md) | Realtime transcript check `flag` via `POST /api/tuning/transcript-check` | 4 | 04, 05, 14 | ~2 hrs | ready |
| [16](16-server-denoise-chain.md) | Server denoise chain: protocol + noisereduce + capability gating | 5 | 02, 06 | ~3.5 hrs | ready |
| [17](17-deepfilternet-torch-extra.md) | DeepFilterNet stage + optional `denoise` torch extra | 5 | 16 | ~2.5 hrs | ready |
| [18](18-model-voice-pickers.md) | Model / voice pickers wired through both transports + allow-list validation | 6 | 02, 04, 06 | ~2.5 hrs | ready |

Every ticket is inside the 1.5–4.5 hr band. **No ticket is Too thin or Too
thick.** Two sit at the top of the band (06, 07) and are flagged individually
in their own files with the reason they are not split.

Status is `ready` for every ticket at publish time; the orchestrator flips
each to `in progress` / `done` as builders pick them up.

## Cut candidates (ordered by tier, cut from the bottom)

Each cut applies **the cut protocol at the top of this file**: the ticket's
knob rows flip to the panel's `disabled` + visible-reason treatment. No dead
controls, no half-built seams.

| Order | Cut | Tier | Saves | What is lost |
|---|---|---|---|---|
| 1 | **Ticket 18** | 6 | ~2.5 hrs | Model/voice pickers render but only Realtime model/voice apply; Cascade pickers go disabled. Model constants stay as they are today. |
| 2 | **Ticket 17** | 5 | ~2.5 hrs | No DeepFilterNet; `stages.deepfilternet.installed` stays `false` forever and the row stays in its `not installed` state. No torch anywhere. |
| 3 | **Ticket 16** | 5 | ~3.5 hrs | No server-side denoise at all; both server stage rows permanently disabled (the panel still lists them — locked decision 11). `audio_iter` untouched. |
| 4 | **Ticket 15** | 4 | ~2 hrs | Realtime transcript check disabled (`off` only); Cascade keeps all three modes. No new HTTP endpoint. |
| 5 | **Ticket 14** | 4 | ~3.5 hrs | No transcript check at all; the section goes disabled; no `transcript_check` latency stage; the `correctedWer` column stays empty. |
| 6 | **Ticket 13** | 3 | ~3.5 hrs | No RNNoise; no new npm runtime dependency; both audio contexts stay at today's rates and `cascade-pcm-processor.js` is untouched. |
| 7 | **Ticket 12** | 3 | ~4 hrs | No RMS gate and **no Realtime client-DSP re-plumbing** — the highest-risk frontend change in the run disappears. Cutting 12 forces cutting 13. |
| 8 | **Ticket 11** | 3 | ~1.5 hrs | Mic constraints stay hardcoded `true`; the Microphone section goes disabled with a reason. |

**Not cuttable without losing the feature's point:** tiers 1 and 2 (tickets
01–10). Tier 2 is where every claim becomes a number; cutting it leaves a
panel full of knobs and no evidence, which is the one outcome the idea brief
explicitly rules out.

If the whole slice must shrink hard, the honest minimum is **01–07 + 08–09**
(tier 1 + the Cascade benchmark half, ~29 hrs): a complete tuning panel, both
transports, live apply with a safe reconnect, and per-fingerprint WER numbers
on a noisy corpus.

Not selected at approval time — full scope proceeds as drafted, granularity
kept at 18 tickets.

## Assumptions made during slicing

1. **AC 1.1 ("panel is the single inventory") is completed collectively**, not
   by one ticket. Ticket 02 ships the six sections, the row primitives and the
   permanently-disabled inventory rows; each later ticket adds the rows it
   makes real. This is what keeps every ticket vertical instead of producing
   one enormous "build the panel" layer ticket, and it is what makes the cut
   protocol cheap. **If you would rather see every row rendered on day one
   (even inert), say so — it moves ~2 hrs of work from tickets 04/06/11–18
   into ticket 02 and makes 02 Too thick (~5.5 hrs), so it would need
   re-splitting.**
2. **Three tickets are single-sided** (03 persistence, 05 Realtime live apply,
   08 noisy corpus) and each states its justification inline: the story part
   genuinely has no other side (no server-side storage by decision 10; no
   backend seam in a Realtime session; the corpus generator is a script).
3. **Ticket 04 carries a tier-3 knob** (`noise_reduction`), stated explicitly
   in the ticket, because it is one more key in the same payload, mapping
   function and test file.
4. Sizes assume the builder has the brief open and is not re-deriving
   decisions — the brief is unusually complete (exact fingerprint algorithm,
   exact wire shapes, exact test list).
5. The uncommitted `_turn_detection()` / `realtime_vad_*` work is **absorbed**
   in ticket 01, not reverted or rebased away (story assumption 5).

## Builder decisions (adopted at Step 9)

1. **Babble / street / fan noise sources.** The brief says babble is "several
   overlaid TTS speakers" but does not say whether `make_noisy_corpus.py`
   calls `generate_audio_fixtures.py` (needs an ElevenLabs key, so the
   generator becomes key-gated) or synthesises the noise procedurally
   (filtered/shaped noise, no key, fully reproducible from `seed`).
   **Procedural for street/fan/white, reuse of existing generated TTS clips
   for babble with a self-skip when they are absent** — it keeps ticket 08
   key-free and deterministic. Ticket 08 must state which it chose in
   `SCRIPT.md`.
2. **Does the Cascade sweep run the LLM judge?** `tuning_sweep.json`'s row
   shape has no judge column, but COMPARISON §7's table has `judge
   acceptance`. Either the Cascade half fills it (extra cost and an extra key
   dependency) or §7's judge column is Realtime-only and the Cascade rows
   leave it blank. **Realtime-only, blank for Cascade rows, stated in the §7
   provenance line.**
3. **`TuningSection.tsx` split** — the brief says "only if `TuningPanel.tsx`
   exceeds ~400 lines". Builder's call at the time; both are pre-approved.
4. **Chain-rebuild trigger.** "Rebuilt whenever `tuning_state.current` changes
   identity" does not specify the mechanism (identity check per frame vs.
   explicit rebuild at the assignment site). **Rebuild at the assignment site
   in `_handle_update_tuning`** — no per-frame cost.
5. **`flag` mode's re-sent `source_transcript`.** The brief says re-send the
   segment with `flagged: true`; it does not say how the client reconciles
   two messages for the same `segmentId`. **Merge by `segmentId` in the
   existing transcript state** — the pane already keys on it; confirm no
   duplicate segment is appended.
6. **`ELEVENLABS_VOICE_IDS_EXTRA` parsing.** pydantic-settings parses
   `list[str]` from env as JSON by default, which surprises people who write
   a comma-separated list. Ticket 01 must pick one and document it in
   `.env.example`.
7. **`appliedTuning` serialisation.** Preserving the absent-key idiom can be
   `model_dump(exclude_none=True, by_alias=True)` or a hand-rolled emitter;
   only the *result* is contractual (`fingerprint(appliedTuning) ==
   fingerprint(request.tuning)`).
8. **Panel open/closed state across reloads.** Not specified anywhere. **Do
   not persist it** — the panel opens closed; one less thing in localStorage.
9. **Number formatting parity** (`Py repr(round(x, 2))` vs `TS String(x)`) is
   the single most likely place for a silent fingerprint mismatch.
   `shared/tuning-fingerprint-cases.json` must include at least one case per
   float knob at a non-integral step value, or S1 will pass while the real
   system disagrees.
