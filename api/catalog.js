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

const { getTopMovies, getTopShows } = require('../lib/tmdb');
const { withCors } = require('../lib/cors');

module.exports = withCors(async (req, res) => {
  const { type, id } = req.query;

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

  const metas = items.map((item, idx) => {
    const rank = idx + 1;
    const params = new URLSearchParams();
    if (item.poster_path) {
      params.set('fallback', `https://image.tmdb.org/t/p/w500${item.poster_path}`);
    }
    if (item.context) {
      params.set('ctx', item.context);
    }
    const qs = params.toString();
    return {
      id: item.imdbId,
      type,
      name: item.name,
      releaseInfo: item.releaseInfo || undefined,
      poster: `${base}/poster/${type}/${item.imdbId}/${rank}.jpg${qs ? `?${qs}` : ''}`,
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
