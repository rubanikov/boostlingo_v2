# Audio Tuning & Denoise Lab — wireframe notes

(ux-wireframer output, feature-factory Step 5, 2026-08-15. Companion to the visual mock:
`.lavish/step5-wireframe-tuning-lab.html`.)

Inputs: `00-idea-brief.md` (locked decisions, esp. #11), `02-story.md` (approved, incl. the Step 3 gate
outcome), `01-research.md` §A5–A7 and §F. The mock reproduces the real `WorkbenchPage.tsx` markup —
navbar, `tabs tabs-box tabs-sm`, `select select-sm w-40`, connection badge with dot,
`CascadeLatencyStrip`, dual `card card-border bg-base-100 h-[420px]` transcript cards, mic level bar,
`btn btn-circle btn-lg`, `toast toast-top toast-end` — and adds the panel to it.

---

## 1. Placement

**Chosen: a right-hand collapsible side panel**, a fixed 400 px column inside the existing
`mx-auto max-w-6xl` shell, toggled by a **Tuning** button in `navbar-end` (placed *before* the
connection badge so the badge stays the right-most, highest-salience element). While open, the
transcript grid drops from `sm:grid-cols-2` to a single column and the two panes stack.

Rationale — this is a lab, and the loop is *turn a knob → Apply → watch the very next segment*. A panel
that hides the transcripts breaks that loop. Two other things fall out of the side-panel choice for
free: the latency strip stays visible (so you can see the ms cost of the stage you just enabled), and
the panel can be `sticky top-4` and scroll independently of a long transcript.

Rejected:

- **Collapsible section under the controls.** Six accordion sections at full width push the transcript
  cards below the fold; you'd scroll away from the thing you're measuring on every change. Cheapest to
  build, and that is its only advantage.
- **Modal.** Hides transcripts *and* latency completely. Also: the app should keep exactly one modal
  treatment, and it's already spoken for by the apply-failure dialog (§6). Two modals with different
  urgency reads badly.

The main column is `flex-1 min-w-0` (the `min-w-0` matters — without it the latency strip's
`overflow-x-auto` won't shrink).

---

## 2. Component tree

Everything flat in `frontend/src/pages/`, matching the existing convention (§F: no `components/`
directory today; pure logic extracted from hooks with co-located `*.test.ts`).

```
frontend/src/pages/
  WorkbenchPage.tsx          (modified) renders <TuningPanel>, the navbar toggle,
                             the fingerprint chip in the latency strip, and the
                             suspicious badge in TranscriptPaneBody
  TuningPanel.tsx            (new) the <aside>: header, section stack, footer,
                             apply-failure <dialog>. Presentational + local UI
                             state (which sections are open) only.
  TuningSection.tsx          (new, optional) the <details class="collapse"> wrapper +
                             the knob-row primitives (KnobRow, RangeKnob, NumberKnob,
                             SegmentedKnob, ProviderDefaultKnob). Split out only if
                             TuningPanel.tsx exceeds ~400 lines; otherwise inline.
  tuningConfig.ts            (new, PURE) TuningConfig type, DEFAULT_TUNING_CONFIG,
                             KNOB_METADATA (which knobs belong to which mode/section,
                             which are Deepgram-connection-level), canonicalise(),
                             fingerprint(), diff(), parseImported(), the mode-scoping
                             helpers. Has tuningConfig.test.ts.
  tuningPresets.ts           (new, PURE) BUILT_IN_PRESETS, localStorage read/write for
                             user presets and for the persisted draft, schema-version
                             handling. Has tuningPresets.test.ts.
  useTuningConfig.ts         (new) the React hook: draft/applied state, pending diff,
                             persistence effect, apply orchestration (calls
                             session.applyTuning), retry counting, dialog state.
                             Has useTuningConfig.test.ts.
```

Wiring into the transports (spec-writer's call, but the shape the wireframe assumes):

- `SessionHandle` gains an **optional** `applyTuning(config): Promise<ApplyResult>` — matching the
  documented optional-member extension pattern in `sessionHandle.ts:73-132` (already used 5×), not a
  second argument to `connect`.
- `connect(languages)` gains a second argument `connect(languages, config)` **or** the hooks read the
  applied config from a ref the panel writes. Prefer the explicit second argument — `connect` is called
  from three places in `WorkbenchPage.tsx` (mic button, Try again, error retry) and all three already
  pass `selectedPair.languages`.
- The fingerprint reaches the latency strip as a plain prop from `WorkbenchPage`, not through the
  session handle. It is UI metadata about the applied config, not a per-segment measurement, so it does
  not belong on `CascadeSegmentLatency`.

---

## 3. State model

Four pieces of state, all owned by `useTuningConfig`:

| Name | Type | Meaning |
|---|---|---|
| `draft` | `TuningConfig` | what the panel's controls show; every edit writes here |
| `applied` | `TuningConfig` | what the running session (or the next `connect`) actually uses |
| `pending` | `KnobDiff[]` | `diff(applied, draft)` — derived, never stored |
| `applyState` | `'idle' \| 'applying' \| 'failed'` + `attempt: number` | drives the button spinner, the reconnecting copy and the dialog |

Rules:

1. **Per-knob "Provider default" = `undefined`.** Every optional knob is `T | undefined` in
   `TuningConfig`. `undefined` means *the key is omitted from the outbound payload entirely* — matching
   the existing `_turn_detection()` idiom (`realtime.py:88-98`), which only adds a key when the setting
   is set. The UI expresses this as a "Provider default" checkbox beside the input; checked → input
   `disabled` + `opacity-40` and value renders as `—`. Unchecking it seeds the input with the provider's
   documented default so the user isn't typing into a blank.
   *Distinguish from a value that happens to equal the default:* OpenAI noise reduction `off` is an
   explicit value that gets sent; omitting the row entirely is different. The mock spells this out in
   the Realtime denoise section.
2. **`draft` is mode-scoped.** `TuningConfig` has a shared block (`microphone`, `rmsGate`, `rnnoise`,
   `transcriptCheck.mode`) plus `cascade` and `realtime` blocks. The panel renders the shared block plus
   the active mode's block. Two independent drafts are not needed — one config object, mode-filtered
   rendering. Switching tabs does not copy values across (story AC 1.13).
3. **Fingerprint** = `fingerprint(canonicalise(config))`, computed from the *applied* config for display
   in the navbar chip and the latency strip, and from the *draft* nowhere — a fingerprint that changes
   as you type is noise. (Panel header shows the applied fingerprint; the "N pending" badge is what tells
   you the draft has diverged.) Canonicalisation sorts keys and drops `undefined` so field ordering can't
   change the hash (story AC 1.12). Shared with backend/harness per decision 9.
4. **Persistence.** `draft` and `applied` both persist to localStorage under one versioned key
   (`boostlingo.tuning.v1`), plus a separate key for user presets. On load: parse, validate against the
   current schema, drop unknown keys with a console warning, fall back to server defaults for anything
   missing. Nothing server-side (decision 10).
5. **Server defaults are the initial `applied`.** On a fresh browser the panel must *display* the
   backend's `.env`-derived values, not blanks (story AC 1.11). That needs a capability/defaults endpoint
   (also the source of "is `backend[denoise]` installed?" — research §12 notes the frontend learns
   nothing about backend capabilities today). The panel renders a skeleton until it lands; if it fails,
   fall back to the client-side `DEFAULT_TUNING_CONFIG` and show the denoise rows as "not installed".

---

## 4. Interaction rules

### Apply semantics

Apply is an explicit action, never auto-apply on keystroke (story assumption 3). Four states:

| Situation | Label | Enabled | Status line |
|---|---|---|---|
| `draft === applied` | `Apply` | no | `Applied · cfg:7f3a9c21 · 12:04:31` |
| Connected, no connection-level knob changed | `Apply` | yes | `2 changes pending` |
| Connected, ≥1 Deepgram-connection-level knob changed | `Apply (reconnects STT)` | yes | `3 changes pending · 1 reopens the Deepgram connection` |
| Disconnected | `Apply at next connect` (`btn-outline`) | **yes** | `Not connected · 3 changes will be sent when you connect` |

**Decision: Apply stays enabled while disconnected** (rather than being disabled with a "Connect to
apply live" hint). Reason: pressing it does real work — it commits `draft → applied`, stamps a new
fingerprint, persists, and clears the pending badge, so the fingerprint you read off the screen is the
one the next `connect()` will actually use. A disabled button would leave the panel in a permanently
"3 pending" state through an entire disconnected configuration session, which is exactly when you do
most of your knob-setting.

Connection-level knobs (the set that flips the label and puts a `reconnects` chip on the row):
Deepgram `endpointing`, `utterance_end_ms`, `diarize`, Deepgram model. Everything else on the Cascade
side rides a new WS control message with no reconnect. On the Realtime side, `session.update` over the
`oai-events` data channel never tears down the session, so the Realtime Apply label never gains the
suffix; Realtime model/voice are session-creation-only and are marked "applies at next connect" in the
section body.

Microphone constraints (EC/NS/AGC) are `getUserMedia`-time and cannot change live in either mode — the
Microphone section carries an inline note saying so, and those knobs do **not** trigger a reconnect.

### Reconnect flow (Cascade, connection-level)

Per the Step 3 gate: **no confirmation dialog**. Pressing Apply immediately:

1. Button → `Applying…` with `loading loading-spinner loading-xs`, disabled.
2. Connection badge → the existing `reconnecting` amber badge (reuse `CONNECTION_BADGE.reconnecting`,
   `WorkbenchPage.tsx:36`). Reuse is deliberate: from the user's side this is the same experience as an
   unexpected WS drop — audio is still being captured, transcripts pause for a moment.
3. Status line: `Reconnecting STT with the new parameters… (attempt 2 of 3)` (`aria-live="polite"`).
4. **Every failed attempt is logged** — a backend log line and a browser console entry (gate addendum).
5. On success: badge → `Connected`, status → `Applied · cfg:… · HH:MM:SS`, pending markers clear.
6. On exhausting the existing retry/backoff budget (`_resilience.py`: 3 attempts, 0.5/1/2 s): the
   **failure dialog** (§6). The session keeps running on the previous config.

### Deferred apply

Apply pressed while Cascade TTS playback is active, or while a Realtime reply is streaming, is
**accepted and queued**, not blocked: status line reads `Applying after the current reply…` and the
actual `session.update`/reconnect fires at the next turn boundary. Same queue debounces rapid repeated
Applies (two connection-level changes 200 ms apart must not open two overlapping Deepgram connections)
— coalesce to the latest draft, one reconnect. See open question 2.

### Revert

`Revert` sets `draft = applied` and clears every pending marker. It is a `btn-ghost` beside Apply,
never the primary. In the failure dialog the same action is spelled **Revert to previous** because it
is doing something stronger: making the panel agree with a session that failed to move.

### Preset / export / import

- Selecting a built-in or saved preset replaces the whole `draft` in one action (story AC 1.9) and marks
  every differing row pending.
- Editing after selecting a preset shows `Preset modified` beside the select — the preset name is not
  cleared, since "Max denoise, but with the gate at −50" is the normal working state in a lab.
- `Save as…` is the last option in the select; it opens a small inline name input in the header (not a
  modal), saving to localStorage.
- `Export` downloads / copies the canonical `TuningConfig` JSON. `Import` accepts a file or paste.
  Malformed JSON → inline error in the header, draft untouched. Valid JSON with unknown keys → import
  the known keys and show a warning line naming the dropped ones (the alternative, wholesale rejection,
  makes every schema bump break every saved file). An imported model id outside the current curated
  allow-list falls back to the default for that picker with a warning — never silently keeps a value the
  backend will reject.
- `Reset to defaults` restores the *server* defaults (not the built-in preset), and is a `btn-ghost` so
  it is not adjacent in weight to Apply.

### Mode switch

Switching the Cascade/Realtime tab already tears the session down (`handleModeChange`,
`WorkbenchPage.tsx:268`). The panel stays open, re-renders with the new mode's sections, and the pending
badge counts only the current mode's diverged knobs. Nothing is discarded. See open question 1.

---

## 5. Panel structure

Header → six sections in **signal order** → footer.

**Header:** title + mode badge (`Tuning  [Cascade]`), applied fingerprint chip (`badge badge-ghost
badge-sm font-mono`), close button; then preset `select select-xs` (optgroups: Built-in / My presets /
`Save as…`) + `Export` + `Import`; then `Reset to defaults` and the `Preset modified` note.

**Sections** — each a `<details class="collapse collapse-arrow bg-base-200 rounded-box">` with
`<summary class="collapse-title">`. Native `<details>` rather than DaisyUI's checkbox-collapse: it is
keyboard-operable and screen-reader-announced with zero JS, and it keeps the open/closed state in the
DOM where a test can read it. Each summary carries a status chip (e.g. `2 on`, `flag`, `server_vad`) so
a collapsed section still tells you what it is set to, plus a `reconnects STT` chip where relevant.

Default open on desktop: Microphone, Denoise chain, and the active mode's turn-detection section. All
collapsed on mobile.

1. **Microphone** (`browser`) — EC / NS / AGC toggles, with the wire field name in muted mono on the
   right. Footnote: applied at `getUserMedia` time, takes effect on the next connect.
2. **Denoise chain** — one bordered row per stage: toggle + name + `runs in: browser|server|provider`
   chip + its parameters inline underneath, indented under the toggle. Order = signal order.
   - *RMS gate* (browser): threshold `range` (−80…0 dBFS, value in mono beside the label), hold ms,
     attack ms, release ms as `input input-xs`, attenuation `range` 0–60 dB with the scale labelled
     `0 dB (off) … 60 dB … mute` and a `Full mute` checkbox pinning the far end.
   - *RNNoise* (browser): toggle + voice-probability threshold `range` 0–1. Footnote about the internal
     48 kHz / 480-sample resample.
   - *OpenAI noise reduction* (provider, **Realtime only**): `join` segmented `off | near_field |
     far_field`. Rendered disabled with a `Realtime only` chip in Cascade.
   - *DeepFilterNet* (server, **Cascade only**): toggle + attenuation limit dB + post-filter strength.
     Ships a **"not installed"** variant: row at 60 % opacity, `badge badge-warning badge-soft badge-xs`
     reading `not installed`, params disabled, and a hint line with the exact fix
     (`uv sync --extra denoise` in `backend/`, then reconnect). A *different* hint for the "installed but
     weights failed to load" case (story edge case): `model weights unavailable — see server log`.
   - *noisereduce* (server, Cascade only): toggle + `prop_decrease` range + stationary/non-stationary
     `join`.
   - *Demucs* and *denoiser (DNS64)*: always disabled, `badge badge-neutral badge-xs` reading
     `benchmark only`, with one shared explanatory line. Present so the panel is the complete inventory
     (decision 11).
3. **Turn detection / Endpointing** — mode-dependent.
   - *Realtime*: `server_vad | semantic_vad` radios, then `threshold` (range), `prefix_padding_ms`,
     `silence_duration_ms`, `interrupt_response` (toggle), `eagerness` (select). Every one has a
     `Provider default` checkbox to its right; checked = greyed = unset. `eagerness` additionally greys
     out with a `semantic_vad only` note while `server_vad` is selected. Closing note explains that a
     greyed field omits the key rather than sending the default.
   - *Cascade* (titled **Endpointing**): `endpointing` ms, `utterance_end_ms`, `diarize` toggle. Section
     summary carries the `reconnects STT` chip.
4. **Segmentation** (Cascade only, section absent in Realtime) — `hybrid-race | llm-priority` `join`,
   plus a curated segmentation-model select.
5. **Transcript check** — `off | flag | correct` `join`. In Realtime, `correct` renders as a
   `join-item btn btn-xs btn-disabled` with `title="No seam in Realtime — the model produces the
   translation directly, so there is nothing to rewrite before translating."` plus a visible line below
   (a `title` alone is not accessible on a non-focusable element). Plus a check-model select.
6. **Models & voices** — curated `select`s only, never free text. Cascade: Deepgram model, translation
   model, TTS voice A, TTS voice B. Realtime: Realtime model, Realtime voice. Footnote naming the
   server-side allow-list.

**Footer** (`border-t`, `bg-base-200`, `sticky bottom-0` inside the scroll container): primary `Apply`
(label per §4) `flex-1`, secondary ghost `Revert`, then the status line as
`role="status" aria-live="polite"`.

**Pending-change treatment**, three layers (mock 4e):
- 1.5 px amber left rule on the row (`box-shadow: inset 3px 0 0 var(--color-warning)`) — scannable while
  scrolling six sections;
- an amber dot (`w-1.5 h-1.5 rounded-full bg-warning`) before the control — survives the rule being
  clipped inside a nested bordered card;
- a `was: <previous applied value>` badge — the actual answer to "what did I change?" without a diff
  view.
Connection-level rows also carry a `reconnects` ghost chip.

---

## 6. Failure dialog

`role="alertdialog" aria-modal="true"` in a DaisyUI `modal-box`, shown only after the retry budget is
exhausted. Contents: title, one sentence naming what failed and confirming the session is still on the
previous config (with its fingerprint), a small mono log of the failed attempts with timestamps and the
provider error, then `Revert to previous` (ghost) and `Retry` (primary). No dismiss-by-backdrop — the
user must choose, because the alternative is staring at latency numbers that belong to a config the
panel says isn't running any more.

---

## 7. Copy strings

| Key | String |
|---|---|
| navbar button | `Tuning` |
| pending badge | `{n} pending` |
| panel title | `Tuning` + mode badge `Cascade` / `Realtime` |
| preset groups | `Built-in` / `My presets` / `Save as…` |
| built-in presets | `Provider defaults`, `Tuned turn-taking`, `Max denoise` |
| preset dirty note | `Preset modified` |
| reset | `Reset to defaults` |
| apply (idle/live) | `Apply` |
| apply (connection-level) | `Apply (reconnects STT)` |
| apply (disconnected) | `Apply at next connect` |
| apply (in flight) | `Applying…` |
| revert | `Revert` |
| status — applied | `Applied · cfg:7f3a9c21 · 12:04:31` |
| status — pending | `{n} changes pending` / `{n} changes pending · 1 reopens the Deepgram connection` |
| status — disconnected | `Not connected · {n} changes will be sent when you connect` |
| status — reconnecting | `Reconnecting STT with the new parameters… (attempt {i} of {n})` |
| status — deferred | `Applying after the current reply…` |
| runs-in chips | `runs in: browser` / `runs in: server` / `runs in: provider` |
| offline tag | `benchmark only` |
| torch missing | `not installed` + `Install with `uv sync --extra denoise` in `backend/`, then reconnect.` |
| weights missing | `model weights unavailable` + `Installed, but the model failed to load — see the server log.` |
| mode-scoped row | `Realtime only` / `Cascade only` |
| unset explainer | `A greyed field is unset — the key is omitted from the payload entirely, so the provider's own default applies.` |
| mic footnote | `Applied at getUserMedia time — takes effect on the next connect.` |
| correct disabled | `correct is unavailable: no seam in Realtime.` |
| flag badge | `⚑ check`, `title="Transcript check flagged this segment as likely misrecognised"` |
| dialog title | `Couldn't apply the new settings` |
| dialog body | `The speech-to-text connection failed to reopen with the new parameters after {n} attempts. The session is still running on the previously applied config (cfg:7f3a9c21).` |
| dialog actions | `Revert to previous` / `Retry` |
| import error | `That file isn't a valid tuning config.` |
| import warning | `Imported. Ignored {n} unknown field(s): {names}.` |
| model fallback | `{model} is no longer available — using {default}.` |

---

## 8. `data-testid` table

Naming rule: `tuning-<section>-<knob>`; append `-default` for the "Provider default" checkbox, and
`-<option>` for each segmented/radio option.

The capture harness sets a whole config through **`tuning-import`** rather than driving 30 controls;
per-knob ids exist so a single-knob e2e or component test can be written.

### Shell / chrome

| testid | Element |
|---|---|
| `tuning-toggle` | navbar button (`aria-expanded`, `aria-controls="tuning-panel"`) |
| `tuning-panel` | the `<aside>` (id `tuning-panel`) |
| `tuning-close` | close button |
| `tuning-fingerprint` | fingerprint badge, panel header |
| `tuning-fingerprint-latency` | fingerprint badge in the latency strip — **the one the harness scrapes** |
| `tuning-pending-count` | pending badge in the navbar |
| `tuning-preset` | preset `select` |
| `tuning-preset-name` | inline "save as" name input |
| `tuning-preset-save` | confirm-save button |
| `tuning-export` / `tuning-import` | header buttons |
| `tuning-import-file` | hidden file input behind Import |
| `tuning-reset` | reset button |
| `tuning-apply` / `tuning-revert` | footer buttons |
| `tuning-status` | footer status line (`role="status" aria-live="polite"`) |
| `tuning-section-microphone` · `-denoise` · `-turn` · `-segmentation` · `-transcript-check` · `-models` | the `<details>` elements |
| `tuning-apply-failed-dialog` / `tuning-apply-retry` / `tuning-apply-revert` | failure modal + actions |
| `segment-suspicious-badge` | flag badge inside a transcript segment |

### Microphone

`tuning-mic-ec` · `tuning-mic-ns` · `tuning-mic-agc`

### Denoise chain

| testid | Control |
|---|---|
| `tuning-rms-enabled` | toggle |
| `tuning-rms-threshold` | range, dBFS |
| `tuning-rms-hold` / `tuning-rms-attack` / `tuning-rms-release` | number, ms |
| `tuning-rms-attenuation` | range, dB |
| `tuning-rms-mute` | "Full mute" checkbox |
| `tuning-rnnoise-enabled` | toggle |
| `tuning-rnnoise-voice-prob` | range |
| `tuning-openai-noise-reduction-off` / `-near` / `-far` | segmented radios (Realtime) |
| `tuning-dfn-enabled` | toggle (Cascade) |
| `tuning-dfn-attenuation-limit` / `tuning-dfn-post-filter` | numbers |
| `tuning-dfn-unavailable` | the "not installed" badge — asserted by the capability test |
| `tuning-noisereduce-enabled` | toggle |
| `tuning-noisereduce-prop-decrease` | range |
| `tuning-noisereduce-stationary` | stationary/non-stationary radios |
| `tuning-demucs-enabled` / `tuning-dns-enabled` | permanently-disabled toggles |

### Turn detection / endpointing

Realtime: `tuning-vad-type-server` · `tuning-vad-type-semantic` · `tuning-vad-threshold` ·
`tuning-vad-prefix-padding` · `tuning-vad-silence-duration` · `tuning-vad-interrupt-response` ·
`tuning-vad-eagerness`, each with a sibling `<id>-default` checkbox
(e.g. `tuning-vad-silence-duration-default`).

Cascade: `tuning-dg-endpointing` · `tuning-dg-utterance-end` · `tuning-dg-diarize`.

### Segmentation / transcript check / models

`tuning-segmentation-mode-hybrid` · `tuning-segmentation-mode-llm` · `tuning-segmentation-model` ·
`tuning-transcript-check-off` · `-flag` · `-correct` · `tuning-transcript-check-model` ·
`tuning-model-deepgram` · `tuning-model-translation` · `tuning-voice-a` · `tuning-voice-b` ·
`tuning-model-realtime` · `tuning-voice-realtime`.

---

## 9. Accessibility

- Every input has an associated `<label for>`; where the visual design has no room for one (preset
  select, close button) it uses `sr-only` label text or `aria-label`.
- Accordions are native `<details>/<summary>` — keyboard-operable and announced without any JS or
  `role="button"` gymnastics.
- Segmented controls are real radio inputs with `aria-label` per option (DaisyUI's
  `join-item btn` radio pattern), wrapped in `role="radiogroup"` with an `aria-label` naming the knob.
- The footer status line is `role="status" aria-live="polite"` so "Applied · cfg:… " and
  "Reconnecting STT with the new parameters…" are announced without stealing focus. Polite, not
  assertive — matching the existing convention (`WorkbenchPage.tsx:352` uses `role="status"` for
  non-blocking toasts and `role="alert"` for the blocking error banner).
- The failure dialog is `role="alertdialog" aria-modal="true"` with `aria-labelledby` /
  `aria-describedby`, focus moved to it on open, focus trapped, focus restored to `tuning-apply` on
  close.
- The panel toggle carries `aria-expanded` and `aria-controls`; opening the panel does **not** steal
  focus (you may be mid-session watching transcripts), but Escape inside the panel closes it and returns
  focus to the toggle.
- Disabled rows are genuinely `disabled`, not just dimmed, and the reason is in visible text — never in
  a `title` alone (a `title` on a disabled control is unreachable by keyboard).
- Colour is never the only signal: pending rows have a dot *and* a `was:` badge, not just an amber rule.

---

## 10. Responsive behaviour

| Breakpoint | Behaviour |
|---|---|
| ≥ `lg` (1024 px) | Side panel, 400 px fixed column, `sticky top-4`, own scroll (`max-h` + `overflow-y-auto`). Transcript grid → single column while open. |
| `sm`–`lg` | Same side panel, narrowed to 340 px; two-column knob grids inside sections collapse to one column. |
| < `sm` (640 px) | Panel becomes a **full-width bottom sheet** at `max-h-[85vh]` over the page (the transcripts are already single-column, so there is no side room to give up). Drag handle at the top, footer `sticky bottom-0` so Apply is one thumb away. All sections start collapsed. The navbar button drops the fingerprint chip and keeps only the count badge; the fingerprint stays visible in the panel header and in the latency strip. |

At every width, a slider is paired with a numeric readout/input — a bare `range` cannot express
"−45 dBFS exactly", which is precisely the kind of value this panel exists to set.

---

## 11. Open UX questions

**1 · Does the panel stay open across a mode switch, and what happens to unapplied changes in the mode
you left?**
Switching tabs already tears down the live session; the draft is mode-scoped, so Cascade's pending edits
are still there when you come back.
*Recommendation:* panel stays open; each mode keeps its own draft; pending changes survive the switch
untouched; the pending badge reflects the current mode only. No prompt, no discard — losing a
carefully-typed set of five VAD numbers because you glanced at the other tab would be the worst thing
this panel could do.

**2 · Should Apply be blocked while Cascade TTS playback is active or a Realtime reply is streaming?**
Cascade withholds mic frames during playback; Realtime disables the mic track mid-response. An Apply
landing in that window either strands queued audio or is ignored by the model.
*Recommendation:* don't block — **queue it**. Apply is accepted immediately, the status line reads
"Applying after the current reply…", and the `session.update`/reconnect fires at the next turn boundary.
Blocking a button for reasons the user can't see is worse than a one-turn delay they're told about. The
same queue coalesces rapid repeated Applies into one reconnect.

**3 · How much should the collapsed navbar chip communicate — fingerprint, or preset name?**
`cfg:7f3a9c21` is precise and joins directly to a benchmark row but says nothing about what is on; a
preset name reads instantly but goes stale the moment you nudge one slider.
*Recommendation:* fingerprint in the navbar and the latency strip; preset name in the panel header only,
with "Preset modified" beside it once the draft diverges. The fingerprint is the join key you need to
read off the screen and paste into `COMPARISON.md`. Optionally add a native `title` tooltip on the chip
listing the enabled stages.

---

## Step 5 gate outcome (2026-08-15): APPROVED

Wireframe approved as drafted (`.lavish/step5-wireframe-tuning-lab.html`). The three open UX questions are decided per the recommendations:
1. The panel stays open across a mode switch; each mode keeps its own draft; unapplied changes in the mode you left survive untouched; the pending badge counts the current mode only. No prompt, no discard.
2. Apply is never blocked during Cascade TTS playback or a streaming Realtime reply — it is **queued** ("Applying after the current reply…") and fires at the next turn boundary; the same queue coalesces rapid repeated Applies into a single Deepgram reconnect.
3. The collapsed navbar chip shows the **fingerprint**; the preset name lives in the panel header with a "Preset modified" marker once the draft diverges.
