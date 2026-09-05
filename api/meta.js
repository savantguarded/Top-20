// api/meta.js
// Served at /meta/:type/:id.json (see vercel.json rewrite). Also reachable as
// /stremio/meta/:type/:id.json for the Stremio-flavored install -- Stremio/Nuvio derive a
// resource's request URL from whatever prefix precedes manifest.json, not from anything in
// the manifest body (same reasoning as the /stremio/catalog/... rewrite already has).
//
// A fallback meta resource, built from TMDB, for when the primary meta addon (aiometadata)
// has no data for a title. Nuvio and Stremio only reach a second meta-declaring addon once
// every addon ahead of it in the user's install order has already returned nothing for that
// same id -- see lib/meta.js for the full reasoning, and the project's progress log
// (Session 14/15) for the research trail.
//
// Keep this addon listed AFTER aiometadata in Nuvio's/Stremio's own addon order so it's only
// ever tried as the fallback, never racing it as a competing primary.

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

  // No TMDB match either -- genuinely nothing to offer. 200 with an empty `meta` rather than
  // a 404: Stremio addons use a 404 for "this route doesn't exist", not "no result for this
  // id" (see Docs/Stremio addons refer/api/responses/meta.md), and Nuvio's own meta-fetch
  // code (MetaDetailsRepository.tryFetchMeta) already treats a parse failure the same as a
  // network failure -- an explicit `{ meta: null }` keeps this addon a well-behaved no-op
  // rather than something that looks broken to other clients.
  res.setHeader('Cache-Control', meta
    ? 'public, max-age=0, s-maxage=21600, stale-while-revalidate=3600'
    : 'public, max-age=0, s-maxage=300, stale-while-revalidate=60');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ meta: meta || null }));
});
