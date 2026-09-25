// lib/cors.js
// Stremio fetches addon endpoints from a browser context, so every response needs CORS headers
// (without them requests fail as a bare "Failed to fetch").

function withCors(handler) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    return handler(req, res);
  };
}

module.exports = { withCors };
