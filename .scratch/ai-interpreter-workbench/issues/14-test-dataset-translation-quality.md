Type: grilling
Status: resolved

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

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-14-test-dataset-translation-quality.html](../../../.lavish/ticket-14-test-dataset-translation-quality.html).

**Correction made mid-session**: the domain framing in this ticket's Question ("matching
Boostlingo's actual customer base" as healthcare/legal/customer-service) was an
unsupported assumption — the brief never names a specific domain, only that Boostlingo
"connects people who need language interpretation with professional human interpreters."
The dataset decided below is domain-agnostic accordingly.

**1. Dataset composition — varied everyday conversation**, ~15-20 short items: greetings,
questions, requests, casual asides, a couple of contractions/filler words ("um," "you
know") — general street conversation, no assumed professional domain. Also folds in 2-3
longer, multi-clause sentences (e.g. a run-on with a mid-thought correction) into the same
set rather than a separate long-sentences dataset, so segmentation gets stress-tested for
free. Includes 2-3 longer multi-turn conversation snippets (e.g. making weekend plans,
asking for directions, a complaint about a delayed order) that double as material for the
5-minute stability test
([Stability: reconnection, drift, memory](13-stability-reconnection-drift-memory.md)) and
exercise ticket 05's segmentation-boundary logic across a real back-and-forth.

**2. Translation-quality methodology — manual review + LLM-as-judge**, not full MT
metrics (BLEU/COMET). Reasoning: BLEU counts n-gram overlap against a human-written
reference translation (mechanical, punishes valid paraphrases); COMET is a neural metric
trained on human ratings that scores more intelligently but still generally needs that
same pre-written reference — either way, the real cost is writing a correct reference
translation for every test sentence up front. An LLM-as-judge needs no reference: prompt
it to explain *what's wrong* (lost tense, wrong register, dropped negation), not just
output a score — directly actionable in a way an aggregate BLEU/COMET number isn't, and
repeatable in a way manual-only review isn't. BLEU/COMET are built for tracking trends
across hundreds/thousands of examples in a research pipeline; a ~15-20 item dataset
doesn't have the volume for the number to be meaningful anyway. Manual review stays the
primary "subjective" signal the brief asks for; LLM-as-judge is the automated supplement
that catches regressions between runs.

**3. Shared across modes — yes.** The exact same corpus runs through both Realtime and
Cascade modes, so the comparison write-up's latency/quality/cost comparison is measured
against identical input rather than two different datasets.

**Reused from ticket 11**: this is the *same* underlying dataset ticket 11 already
decided to build for the WER regression test — one corpus, two measurement points (WER
checks Deepgram's output against the known source text; this ticket's translation-quality
check runs on what comes out the other end of the pipeline from that same source text).
