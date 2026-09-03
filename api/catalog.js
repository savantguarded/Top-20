// api/catalog.js
// Served at /catalog/:type/:id.json (see vercel.json rewrite -> ?type=&id=).
// Builds the top-20 list from TMDB and returns a minimal Stremio "meta preview"
// per item -- id, type, name, poster, background, releaseInfo -- and lets
// Vercel's edge cache hold the response for 1 hour so it refreshes itself with
// no cron job or database needed.
//
// Deliberately does NOT include description/genres/imdbRating/runtime/logo --
// this addon only declares `resources: ['catalog']` (api/manifest.js), so those
// stay aiometadata's job on the real detail page. `background` (a plain TMDB
// backdrop, no overlay) exists specifically so Nuvio's home-screen hero carousel
// and landscape-mode catalog cards have a real image to show -- without it they
// fall back to `poster`, which has the rank badge burned into the top-left
// corner and looked wrong blown up to hero size (confirmed against Nuvio's own
// source: HomeCatalogParser.kt reads background/banner, HomeHeroSection.kt falls
// back to poster when both are absent). Full history in the project's progress log.

const crypto = require('crypto');
const { getTopMovies, getTopShows } = require('../lib/tmdb');
const { withCors } = require('../lib/cors');
const { getConfig } = require('../lib/config');

module.exports = withCors(async (req, res) => {
  const { type, id } = req.query;
  // Which corner the rank badge renders in on this catalog's posters -- 'tl' (default) for
  // the original Nuvio install, 'tr' for the /stremio/ install (see vercel.json), which avoids
  // colliding with Stremio's own top-left "watched" checkmark overlay. Threaded onto every
  // poster URL below so api/poster.js knows which corner to draw, and so the two flavors get
  // separate edge cache entries instead of one flavor's cached poster leaking into the other.
  const corner = req.query.corner === 'tr' ? 'tr' : 'tl';

  let items;
  try {
    if (type === 'movie' && id === 'top-movies-today') {
      items = await getTopMovies();
    } else if (type === 'series' && id === 'top-shows-today') {
      items = await getTopShows();
    } else {
      res.status(404).json({ err: 'unknown catalog' });
      return;
    }
  } catch (e) {
    res.status(500).json({ err: String(e && e.message ? e.message : e) });
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `https://${host}`;

  // api/poster.js is cached at Vercel's edge for up to an hour, keyed by its full request
  // URL -- and that URL is otherwise identical (same type/imdb/rank) no matter which poster
  // provider is configured. Without something to change in the URL, swapping providers via
  // /config wouldn't show up for real users until each already-cached poster URL happened to
  // fall out of cache on its own, up to an hour+ later. `pv` (poster version) is a short tag
  // derived from the current posterUrlTemplate, included on every poster URL this endpoint
  // hands out -- so the moment the template changes, every poster URL changes too, and the
  // edge cache treats them as brand new (never-cached) requests instead of serving stale art.
  const cfg = await getConfig();
  const posterTag = crypto.createHash('sha1').update(cfg.posterUrlTemplate || '').digest('hex').slice(0, 8);

  const metas = items.map((item, idx) => {
    const rank = idx + 1;
    const params = new URLSearchParams();
    params.set('pv', posterTag);
    params.set('corner', corner);
    // Threaded through so api/poster.js can fill TMDB-id-keyed provider templates (e.g.
    // Posters+), which need the numeric TMDB id, not just the imdb_id every provider so far
    // has taken. Harmless/unused for imdb-only templates like btttr.cc or XRDB.
    if (item.tmdbId) {
      params.set('tmdb', item.tmdbId);
    }
    if (item.poster_path) {
      params.set('fallback', `https://image.tmdb.org/t/p/w500${item.poster_path}`);
    }
    if (item.context) {
      params.set('ctx', item.context);
    }
    return {
      id: item.imdbId,
      type,
      name: item.name,
      releaseInfo: item.releaseInfo || undefined,
      poster: `${base}/poster/${type}/${item.imdbId}/${rank}.jpg?${params.toString()}`,
      posterShape: 'poster',
      background: item.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`
        : undefined,
    };
  });

  // 1-hour edge cache, background revalidation, zero maintenance.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=1200');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ metas }));
});
