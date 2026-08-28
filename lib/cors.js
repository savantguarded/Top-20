// lib/cors.js
// Stremio (web + desktop) fetches addon endpoints from a browser context and
// enforces CORS. Without these headers every request gets blocked client-side
// and shows up in Stremio as a generic "Failed to fetch" with no other detail.
// The official stremio-addon-sdk sets these on every response; since these
// endpoints are hand-rolled Vercel functions, we set them explicitly here.

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

/**
 * Wrap a handler so CORS headers are always set, and OPTIONS preflight
 * requests get a clean 204 without running the real handler.
 */
function withCors(handler) {
  return async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    return handler(req, res);
  };
}

module.exports = { applyCors, withCors };
