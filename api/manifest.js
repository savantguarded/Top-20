// api/manifest.js
// Served at /manifest.json (see vercel.json rewrite).
// Stremio addon manifest describing the two catalogs.

module.exports = (req, res) => {
  const manifest = {
    id: 'com.charles.topchartstoday',
    version: '1.0.0',
    name: 'Top Charts Today',
    description: 'Top 20 movies (digital/home release only) and top 20 shows, ranked daily via TMDB, US region.',
    resources: ['catalog'],
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
};
