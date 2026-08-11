Type: grilling
Status: claimed

## Question

[STT/audio quality assurance & mic calibration strategy](11-stt-quality-assurance-mic-calibration.md)
already decided to build a TTS-generated test corpus (~10-15 sentences per language) for
an automated WER regression test — but that only measures whether Deepgram heard the
right *words*. It says nothing about whether the *translation* is any good, which the
brief separately names as a Key Impact Metric ("interpretation quality (subjective +
WER)").

Decide:

- **Dataset composition** — should the shared test corpus be generic conversational
  sentences, domain-flavored (healthcare/legal/customer-service, matching Boostlingo's
  actual customer base), or a mix? Should it include a few longer multi-turn
  conversation snippets (not just single sentences) to exercise the segmentation-boundary
  logic from
  [Cascade pipeline architecture](05-cascade-pipeline-architecture.md) and double as
  material for the 5-minute stability test
  ([Stability: reconnection, drift, memory](13-stability-reconnection-drift-memory.md))?
- **Translation-quality testing methodology** — the brief asks for "subjective + WER,"
  not automated MT metrics like BLEU/COMET. Decide whether to add a lightweight
  automated check (e.g. LLM-as-judge scoring source vs. translated text) as a
  supplement to manual subjective review, or rely on manual review alone.
- **Shared across modes** — should the same test corpus run through both Realtime and
  Cascade modes for an apples-to-apples comparison feeding the write-up, rather than
  separate datasets per mode?
