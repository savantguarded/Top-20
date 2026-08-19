// api/poster.js
// Served at /poster/:type/:imdb/:rank.jpg (see vercel.json rewrite -> ?type=&imdb=&rank=).
// Fetches the base poster from the configured provider (imdb-keyed URL template, see
// lib/config.js -- swap providers there or live via /config or Edge Config, no code change,
// no redeploy), falls back to TMDB's own poster if that source doesn't have the title or
// is too slow to answer, overlays the glossy rank badge in the top-left corner plus a
// bottom status pill (e.g. "Just Added", "New Episode", passed in via ?ctx=), and returns
// a cached JPEG.

const { applyOverlays } = require('../lib/badge');
const { withCors } = require('../lib/cors');
const { getConfig } = require('../lib/config');

// vercel.json caps this function at maxDuration: 15s. A slow/hanging provider must not be
// allowed to burn that whole budget -- if it did, Vercel would kill the function outright
// with a platform-level timeout instead of our own graceful TMDB fallback below, and (worse,
// this is what actually happened investigating a user report) Stremio/Nuvio clients can react
// to a failed/timed-out poster request by silently substituting a *different* installed
// addon's plain artwork for the same title, which looks indistinguishable from "the poster
// provider setting did nothing." Giving up on the primary provider well before the function's
// own deadline guarantees our own fallback always gets a chance to run instead.
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

/** Fill the imdb id into the configured template. Accepts either `{imdbId}` (documented,
 * matches this addon's own README/config-page hint) or `{id}` (what several third-party
 * poster services use in their own docs, e.g. RPDB-style or custom providers) -- a user
 * pasting a provider's own example URL verbatim is exactly as likely to use one as the
 * other, so both are honored rather than silently doing nothing on a mismatch. */
function buildPosterUrl(template, imdbId) {
  const encoded = encodeURIComponent(imdbId);
  return template.replace(/\{imdbId\}/g, encoded).replace(/\{id\}/g, encoded);
}

module.exports = withCors(async (req, res) => {
  const { imdb, rank, fallback, ctx } = req.query;
  const rankNum = Math.max(1, parseInt(rank, 10) || 1);

  if (!imdb) {
    res.status(400).json({ err: 'missing imdb id' });
    return;
  }

  const cfg = await getConfig();
  let posterBuffer = null;

  try {
    const r = await fetchWithTimeout(buildPosterUrl(cfg.posterUrlTemplate, imdb), PRIMARY_FETCH_TIMEOUT_MS);
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
    // Matches the 1-hour catalog refresh cadence; stays servable well past that if the
    // poster provider or TMDB hiccups.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ err: String(e && e.message ? e.message : e) });
  }
});
