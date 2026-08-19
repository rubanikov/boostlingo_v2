import { expect, type Page } from '@playwright/test';

export type Mode = 'Cascade' | 'Realtime';

// WorkbenchPage.tsx's CONNECTION_BADGE labels (see src/pages/WorkbenchPage.tsx)
// — the connection-status badge's text is always exactly one of these.
// Cascade's transient toast messages also render with `role="status"` (see
// the same file), but their text is never one of these five labels, so
// filtering on this set keeps the badge unambiguous without needing an
// app-side `data-testid`.
//
// Matched via `.filter({ hasText })`, not `getByRole(role, { name })`:
// `status`/`alert` are ARIA "name from author" roles, so without an explicit
// `aria-label` (which WorkbenchPage doesn't set) their computed accessible
// *name* is empty even though their visible text isn't — confirmed by hand
// in this environment, `getByRole('status', { name: 'Error' })` matches
// nothing here despite an `Error`-labeled status span being on the page.
// `hasText` matches rendered text content instead, which works.
const CONNECTION_LABELS = ['Not connected', 'Connecting…', 'Connected', 'Reconnecting…', 'Error'] as const;

export function connectionBadge(page: Page) {
  return page.getByRole('status').filter({ hasText: new RegExp(`^(${CONNECTION_LABELS.join('|')})$`) });
}

export function errorAlert(page: Page) {
  return page.getByRole('alert');
}

export async function gotoWorkbench(page: Page) {
  await page.goto('/');
}

export async function selectMode(page: Page, mode: Mode) {
  await page.getByRole('tab', { name: mode }).click();
}

/**
 * The mic button's accessible name changes with connection status (see
 * MIC_BUTTON_LABEL in WorkbenchPage.tsx). 'Connect microphone' is its label
 * only in the pre-session `idle` state, which is the only state these specs
 * ever click it from.
 */
export function micButton(page: Page) {
  return page.getByRole('button', { name: 'Connect microphone' });
}

/**
 * Clicks the mic button and waits for the transient "Connecting…" badge to
 * settle one way or the other. This is the core thing the fake-mic harness
 * can prove without live provider keys: the real getUserMedia() ->
 * capture -> session-negotiation path runs to a definite outcome instead of
 * hanging or throwing. Returns the settled badge's text ('Connected' or
 * 'Error' in this environment; 'Connected' only if a live backend/key
 * happens to be configured).
 */
export async function connectAndWaitForSettled(page: Page, timeout = 15_000) {
  await micButton(page).click();
  await expect(connectionBadge(page)).not.toHaveText('Connecting…', { timeout });
  return (await connectionBadge(page).textContent())?.trim();
}

/** Collects any uncaught exception thrown in the page during a test. */
export function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}
