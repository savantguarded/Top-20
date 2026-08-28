// api/poster.js
// Served at /poster/:type/:imdb/:rank.jpg (see vercel.json rewrite -> ?type=&imdb=&rank=).

const { applyOverlays } = require('../lib/badge');
const { withCors } = require('../lib/cors');
const { getConfig } = require('../lib/config');

const PRIMARY_FETCH_TIMEOUT_MS = 8000;
const FALLBACK_FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replaces provider template placeholders in order:
 * 1. Specific API keys ({tmdb_key}, {mdblist_key}) from process.env
 * 2. Media type ({type}) -> 'movie' or 'series'
 * 3. Specific TMDB ID ({tmdb_id}, {tmdbId})
 * 4. Fallback IMDb ID for any general `{...id...}` token ({id}, {imdb_id}, etc.)
 */
function buildPosterUrl(template, { imdbId, tmdbId, type }) {
  if (!template) return '';
  let url = template;

  const tmdbKey = process.env.TMDB_API_KEY || '';
  const mdblistKey = process.env.MDBLIST_API_KEY || process.env.MDBLIST_KEY || '';

  url = url.replace(/\{tmdb_key\}/gi, encodeURIComponent(tmdbKey));
  url = url.replace(/\{mdblist_key\}/gi, encodeURIComponent(mdblistKey));

  if (type) {
    url = url.replace(/\{type\}/gi, encodeURIComponent(type));
  }

  if (tmdbId) {
    url = url.replace(/\{tmdb_?id\}/gi, encodeURIComponent(tmdbId));
  }

  if (imdbId) {
    url = url.replace(/\{[^{}]*id[^{}]*\}/gi, encodeURIComponent(imdbId));
  }

  return url;
}

module.exports = withCors(async (req, res) => {
  const { type, imdb, rank, fallback, ctx, tmdbId } = req.query;
  const rankNum = Math.max(1, parseInt(rank, 10) || 1);

  if (!imdb) {
    res.status(400).json({ err: 'missing imdb id' });
    return;
  }

  const cfg = await getConfig();
  let posterBuffer = null;

  try {
    const targetUrl = buildPosterUrl(cfg.posterUrlTemplate, { imdbId: imdb, tmdbId, type });
    const r = await fetchWithTimeout(targetUrl, PRIMARY_FETCH_TIMEOUT_MS);
    if (r.ok) posterBuffer = Buffer.from(await r.arrayBuffer());
  } catch {
    // Timed out, network error, or aborted -- fall through to the TMDB fallback below.
  }

  if (!posterBuffer && fallback) {
    try {
      const r2 = await fetchWithTimeout(fallback, FALLBACK_FETCH_TIMEOUT_MS);
      if (r2.ok) posterBuffer = Buffer.from(await r2.arrayBuffer());
    } catch {
      // no poster available at all
    }
  }

  if (!posterBuffer) {
    res.status(404).json({ err: 'poster not found' });
    return;
  }

  try {
    const out = await applyOverlays(posterBuffer, { rank: rankNum, statusLabel: ctx || null });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ err: String(e && e.message ? e.message : e) });
  }
});