import { expect, test } from '@playwright/test';
import { gotoWorkbench, selectMode } from './support/workbench';

// Runs under the `tuning-import` Playwright project (see
// playwright.config.ts) — the only project with no fake-mic flags, because
// nothing here touches the microphone: importing a config and pressing Apply
// while disconnected is entirely a panel-and-fingerprint affair.
//
// This is the path `e2e/realtime-quality-capture.mjs --tuning` drives before
// every clip it captures: open the panel, hand the whole document to the
// importer rather than driving thirty controls, press Apply (which commits
// locally while disconnected, so the next connect() carries it), then read
// the fingerprint off the chip. If any of those testids or that message text
// moves, the capture harness silently stops applying tuning and every capture
// it writes is mislabelled.

const FINGERPRINT = /^cfg:[0-9a-f]{8}$/;

// The same env var the app itself reads (tuningCapabilities.ts), so probing
// and fetching can never end up pointed at different backends — which matters
// on a machine where something unrelated already answers port 8000.
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

// A partial document on purpose: the importer completes it from the server's
// defaults, which is what an exported-then-hand-edited config looks like.
// `silenceDurationMs` is one of the knobs COMPARISON.md section 2 measured,
// and 300 is not any server default here, so the fingerprint must move.
const TUNING_CONFIG = {
  schemaVersion: 1,
  realtime: { turnDetection: { type: 'server_vad', silenceDurationMs: 300 } },
};

test.describe('Tuning config import', () => {
  test('importing a config and applying it moves the fingerprint chip', async ({ page, request }) => {
    // The panel does fall back to built-in defaults when
    // `/api/tuning/capabilities` is unreachable, so this would technically
    // still run — but then the chip would be showing this build's constants
    // rather than what the server publishes, and "the harness reads the
    // applied config off the chip" would be proven against a fixture of
    // itself. `playwright.config.ts` starts the backend, so this normally
    // never skips.
    const capabilitiesUp = await request
      .get(`${API_BASE_URL}/api/tuning/capabilities`)
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(
      !capabilitiesUp,
      'No backend answering /api/tuning/capabilities — the chip would show this build\'s built-in ' +
        'defaults rather than the server\'s, so an import test would only be checking itself.',
    );

    await gotoWorkbench(page);
    // Realtime mode: its latency badge (and so the `tuning-fingerprint-latency`
    // chip beside it) renders before any session exists, whereas Cascade's
    // latency strip only appears once a segment has completed.
    await selectMode(page, 'Realtime');

    const chip = page.getByTestId('tuning-fingerprint-latency');
    // Also the panel's hydration gate, and the reason the harness reads the
    // chip before it imports anything: the chip is blank until the
    // capabilities response lands, and the panel re-seeds its draft from that
    // response when it does — discarding anything imported in the meantime.
    await expect(chip).toHaveText(FINGERPRINT);
    const before = (await chip.textContent())?.trim();

    await page.getByTestId('tuning-toggle').click();
    await page.getByTestId('tuning-import').click();
    await page.getByTestId('tuning-import-file').setInputFiles({
      name: 'tuning.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(TUNING_CONFIG)),
    });

    await expect(page.getByTestId('tuning-import-message')).toContainText('Imported');
    await page.getByTestId('tuning-apply').click();

    await expect(chip).toHaveText(FINGERPRINT);
    expect((await chip.textContent())?.trim()).not.toBe(before);
  });
});
