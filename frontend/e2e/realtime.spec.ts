import { expect, test } from '@playwright/test';
import { HAS_REAL_SPEECH_FIXTURE } from '../playwright.config';
import { collectPageErrors, connectAndWaitForSettled, errorAlert, gotoWorkbench, selectMode } from './support/workbench';

// Runs under the `realtime-fake-mic` Playwright project (see
// playwright.config.ts): Chromium launches with
// `--use-fake-device-for-media-stream` and
// `--use-file-for-fake-audio-capture=<fixture>.wav`. That fixture is a real
// speech recording (e2e/fixtures/real-speech.wav) if one has been dropped
// in, otherwise the synthesized placeholder tone — either way,
// getUserMedia() genuinely captures audio, not mocked in JS. See
// e2e/README.md for how to add a real recording.

test.describe('Realtime mode', () => {
  test('connecting reaches a settled state (connected or a graceful error) without hanging or throwing', async ({
    page,
  }) => {
    // What's genuinely verifiable without a live OpenAI key: the real
    // capture -> ephemeral-token exchange -> WebRTC-offer path runs to a
    // definite outcome and, if it fails, fails with an actionable on-screen
    // message rather than an unhandled exception or an indefinite
    // "Connecting…" hang.
    const pageErrors = collectPageErrors(page);

    await gotoWorkbench(page);
    await selectMode(page, 'Realtime');

    const finalStatus = await connectAndWaitForSettled(page);

    // 'Connected' needs a live backend + OpenAI key; this assertion accepts
    // either outcome so it keeps passing whether or not those are present.
    expect(['Connected', 'Error']).toContain(finalStatus);

    if (finalStatus === 'Error') {
      await expect(errorAlert(page)).toBeVisible();
      await expect(errorAlert(page)).not.toBeEmpty();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    }

    expect(pageErrors, `unhandled page errors: ${pageErrors.map((error) => error.message).join(', ')}`).toEqual([]);
  });

  // Needs a real speech fixture (checked at collection time, below) AND a
  // live backend + OpenAI Realtime key actually connecting -- the second
  // half isn't something this test can force, so it skips at runtime too if
  // the session settles to 'Error' rather than 'Connected'. No specific
  // words are asserted (this suite has no way to know what a given
  // real-speech.wav actually says) -- "some live transcript text arrived"
  // is what a fixture-agnostic real-speech test can honestly claim.
  (HAS_REAL_SPEECH_FIXTURE ? test : test.skip)(
    'transcript reflects real speech within a time budget',
    async ({ page }) => {
      await gotoWorkbench(page);
      await selectMode(page, 'Realtime');

      const finalStatus = await connectAndWaitForSettled(page);
      test.skip(finalStatus !== 'Connected', 'needs a live backend + OpenAI Realtime key to reach Connected');

      await expect(page.getByTestId('source-transcript')).not.toBeEmpty({ timeout: 10_000 });
    },
  );
});
