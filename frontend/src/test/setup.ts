import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest doesn't expose Jest-style test globals by default, which is what
// @testing-library/react's own auto-cleanup detection relies on — wire it up
// explicitly so each test starts from an empty DOM.
afterEach(() => {
  cleanup();
});
