// AudioWorklet processor for the RMS noise gate — used by **both** modes.
//
// Loaded via `audioContext.audioWorklet.addModule('/gate-processor.js')` from
// src/pages/useCascadeSession.ts (mic -> gate -> pcm worklet) and from
// src/pages/useRealtimeSession.ts (mic -> gate -> MediaStreamAudioDestination).
// Runs in AudioWorkletGlobalScope, a separate JS realm, so it can't import the
// app's TS module graph: everything below intentionally mirrors
// `src/pages/rmsGate.ts`, which is the unit-tested source of truth for the gate
// math, and `clampGateParams` in `src/pages/tuningConfig.ts` for the ranges.
// Keep them in sync by hand if either changes — same arrangement as
// `cascade-pcm-processor.js` and `floatSampleToInt16` in `src/pages/pcm.ts`.
//
// Parameters arrive twice over: once as `processorOptions.gate` at
// construction, and then as `port.postMessage({type:'gateParams', gate})` for
// every live adjust (story AC 3.3 — a threshold change must not need a
// reconnect). The main thread clamps before sending; this clamps again, because
// a port can be posted anything.
//
// `enabled: false` is a pass-through, not a teardown: that is what lets the
// panel turn the gate off mid-session on a graph whose node was wired at
// connect time.
const RMS_FLOOR = 1e-10;
const GATE_ALWAYS_OPEN_DBFS = -80;
const GATE_ALWAYS_CLOSED_DBFS = 0;

// Mirrors KNOB_METADATA's `client.rmsGate.*` ranges in src/pages/tuningConfig.ts.
const GATE_RANGES = {
  thresholdDbfs: { min: -80, max: 0, step: 1, fallback: -45 },
  holdMs: { min: 0, max: 2000, step: 10, fallback: 200 },
  attackMs: { min: 0, max: 500, step: 1, fallback: 5 },
  releaseMs: { min: 0, max: 2000, step: 10, fallback: 80 },
  attenuationDb: { min: 0, max: 60, step: 1, fallback: 12 },
};

function clampNumber(value, range) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : range.fallback;
  const bounded = Math.min(range.max, Math.max(range.min, numeric));
  return Math.round(bounded / range.step) * range.step;
}

function clampGate(gate) {
  const source = gate && typeof gate === 'object' ? gate : {};
  const clamped = { enabled: source.enabled === true, fullMute: source.fullMute === true };
  for (const key of Object.keys(GATE_RANGES)) {
    clamped[key] = clampNumber(source[key], GATE_RANGES[key]);
  }
  return clamped;
}

function blockRmsDbfs(block) {
  if (block.length === 0) return 20 * Math.log10(RMS_FLOOR);
  let sum = 0;
  for (let i = 0; i < block.length; i++) {
    sum += block[i] * block[i];
  }
  return 20 * Math.log10(Math.max(Math.sqrt(sum / block.length), RMS_FLOOR));
}

function gateFloorGain(gate) {
  return gate.fullMute ? 0 : Math.pow(10, -gate.attenuationDb / 20);
}

function isGateOpen(dbfs, thresholdDbfs) {
  if (thresholdDbfs <= GATE_ALWAYS_OPEN_DBFS) return true;
  if (thresholdDbfs >= GATE_ALWAYS_CLOSED_DBFS) return false;
  return dbfs >= thresholdDbfs;
}

function rampStep(ms, rate, floorGain) {
  const samples = (ms / 1000) * rate;
  if (!(samples > 0)) return 1;
  return (1 - floorGain) / samples;
}

class GateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._gate = clampGate(options && options.processorOptions && options.processorOptions.gate);
    this._gain = 1;
    this._holdRemainingSamples = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === 'gateParams') {
        this._gate = clampGate(message.gate);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0) {
      return true;
    }

    const gate = this._gate;
    const channels = Math.min(input.length, output.length);
    const detector = input[0];

    if (!gate.enabled) {
      for (let c = 0; c < channels; c++) {
        output[c].set(input[c]);
      }
      return true;
    }

    const floorGain = gateFloorGain(gate);
    if (this._gain > 1) this._gain = 1;
    if (this._gain < floorGain) this._gain = floorGain;

    const open = isGateOpen(blockRmsDbfs(detector), gate.thresholdDbfs);
    let holding = false;
    if (open) {
      this._holdRemainingSamples = (gate.holdMs / 1000) * sampleRate;
    } else {
      holding = this._holdRemainingSamples > 0;
      this._holdRemainingSamples = Math.max(0, this._holdRemainingSamples - detector.length);
    }

    const target = open || holding ? 1 : floorGain;
    const attackStep = rampStep(gate.attackMs, sampleRate, floorGain);
    const releaseStep = rampStep(gate.releaseMs, sampleRate, floorGain);

    // One envelope for every channel: the gain has to move identically across
    // them or a stereo input would be gated into something that no longer
    // resembles itself. The mic is mono in both modes today, so channel 0 is
    // also the only detector there is.
    for (let i = 0; i < detector.length; i++) {
      if (this._gain < target) this._gain = Math.min(target, this._gain + attackStep);
      else if (this._gain > target) this._gain = Math.max(target, this._gain - releaseStep);
      for (let c = 0; c < channels; c++) {
        output[c][i] = input[c][i] * this._gain;
      }
    }

    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);
