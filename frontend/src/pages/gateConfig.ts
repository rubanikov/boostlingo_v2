// The RMS gate worklet (ticket 12), served verbatim from frontend/public/ at
// this fixed path in both dev and build (Vite copies public/'s contents to the
// output root). See that file for the AudioWorkletProcessor it registers under
// this name, and src/pages/rmsGate.ts for the math it mirrors.
//
// Its own module rather than a pair of constants in cascadeConfig.ts because
// *both* transports load it, and cascadeConfig.ts exists to keep the Cascade
// page's module graph independent of the Realtime page's (see its header).
export const GATE_WORKLET_URL = '/gate-processor.js';
export const GATE_WORKLET_NAME = 'gate-processor';
