// api/poster.js
// Served at /poster/:type/:imdb/:rank.jpg?tmdb=&pv=&corner=&... (see vercel.json rewrite and
// api/catalog.js, which adds tmdb/pv/fallback/ctx/corner as query params).
// Fetches the base poster from the configured provider (URL template, see lib/config.js --
// swap providers there or live via /config or Edge Config, no code change, no redeploy),
// falls back to TMDB's own poster if that source doesn't have the title or is too slow to
// answer, overlays the glossy rank badge (top-left for the original /manifest.json install,
// top-right for the /stremio/manifest.json install -- see ?corner=) plus a bottom status pill
// (e.g. "Just Added", "New Episode", passed in via ?ctx=), and returns a cached JPEG.

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

function tmdbApiKey() {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY environment variable is not set');
  return key;
}

// TMDB's own convention is "movie"/"tv". Our URLs use Stremio's convention ("movie"/
// "series") for the :type path segment, so a provider template using TMDB's own {type}
// needs the translated value, not the raw Stremio one.
function tmdbType(stremioType) {
  return stremioType === 'series' ? 'tv' : 'movie';
}

/** Fill provider-specific placeholders into the configured template.
 *
 * Originally only needed to fill the imdb id -- accepted `{imdbId}` or `{id}` at first, then
 * a real user pasted `{imdb_id}` (underscore) from a provider's own docs, which matched
 * neither, so nothing got substituted, the request hit a broken literal URL, and (with no
 * error surfaced anywhere) it silently looked identical to "the provider is down" -- fell
 * straight through to the TMDB fallback. Rather than keep whack-a-moling individual
 * spellings, that generic rule replaces ANY `{...}` token containing "id" (case-insensitive)
 * with the imdb id -- covers `{imdbId}`, `{id}`, `{imdb_id}`, `{IMDB_ID}`, `{ImdbID}`, etc.
 *
 * Posters+ needs three more things filled into a single template: the numeric TMDB id
 * (`{tmdb_id}`), the TMDB-style type (`{type}` -- translated via tmdbType() above, not
 * passed through raw), and this server's own TMDB API key (`{tmdb_key}`, so Posters+ can
 * call TMDB on our behalf). All three are matched and replaced BEFORE the generic imdb-id
 * rule runs, since `{tmdb_id}` and `{tmdb_key}` both also contain the substring "id"/"key"
 * -- if the generic rule ran first it would stuff the imdb id into `{tmdb_id}` instead.
 * `{tmdb_key}` never leaves this server: it's filled into the *upstream* request api/poster.js
 * itself makes, never into anything Stremio/Nuvio's own client ever sees.
 */
function buildPosterUrl(template, { imdbId, tmdbId, type }) {
  return template
    .replace(/\{[^{}]*tmdb[^{}]*key[^{}]*\}/gi, () => encodeURIComponent(tmdbApiKey()))
    .replace(/\{[^{}]*tmdb[^{}]*id[^{}]*\}/gi, () => encodeURIComponent(tmdbId || ''))
    .replace(/\{[^{}]*type[^{}]*\}/gi, () => encodeURIComponent(tmdbType(type)))
    .replace(/\{[^{}]*id[^{}]*\}/gi, () => encodeURIComponent(imdbId));
}

module.exports = withCors(async (req, res) => {
  const { type, imdb, tmdb, rank, fallback, ctx, corner } = req.query;
  const rankNum = Math.max(1, parseInt(rank, 10) || 1);
  // 'tl' (top-left, original) unless the /stremio/ manifest flavor asked for 'tr' -- see
  // api/catalog.js, which sets this on every poster URL it hands out.
  const badgeCorner = corner === 'tr' ? 'tr' : 'tl';

  if (!imdb) {
    res.status(400).json({ err: 'missing imdb id' });
    return;
  }

  const cfg = await getConfig();
  let posterBuffer = null;

  try {
    const url = buildPosterUrl(cfg.posterUrlTemplate, { imdbId: imdb, tmdbId: tmdb, type });
    const r = await fetchWithTimeout(url, PRIMARY_FETCH_TIMEOUT_MS);
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
    const out = await applyOverlays(posterBuffer, { rank: rankNum, statusLabel: ctx || null, corner: badgeCorner });
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
