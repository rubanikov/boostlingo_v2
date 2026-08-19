// The demo's voice-over, one entry per step. `record.mjs` plays a scene as a
// list of steps: each step runs its UI action, then holds the frame until the
// narration line for that step has had time to finish. `id` is the join key
// between the narration audio (`out/narration/<id>.mp3`) and the recorded
// timeline (`out/timeline.json`), so the assembly step can drop every line
// exactly where its action happened.
//
// Scenes are separate browser launches (each needs its own fake-mic file), so
// they are also separate video files; `assemble.mjs` concatenates them.
// Silent `{ hold }` steps leave room to hear a turn and its translated reply
// without the narrator over it (app audio is ducked while narration plays).
//
// Budget: the whole thing is meant to land between four and four and a half
// minutes, so every line here earns its seconds.

export const SCENES = [
  {
    id: 'intro',
    mode: 'cascade',
    steps: [
      {
        id: 'intro-1',
        text:
          'This is the AI Interpreter Workbench: live speech interpretation done two ways, side by side, so the trade-offs can be measured instead of assumed.',
      },
      {
        id: 'intro-2',
        text:
          "Cascade is a streaming pipeline: Deepgram speech-to-text, OpenAI translation, ElevenLabs speech, behind a FastAPI backend. Realtime is OpenAI's gpt-realtime over WebRTC straight from the browser; the backend only mints a token.",
      },
    ],
  },
  {
    id: 'cascade',
    mode: 'cascade',
    // conv-delayed-order t1..t4: a two-party customer-service exchange that
    // alternates English and Spanish, so one session shows both directions.
    mic: {
      clips: ['conv-delayed-order-t1', 'conv-delayed-order-t2', 'conv-delayed-order-t3', 'conv-delayed-order-t4'],
      leadS: 3,
      gapS: 8,
      tailS: 5,
    },
    steps: [
      {
        id: 'cascade-1',
        text: "Cascade first, English and Spanish. I'll connect the microphone and play a short customer-service conversation into it.",
      },
      { id: 'cascade-listen-1', hold: 6 },
      {
        id: 'cascade-2',
        text:
          "Deepgram streams a diarized transcript into the source pane; an LLM clause-checker races Deepgram's pause signal to end each segment; the segment is translated and ElevenLabs speaks it back while the text lands on the right.",
      },
      { id: 'cascade-listen-2', hold: 5 },
      {
        id: 'cascade-3',
        text: 'Direction is detected per utterance: the Spanish answer simply comes back as English, no swap button. Each speaker gets their own color and voice.',
      },
      { id: 'cascade-listen-3', hold: 3 },
      {
        id: 'cascade-4',
        text:
          'The latency strip breaks the last segment down stage by stage against a two-second target and flags the biggest jump as the bottleneck. The chip is the fingerprint of the tuning config the server confirms it is running.',
      },
    ],
  },
  {
    id: 'realtime',
    mode: 'realtime',
    mic: {
      clips: ['conv-directions-t1', 'conv-directions-t2'],
      leadS: 8,
      gapS: 13,
      tailS: 14,
    },
    steps: [
      {
        id: 'realtime-1',
        text: 'Now Realtime. The browser negotiates WebRTC straight to OpenAI; the model hears the audio, translates inside itself, and speaks the result back.',
      },
      { id: 'realtime-listen-1', hold: 8 },
      {
        id: 'realtime-2',
        text: "There is no pipeline to instrument, so the badge is one end-to-end number per turn against a one-and-a-half-second target. The caption on the left is the model's own transcription of what it heard.",
      },
      { id: 'realtime-listen-2', hold: 4 },
      {
        id: 'realtime-3',
        text:
          'Realtime has its own turn-detection knobs: server or semantic VAD, the silence that ends a turn, prefix padding. Tuning just these took it from fifty-eight to ninety-four percent acceptable translations on real speech.',
      },
      {
        id: 'realtime-4',
        text: "And OpenAI's own input noise reduction, near-field or far-field, applies live. Watch the fingerprint change.",
      },
    ],
  },
  {
    id: 'tuning',
    mode: 'cascade',
    // A slow four-turn conversation trickles through a live Cascade session
    // in the background, so the panel is shown against a running session
    // (live applies, the pending/apply-kind labels) rather than an idle page.
    mic: {
      clips: ['conv-weekend-plans-t1', 'conv-weekend-plans-t2', 'conv-weekend-plans-t3', 'conv-weekend-plans-t4'],
      leadS: 6,
      gapS: 19,
      tailS: 30,
    },
    steps: [
      {
        id: 'tuning-1',
        text:
          'Everything between the microphone and the provider is adjustable from the Tuning panel, listed in signal order. A knob nothing sits behind is never shown, so the panel is also the inventory of what is tunable.',
      },
      {
        id: 'tuning-2',
        text: "First the browser's own microphone constraints: echo cancellation, noise suppression, auto gain.",
      },
      {
        id: 'tuning-3',
        text:
          'Then the denoise chain. The RMS gate runs in the browser and attenuates anything below a threshold, so room tone between sentences never reaches the transcriber; its knobs apply live.',
      },
      {
        id: 'tuning-4',
        text: 'RNNoise is a recurrent-network denoiser trained on speech, running on the mic signal at forty-eight kilohertz before anything leaves the browser.',
      },
      {
        id: 'tuning-5',
        text:
          'Server-side, Cascade can add DeepFilterNet or noisereduce. When the optional dependency is not installed, the row is disabled and shows the install command instead of silently doing nothing.',
      },
      {
        id: 'tuning-6',
        text:
          "Deepgram's endpointing and utterance-end timers, and diarization, are connection-level: applying one reopens the speech-to-text socket behind the running session instead of ending it.",
      },
      {
        id: 'tuning-7',
        text:
          'Segmentation picks hybrid-race or LLM-priority, and the transcript check can flag a likely misrecognition or rewrite it before translation.',
      },
      {
        id: 'tuning-8',
        text: "Models and voices, one ElevenLabs voice per speaker, every option from the server's allow-list, never free text.",
      },
      {
        id: 'tuning-9',
        text:
          'Changes stage until you press Apply, and the button says which kind you get: live, reconnect the STT socket, or at next connect. Three presets ship built in; here is Max denoise.',
      },
      {
        id: 'tuning-10',
        text:
          'Every config hashes to a fingerprint, shown in the header and stamped on every benchmark row, so a result always traces back to its settings. Export writes the JSON the benchmark harnesses take.',
      },
    ],
  },
  {
    id: 'outro',
    mode: 'cascade',
    steps: [
      {
        id: 'outro-1',
        text:
          'Behind the app, a noisy-corpus benchmark and a Realtime quality harness score each configuration for word error rate, translation quality and latency. Two modes, one workbench, measured instead of assumed. Thanks for watching.',
      },
    ],
  },
];

/** Every step that has a narration line (silent `hold` steps excluded). */
export const ALL_STEPS = SCENES.flatMap((scene) =>
  scene.steps.filter((step) => step.text).map((step) => ({ ...step, scene: scene.id })),
);
