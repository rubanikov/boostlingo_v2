import { vi } from 'vitest';

/**
 * The stand-in for `loadRnnoise`, which really fetches one of two wasm binaries
 * after probing for SIMD support.
 *
 * Exported here rather than imported from the mocked package: a test file that
 * *statically* imports `@sapphi-red/web-noise-suppressor` makes Vitest process
 * the package as source, and the `await import(...)` inside `rnnoiseConfig.ts`
 * then resolves to that real source instead of to this mock. Reaching the spy
 * through this module keeps the package out of the test file's import graph
 * entirely, which is the only arrangement in which both imports agree.
 */
export const loadRnnoiseMock = vi.fn(async () => new ArrayBuffer(8));

/**
 * The `@sapphi-red/web-noise-suppressor` stand-in for both session hooks
 * (ticket 13). Used as a `vi.mock` factory:
 *
 * ```ts
 * vi.mock('@sapphi-red/web-noise-suppressor', async () => {
 *   const { createRnnoiseModuleMock } = await import('../test/mockRnnoise');
 *   return createRnnoiseModuleMock();
 * });
 * ```
 *
 * Mocking the package rather than `rnnoiseConfig.ts` is deliberate: it
 * leaves the real wiring under test — which worklet URL is registered, which
 * wasm URLs are fetched, that the node is constructed after the module is
 * registered — and stubs only the two things that cannot exist in jsdom: the
 * wasm fetch, and a class that subclasses the real `AudioWorkletNode` at
 * module-evaluation time.
 *
 * The node subclasses `FakeAudioWorkletNode`, so it lands in the same instance
 * registry as the gate and capture worklets and `ofType(RNNOISE_WORKLET_NAME)`
 * finds it alongside them.
 *
 * The factory is async because `vi.mock` factories are hoisted above every
 * import in the file that declares them.
 */
export async function createRnnoiseModuleMock() {
  const { FakeAudioWorkletNode } = await import('./mockCascadeApis');
  const { RNNOISE_WORKLET_NAME } = await import('../pages/rnnoiseConfig');

  class RnnoiseWorkletNode extends FakeAudioWorkletNode {
    destroy = vi.fn();

    constructor(context: unknown, options: { maxChannels: number; wasmBinary: ArrayBuffer }) {
      super(context, RNNOISE_WORKLET_NAME, { processorOptions: options });
    }
  }

  return { loadRnnoise: loadRnnoiseMock, RnnoiseWorkletNode };
}
