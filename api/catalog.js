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
    const qs = params.toString();
    return {
      id: item.imdbId,
      type,
      name: item.name,
      releaseInfo: item.releaseInfo || undefined,
      poster: `${base}/poster/${type}/${item.imdbId}/${rank}.jpg${qs ? `?${qs}` : ''}`,
      posterShape: 'poster',
      // Plain TMDB backdrop, no overlay -- unlike `poster`, this is never run through
      // our badge/pill compositing. Confirmed against Nuvio's own source
      // (HomeCatalogSection.kt / HomeHeroSection.kt): when a catalog entry has no
      // `background` (or `banner`), Nuvio's home-screen hero carousel and any
      // landscape-mode catalog card fall back to rendering `poster` at hero width/
      // aspect ratio instead. Since our `poster` has the rank badge burned into the
      // top-left corner, that fallback was blowing the badge number up into a huge,
      // wrong-looking "background" -- that's what was actually clashing, not a race
      // with aiometadata (this field is only read by Nuvio's catalog-preview parser,
      // never by its meta-detail parser, so it can't compete with aiometadata's own
      // per-title background on the actual detail page -- that stays 100% aiometadata's).
      background: item.backdrop_path
        ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`
        : undefined,
      // Deliberately otherwise a minimal Stremio "meta preview" object: id, type, name,
      // poster, background, releaseInfo. Earlier versions also sent description/genres/
      // imdbRating/runtime here so Nuvio would have something to show even without a
      // separate meta addon -- removed so aiometadata stays the sole source for those
      // on the actual detail page.
    };
  });

  // 1-hour edge cache, background revalidation, zero maintenance.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=1200');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ metas }));
});
