// Backend base URL. FastAPI's default dev port is 8000; override with
// VITE_API_BASE_URL if the backend runs elsewhere. Mirrors the env var
// realtimeConfig.ts reads, kept as its own constant (rather than a shared
// import) so this page's module graph stays independent of Ticket 1's.
const DEFAULT_API_BASE_URL = 'http://localhost:8000';

const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE_URL;

export const CASCADE_WS_ENDPOINT = `${API_BASE_URL.replace(/^http/, 'ws')}/ws/cascade`;

// Served verbatim from frontend/public/ at this fixed path in both dev and
// build (Vite copies public/'s contents to the output root). See that file
// for the AudioWorkletProcessor implementation it registers under this name.
export const CASCADE_PCM_WORKLET_URL = '/cascade-pcm-processor.js';
export const CASCADE_PCM_WORKLET_NAME = 'cascade-pcm-processor';
