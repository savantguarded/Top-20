// api/manifest.js
// Served at /manifest.json (see vercel.json rewrite).
// Stremio addon manifest describing the two catalogs, plus a fallback `meta` resource (see
// lib/meta.js / api/meta.js) for when the primary meta addon has no data for a title.

const { withCors } = require('../lib/cors');

module.exports = withCors((req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `https://${host}`;

  const manifest = {
    id: 'com.charles.topchartstoday',
    version: '1.2.0',
    name: 'Top Charts Today',
    description:
      'Top 20 movies (digital/home release only) and top 20 shows, ranked daily via TMDB, US region. ' +
      'Created by Charles. ' +
      'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    logo: `${base}/icon.png`,
    // 'catalog' applies to both catalogs above. The 'meta' resource object (own idPrefixes,
    // matching the top-level ones below) is a fallback only -- see lib/meta.js -- meant to be
    // tried after a real meta addon like aiometadata, not instead of one.
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    catalogs: [
      {
        type: 'movie',
        id: 'top-movies-today',
        name: 'Top Movies Today',
      },
      {
        type: 'series',
        id: 'top-shows-today',
        name: 'Top Shows Today',
      },
    ],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: false,
    },
  };

  // Manifest can be cached at the edge too, but keep it short since it rarely
  // needs to change and Stremio fetches it once per install/refresh.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(manifest));
});
