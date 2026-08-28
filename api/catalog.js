// api/catalog.js
// Served at /catalog/:type/:id.json (see vercel.json rewrite -> ?type=&id=).

const crypto = require('crypto');
const { getTopMovies, getTopShows } = require('../lib/tmdb');
const { withCors } = require('../lib/cors');
const { getConfig } = require('../lib/config');

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

  const cfg = await getConfig();
  const posterTag = crypto.createHash('sha1').update(cfg.posterUrlTemplate || '').digest('hex').slice(0, 8);

  const metas = items.map((item, idx) => {
    const rank = idx + 1;
    const params = new URLSearchParams();
    params.set('pv', posterTag);
    if (item.tmdbId) {
      params.set('tmdbId', item.tmdbId);
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

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=1200');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ metas }));
});