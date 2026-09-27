// api/manifest.js
// /manifest.json: two catalogs plus a fallback meta resource.
// /landscape/manifest.json: same catalogs with wide cards in Nuvio. It keeps its own id so it
// installs alongside the portrait one; the name and everything else are identical.
// Catalog names and order come from /backstage (cfg.catalogs). Tagged `catalog` so a save there
// drops this too.

const { withCors } = require('../lib/cors');
const { getConfig, CATALOGS } = require('../lib/config');

module.exports = withCors(async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `https://${host}`;
  const landscape = req.query.layout === 'landscape';
  const cfg = await getConfig();

  const manifest = {
    id: landscape ? 'com.charles.topchartstoday.landscape' : 'com.charles.topchartstoday',
    version: '1.3.0',
    name: 'Daily Charts',
    description:
      'Top 20 movies (digital/home release only) and top 20 shows, ranked daily via TMDB, US region. ' +
      'Created by Charles. ' +
      'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    logo: `${base}/icon.png`,
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    catalogs: cfg.catalogs.map(({ id, name }) => ({ type: CATALOGS.find((c) => c.id === id).type, id, name })),
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: false,
    },
  };

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600');
  res.setHeader('Vercel-Cache-Tag', 'catalog');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(manifest));
});
