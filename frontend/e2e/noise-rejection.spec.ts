import { expect, test } from '@playwright/test';
import { collectPageErrors, connectAndWaitForSettled, gotoWorkbench, selectMode } from './support/workbench';

// Runs under the `noise-rejection-fake-mic` Playwright project (see
// playwright.config.ts): Chromium launches with
// `--use-fake-device-for-media-stream` and
// `--use-file-for-fake-audio-capture=<silence.wav>` — a .wav of digital
// silence (e2e/fixtures/silence.wav), not a tone or speech.

test.describe('Noise rejection (silence fixture)', () => {
  test('the fake-mic pipeline handles a silence fixture without hanging or throwing', async ({ page }) => {
    // Meaningful today, independent of whether a backend is reachable: the
    // capture pipeline runs to completion on a silent input exactly like it
    // does on the tone fixture (realtime.spec.ts / cascade.spec.ts) — a
    // silent track is still a valid MediaStreamTrack, and nothing here
    // should special-case it into a hang or a thrown exception client-side.
    const pageErrors = collectPageErrors(page);

    await gotoWorkbench(page);
    await selectMode(page, 'Cascade');
    const finalStatus = await connectAndWaitForSettled(page);

    expect(['Connected', 'Error']).toContain(finalStatus);
    expect(pageErrors, `unhandled page errors: ${pageErrors.map((error) => error.message).join(', ')}`).toEqual([]);
  });

  test('silence never produces a spurious transcript segment', async ({ page }) => {
    await gotoWorkbench(page);
    await selectMode(page, 'Cascade');
    const finalStatus = await connectAndWaitForSettled(page);

    // The frontend has no client-side VAD/endpointing of its own: every
    // transcript segment it ever renders is copied verbatim from a
    // `source_transcript`/`target_transcript` server message (see
    // useCascadeSession.ts's handleServerMessage switch). So "no spurious
    // transcript on silence" is fundamentally a backend/STT-provider
    // behavior (Deepgram's VAD/endpointing, per the brief), not something
    // this harness can prove purely client-side. Without a live connection,
    // the transcript pane stays empty for *any* input — tone or silence
    // alike (compare cascade.spec.ts) — which would make this assertion
    // pass for the wrong reason. It's only meaningful once a live Cascade
    // backend is actually reachable, so it self-skips until then rather than
    // asserting something this environment can't actually verify.
    test.skip(
      finalStatus !== 'Connected',
      'No live Cascade backend/STT provider is reachable in this environment — see the comment above for why this ' +
        'assertion would be meaningless without one. Re-run once a live backend is configured.',
    );

    // Give the silent fake mic several seconds of real streaming time, then
    // assert the source pane never received a spurious segment.
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId('source-transcript')).toHaveText('');
  });
});
