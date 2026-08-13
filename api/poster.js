// api/poster.js
// Served at /poster/:type/:imdb/:rank.jpg (see vercel.json rewrite -> ?type=&imdb=&rank=).
// Fetches the base poster from btttr.cc (imdb-keyed), falls back to TMDB's own
// poster if that source doesn't have the title, overlays the glossy rank badge in the
// top-left corner, the primary streaming provider's logo in the top-right corner (passed
// in via ?providerLogo=, an image.tmdb.org URL built in lib/tmdb.js), and a bottom status
// pill (e.g. "Just Added", "Now on Blu-ray", passed in via ?ctx=), then returns a cached
// JPEG.

const { applyOverlays } = require('../lib/badge');
const { withCors } = require('../lib/cors');

function posterUrl(imdbId) {
  return `https://btttr.cc/poster-n/imdb/poster-default/${imdbId}.jpg?tag=none`;
}

// Provider logos only ever come from image.tmdb.org (we build the URL ourselves in
// lib/tmdb.js and pass it through as a query param) -- pinned here so this endpoint can't
// be made to fetch an arbitrary attacker-supplied image URL.
const ALLOWED_LOGO_HOST = 'image.tmdb.org';

async function fetchProviderLogo(logoUrl) {
  if (!logoUrl) return null;
  try {
    const parsed = new URL(logoUrl);
    if (parsed.hostname !== ALLOWED_LOGO_HOST) return null;
    const r = await fetch(parsed.toString());
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null; // missing/broken logo shouldn't fail the whole poster
  }
}

module.exports = withCors(async (req, res) => {
  const { imdb, rank, fallback, ctx, providerLogo } = req.query;
  const rankNum = Math.max(1, parseInt(rank, 10) || 1);

  if (!imdb) {
    res.status(400).json({ err: 'missing imdb id' });
    return;
  }

  let posterBuffer = null;

  try {
    const r = await fetch(posterUrl(imdb));
    if (r.ok) posterBuffer = Buffer.from(await r.arrayBuffer());
  } catch {
    // fall through to fallback
  }

  if (!posterBuffer && fallback) {
    try {
      const r2 = await fetch(fallback);
      if (r2.ok) posterBuffer = Buffer.from(await r2.arrayBuffer());
    } catch {
      // no poster available at all
    }
  }

  if (!posterBuffer) {
    res.status(404).json({ err: 'poster not found' });
    return;
  }

  try {
    const providerLogoBuffer = await fetchProviderLogo(providerLogo);
    const out = await applyOverlays(posterBuffer, {
      rank: rankNum,
      statusLabel: ctx || null,
      providerLogoBuffer,
    });
    res.setHeader('Content-Type', 'image/jpeg');
    // Matches the 1-hour catalog refresh cadence; stays servable well past that if TMDB/btttr.cc hiccup.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ err: String(e && e.message ? e.message : e) });
  }
});
