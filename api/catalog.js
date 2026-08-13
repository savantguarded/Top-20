// api/catalog.js
// Served at /catalog/:type/:id.json (see vercel.json rewrite -> ?type=&id=).
// Builds the top-20 list from TMDB, points each poster at our own /poster
// endpoint (which overlays the rank badge and status pill), and lets Vercel's
// edge cache hold the response for 1 hour so it refreshes itself with no
// cron job or database needed.

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
    if (item.provider && item.provider.logo) {
      params.set('providerLogo', item.provider.logo);
    }
    const qs = params.toString();
    return {
      id: item.imdbId,
      type,
      name: item.name,
      releaseInfo: item.releaseInfo || undefined,
      poster: `${base}/poster/${type}/${item.imdbId}/${rank}.jpg${qs ? `?${qs}` : ''}`,
      posterShape: 'poster',
      // Populated straight from the TMDB details we already fetched while resolving this
      // item (see resolveMovie/resolveShow in lib/tmdb.js), so Nuvio has full metadata
      // immediately instead of depending on a separate meta addon resolving in time.
      description: item.description || undefined,
      genres: item.genres && item.genres.length ? item.genres : undefined,
      imdbRating: item.imdbRating || undefined,
      runtime: item.runtime || undefined,
    };
  });

  // 1-hour edge cache, background revalidation, zero maintenance.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=1200');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ metas }));
});
