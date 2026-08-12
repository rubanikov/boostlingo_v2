import { expect, test } from '@playwright/test';
import { collectPageErrors, connectAndWaitForSettled, errorAlert, gotoWorkbench, selectMode } from './support/workbench';

// Runs under the `realtime-fake-mic` Playwright project (see
// playwright.config.ts): Chromium launches with
// `--use-fake-device-for-media-stream` and
// `--use-file-for-fake-audio-capture=<placeholder-tone.wav>`, so
// getUserMedia() genuinely captures audio — a synthesized tone, not real
// speech (see e2e/README.md for why, and what replaces it later).

test.describe('Realtime mode', () => {
  test('connecting reaches a settled state (connected or a graceful error) without hanging or throwing', async ({
    page,
  }) => {
    // This is what's genuinely verifiable today, with no live OpenAI key
    // configured in this environment: the real capture -> ephemeral-token
    // exchange -> WebRTC-offer path runs to a definite outcome and, if it
    // fails, fails with an actionable on-screen message rather than an
    // unhandled exception or an indefinite "Connecting…" hang.
    const pageErrors = collectPageErrors(page);

    await gotoWorkbench(page);
    await selectMode(page, 'Realtime');

    const finalStatus = await connectAndWaitForSettled(page);

    // 'Connected' is only reachable with a live backend + OpenAI key, which
    // this environment doesn't have — but this assertion must keep passing
    // if that ever changes, not just cover the error path.
    expect(['Connected', 'Error']).toContain(finalStatus);

    if (finalStatus === 'Error') {
      await expect(errorAlert(page)).toBeVisible();
      await expect(errorAlert(page)).not.toBeEmpty();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    }

    expect(pageErrors, `unhandled page errors: ${pageErrors.map((error) => error.message).join(', ')}`).toEqual([]);
  });

  // Not runnable yet — needs a real EN speech fixture and a live OpenAI
  // Realtime API key on the backend, neither of which exist in this
  // environment. Left in place, skipped, so it's ready to enable rather than
  // needing to be written from scratch later.
  test.skip(
    'transcript reflects real speech within a time budget (needs a real speech fixture + a live backend)',
    async ({ page: _page }) => {
      // TODO once frontend/e2e/fixtures/placeholder-tone.wav is replaced by
      // a real speech fixture with known text (see e2e/README.md) and a
      // live backend/OpenAI key is configured:
      //   1. point playwright.config.ts's `realtime-fake-mic` project's
      //      `--use-file-for-fake-audio-capture` at the real fixture,
      //   2. un-skip this test,
      //   3. assert the fixture's known words show up within budget, e.g.:
      //        await gotoWorkbench(page);
      //        await selectMode(page, 'Realtime');
      //        await connectAndWaitForSettled(page);
      //        await expect(page.getByTestId('source-transcript'))
      //          .toContainText(EXPECTED_WORDS, { timeout: 10_000 });
    },
  );
});
