import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * jsdom ships a real `localStorage`, but Node 26 installs its own experimental
 * global of that name and it wins on the window vitest hands us — where it
 * reads as `undefined` unless the process was started with
 * `--localstorage-file`. The tuning panel's persistence (ticket 03) is real
 * browser behaviour, so the environment gets a real in-memory `Storage` rather
 * than the tests getting a mock: `tuningPresets.ts` uses the ordinary API and
 * never knows the difference.
 */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  [name: string]: unknown;
}

function installStorage(): void {
  const store = new Proxy(new MemoryStorage(), {
    // `Object.keys(localStorage)` must list the stored keys, the way the
    // browser's own exotic Storage object does.
    ownKeys: (target) => Array.from({ length: target.length }, (_, index) => target.key(index) ?? ''),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
  Object.defineProperty(window, 'localStorage', { value: store, configurable: true, writable: true });
}

if (typeof window.localStorage === 'undefined') installStorage();

// Vitest doesn't expose Jest-style test globals by default, which is what
// @testing-library/react's own auto-cleanup detection relies on — wire it up
// explicitly so each test starts from an empty DOM.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
