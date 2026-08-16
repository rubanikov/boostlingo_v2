// Backend base URL. FastAPI's default dev port is 8000; override with
// VITE_API_BASE_URL if the backend runs elsewhere.
const DEFAULT_API_BASE_URL = 'http://localhost:8000';

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE_URL;

export const REALTIME_SESSION_ENDPOINT = `${API_BASE_URL}/api/realtime/session`;

// The transcript check's HTTP surface (ticket 15). It lives under /api/tuning
// on the server, but its only caller is useRealtimeSession: Cascade runs the
// same check inline on the backend and never makes this request. Declared here,
// beside the other endpoints that hook calls, rather than in
// tuningCapabilities.ts, which is about the capabilities document itself.
export const TRANSCRIPT_CHECK_ENDPOINT = `${API_BASE_URL}/api/tuning/transcript-check`;

// OpenAI's WebRTC signaling endpoint. The browser posts its SDP offer here
// directly, authenticated with the short-lived ephemeral token minted by our
// backend: the real OPENAI_API_KEY never reaches the browser.
export const OPENAI_REALTIME_CALLS_ENDPOINT = 'https://api.openai.com/v1/realtime/calls';
