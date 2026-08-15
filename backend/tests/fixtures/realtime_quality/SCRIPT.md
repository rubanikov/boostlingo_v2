# Recording script: Realtime-mode quality corpus

What to say, and how, to produce the audio that fills the one empty row in
[COMPARISON.md](../../../../COMPARISON.md) §2 ("Realtime LLM-judge acceptance
rate: not run"). Every line below is a verbatim item from
`interpreter_dataset.json`, so the resulting clips can be judged against the
same corpus Cascade was scored on.

## How to record

1. Open `backend/tests/fixtures/real_audio/recorder.html` in Chrome or Edge
   (open the file directly; if Record does nothing, run
   `npx --yes serve backend/tests/fixtures/real_audio` from the repo root and
   open the printed `http://localhost` URL instead).
2. Click **Grant repo access** and pick the repo root (`boostlingo_v2`).
   Recordings then save straight into `backend/tests/fixtures/realtime_quality/`
   and the manifest keeps itself up to date; the list shows a **recorded**
   badge and an *N / 33* counter so you can stop and resume.
3. Switch the prompt-set toggle to **Realtime quality corpus (33)**.
4. Fill in **Conditions** once (e.g. `quiet room, headset mic`) — it's stored
   with every clip.
5. For each line: click it, hit Record, wait about half a second, say the
   line, wait about half a second, hit Stop, listen back, then **Save
   recording**. Re-record if you stumbled; there's no need to be perfect,
   but a clean read of the words is what's being tested, not your acting.
6. When the counter reads 33 / 33, you're done. Total speaking time is under
   three minutes; with clicking and listening back, budget 15–20 minutes.

Speak at a normal conversational pace with natural intonation. Read the
Spanish lines in Spanish (any accent is fine). For `conv-delayed-order-t3`,
say the digits individually ("four, eight, two, one, three") as written.

## The lines

### Short, English → Spanish (10)

| id | say |
|---|---|
| short-en-01 | Hi, how are you doing today? |
| short-en-02 | Good morning! Did you sleep well? |
| short-en-03 | Can you pass me the salt, please? |
| short-en-04 | I'm sorry, I didn't catch that. |
| short-en-05 | What time does the store close? |
| short-en-06 | Thanks so much, I really appreciate it. |
| short-en-07 | Um, I think we should probably get going. |
| short-en-08 | Do you know if it's supposed to rain later? |
| short-en-09 | Nice to meet you, I've heard a lot about you. |
| short-en-10 | Could you say that again, a bit slower? |

### Short, Spanish → English (8)

| id | say |
|---|---|
| short-es-01 | Buenas tardes, ¿en qué puedo ayudarte? |
| short-es-02 | ¿Cuánto cuesta esto, más o menos? |
| short-es-03 | No te preocupes, tenemos mucho tiempo. |
| short-es-04 | ¿Te importaría esperar un momento? |
| short-es-05 | Perdón por llegar tarde, había mucho tráfico. |
| short-es-06 | ¿Quieres que te acompañe a la parada del autobús? |
| short-es-07 | Vale, entonces nos vemos mañana a las nueve. |
| short-es-08 | ¿Qué tal si pedimos pizza esta noche? |

### Long, single sentence (3)

| id | say |
|---|---|
| long-en-01 | I was going to call you earlier, but then my phone died, and by the time I found a charger, it was already pretty late, so I figured I'd just text you instead. |
| long-es-01 | Quería decirte que, bueno, en realidad no sé cómo explicarlo, pero creo que deberíamos hablar de lo que pasó la semana pasada antes de que se nos olvide. |
| long-en-02 | So we drove all the way out to the coast, and the weather was great at first, but then it started pouring right when we got there, which was kind of a bummer, but we still had a good time. |

### Conversations, one clip per turn (12)

Each turn is its own clip. If two people are available, alternate voices per
speaker (0 / 1); one voice for everything is fine too.

**conv-weekend-plans**

| id | speaker | say |
|---|---|---|
| conv-weekend-plans-t1 | 0 | Hey, do you have any plans for the weekend? |
| conv-weekend-plans-t2 | 1 | Todavía no, ¿por qué? ¿Tienes algo en mente? |
| conv-weekend-plans-t3 | 0 | I was thinking we could go hiking if the weather holds up. |
| conv-weekend-plans-t4 | 1 | Me encantaría, ¡avísame a qué hora! |

**conv-directions**

| id | speaker | say |
|---|---|---|
| conv-directions-t1 | 0 | Disculpa, ¿sabes cómo llegar a la estación de tren desde aquí? |
| conv-directions-t2 | 1 | Sure, just go straight for two blocks and then turn left. |
| conv-directions-t3 | 0 | Perfecto, muchas gracias por la ayuda. |
| conv-directions-t4 | 1 | No problem, have a safe trip! |

**conv-delayed-order**

| id | speaker | say |
|---|---|---|
| conv-delayed-order-t1 | 0 | Hi, I ordered something over a week ago and it still hasn't arrived. |
| conv-delayed-order-t2 | 1 | Lo siento mucho, déjame revisar el estado de tu pedido. |
| conv-delayed-order-t3 | 0 | Thanks, the order number is four eight two one three. |
| conv-delayed-order-t4 | 1 | Ya lo veo, parece que hubo un retraso, pero llegará mañana. |

## Also: the E2E fixture

The Playwright suite's real-speech tests need one clip at
`frontend/e2e/fixtures/real-speech.wav`. After saving `short-en-01` above,
click **Also set as E2E real-speech.wav** on that same recording. Use that
one specifically: it's the sentence the latency measurements in COMPARISON.md
§1 already use, so one recording serves both.

## What happens with the audio next

`manifest.json` in this folder (written by the recorder) lists each clip with
its dataset id, languages, reference text, and reference translation. The
runner that consumes it plays each clip into a live Realtime session through
Chromium's fake-mic device, captures `gpt-realtime`'s output transcript per
turn, and scores every (source, transcript) pair with the same
`judge_translation()` that produced Cascade's 33/33 — writing
`backend/tests/fixtures/realtime_quality_report.json` and the number for
COMPARISON.md §2. That runner needs live `OPENAI_API_KEY` and costs a few
dollars of `gpt-realtime` audio tokens for the whole corpus.
