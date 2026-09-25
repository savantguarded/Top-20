// api/meta.js
// /meta/:type/:id.json (and /stremio/meta/...): fallback TMDB meta, see lib/meta.js.

const { fetchMeta } = require('../lib/meta');
const { withCors } = require('../lib/cors');

module.exports = withCors(async (req, res) => {
  const { type, id } = req.query;

  if (!id || (type !== 'movie' && type !== 'series')) {
    res.status(200).json({ meta: null });
    return;
  }

  let meta;
  try {
    meta = await fetchMeta(type, id);
  } catch (e) {
    res.status(500).json({ err: String(e && e.message ? e.message : e) });
    return;
  }

  // `{ meta: null }` with 200 (not 404) is the addon-protocol way to say "no data for this id".
  res.setHeader('Cache-Control', meta
    ? 'public, max-age=0, s-maxage=21600, stale-while-revalidate=3600'
    : 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ meta: meta || null }));
});
