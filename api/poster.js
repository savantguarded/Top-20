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

/** Fill the configured template's placeholders from the request context. Started out only
 * substituting the imdb id (matching ANY `{...}` token containing "id" -- covers `{imdbId}`,
 * `{id}`, `{imdb_id}`, etc). Providers like postersplus.stremio.ru need more than that: a
 * separate TMDB numeric id, the media type, and server-side API keys the provider uses to
 * look up its own ratings/quality data. Same permissive philosophy as before, just with more
 * token families -- checked in an order where the more specific ones (tmdb id, tmdb key,
 * mdblist key) are matched before the generic "contains id" fallback, so `{tmdb_id}` doesn't
 * get swallowed by the imdb-id rule. Any placeholder that matches nothing is left untouched
 * rather than guessed at.
 *
 * Keys are substituted here, server-side, at fetch time -- never baked into the
 * `posterUrlTemplate` string itself (which only ever lives in Edge Config / the /config page)
 * and never appear in the poster URLs handed to Stremio/Nuvio clients in api/catalog.js. */
function buildPosterUrl(template, { imdbId, tmdbId, type }) {
  const tmdbKey = process.env.TMDB_API_KEY || '';
  const mdblistKey = process.env.MDBLIST_API_KEY || '';
  return template.replace(/\{([^{}]+)\}/g, (full, token) => {
    const t = token.toLowerCase();
    if (t.includes('tmdb') && t.includes('id')) return encodeURIComponent(tmdbId != null ? tmdbId : '');
    if (t.includes('tmdb') && t.includes('key')) return encodeURIComponent(tmdbKey);
    if (t.includes('mdblist') && t.includes('key')) return encodeURIComponent(mdblistKey);
    if (t.includes('type')) return encodeURIComponent(type || '');
    if (t.includes('id')) return encodeURIComponent(imdbId || '');
    return full; // unrecognized placeholder -- leave it as-is rather than guess
  });
}

module.exports = withCors(async (req, res) => {
  const { imdb, tmdbId, type, rank, fallback, ctx } = req.query;
  const rankNum = Math.max(1, parseInt(rank, 10) || 1);

  if (!imdb) {
    res.status(400).json({ err: 'missing imdb id' });
    return;
  }

  const cfg = await getConfig();
  let posterBuffer = null;

  try {
    const providerUrl = buildPosterUrl(cfg.posterUrlTemplate, { imdbId: imdb, tmdbId, type });
    const r = await fetchWithTimeout(providerUrl, PRIMARY_FETCH_TIMEOUT_MS);
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
    // Deliberately much shorter than api/catalog.js's own 1-hour cache. The catalog listing
    // (which titles are in the Top 20, their rank order) is meant to only change on that slow
    // hourly cadence -- but a poster provider swap via /config should be visible on its own,
    // fast timeline, independent of when the catalog next refreshes. Since a client's already-
    // cached catalog.json can keep pointing at the exact same poster URL for up to that full
    // hour (see api/catalog.js's `pv` tag, which only changes when the catalog itself
    // regenerates), this endpoint's own cache is what actually controls how fast a provider
    // change reaches real users: at 60s, an edited posterUrlTemplate shows up in freshly-
    // requested posters within about a minute, not up to a day. stale-while-revalidate gives a
    // short grace window so a burst of requests for the same poster doesn't all re-fetch from
    // the provider at once. Cheap to keep this short -- worst case is one re-fetch per unique
    // poster URL per minute, not per request.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ err: String(e && e.message ? e.message : e) });
  }
});