// api/manifest.js
// /manifest.json (and /stremio/manifest.json): two catalogs plus a fallback meta resource.

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

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(manifest));
});
