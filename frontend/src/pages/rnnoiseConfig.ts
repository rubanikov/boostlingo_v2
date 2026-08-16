// RNNoise (ticket 13), from `@sapphi-red/web-noise-suppressor` — the one
// runtime dependency this feature adds. Chosen over `@jitsi/rnnoise-wasm`
// because it ships a working AudioWorklet with the 480-sample/48kHz framing
// already handled; the Jitsi package is a bare wasm binding, so the framing and
// ring buffering would have to be hand-written in a realm that can't import TS.
//
// Its own module rather than constants inside a session hook because *both*
// transports load it, exactly like `gateConfig.ts` — and cascadeConfig.ts
// exists to keep the Cascade page's module graph independent of the Realtime
// page's (see its header).
//
// The worklet and the wasm are pulled in with Vite's `?url` suffix, which is
// what the package's own README prescribes: both are emitted into
// `dist/assets/` as hashed files and these constants are the URLs to fetch them
// from. `loadRnnoise` picks between the two binaries at runtime by probing for
// SIMD support, so both have to be reachable.
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export const RNNOISE_WORKLET_URL: string = rnnoiseWorkletUrl;

/** Both binaries, in the shape `loadRnnoise` takes them. */
export const RNNOISE_WASM_URLS = { url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl } as const;

/**
 * The name `RnnoiseWorkletNode` registers its processor under (package
 * internal, `dist/rnnoise/workletProcessor.js`). Not needed to build the graph
 * — the node class knows its own name — but it is how a test tells the RNNoise
 * node apart from the gate and capture nodes.
 */
export const RNNOISE_WORKLET_NAME = '@sapphi-red/web-noise-suppressor/rnnoise';

/**
 * RNNoise is trained on 480-sample / 10 ms frames at 48 kHz and the node's own
 * doc comment says it "assumes sample rate to be 48kHz". So the capture context
 * runs at 48 kHz whenever the stage is on, in **both** modes.
 */
export const RNNOISE_CONTEXT_SAMPLE_RATE = 48000;

/** The mic is mono in both modes; `maxChannels` sizes the node's scratch buffers. */
export const RNNOISE_MAX_CHANNELS = 1;

/**
 * Registers the processor and builds the node, in the order the package's
 * README prescribes: fetch the wasm (`loadRnnoise` probes for SIMD support and
 * picks one of the two binaries itself), register the worklet module, then
 * construct — `RnnoiseWorkletNode` hands the binary to the processor through
 * `processorOptions`, so the module has to be registered first.
 *
 * The package is pulled in with a **dynamic** `import` so it is code-split out
 * of the main bundle and never evaluated when the stage is off — the same
 * "nobody asked for this" reasoning that already loads `gate-processor.js`
 * lazily. It also keeps a module that subclasses `AudioWorkletNode` at
 * evaluation time out of the way of every jsdom test that isn't about RNNoise.
 */
export async function createRnnoiseNode(context: AudioContext): Promise<RnnoiseWorkletNode> {
  const { RnnoiseWorkletNode: NodeClass, loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
  const [wasmBinary] = await Promise.all([
    loadRnnoise(RNNOISE_WASM_URLS),
    context.audioWorklet.addModule(RNNOISE_WORKLET_URL),
  ]);
  return new NodeClass(context, { maxChannels: RNNOISE_MAX_CHANNELS, wasmBinary });
}
