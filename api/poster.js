// api/poster.js
// /poster/:type/:imdb/:rank.jpg -- renders one card image (see vercel.json, api/catalog.js).
// Query: shape (portrait|landscape), src (tmdb|betterposters|custom), img (TMDB image path:
// the base for src=tmdb, the fallback otherwise), lg (TMDB clearlogo path to draw), ctx (status
// label), corner (tl|tr), tmdb (TMDB id), v (cache tag, unused here).
// Provider sources fall back to TMDB's own image if they fail or are slow, so a card always renders.

const { applyOverlays } = require('../lib/badge');
const { withCors } = require('../lib/cors');
const { getConfig, BETTER_POSTERS_URL } = require('../lib/config');

// Well under vercel.json's 15s maxDuration, so our TMDB fallback always gets to run. (A timed-out
// image makes Nuvio/Stremio silently show another addon's art instead.)
const PROVIDER_TIMEOUT_MS = 8000;
const TMDB_TIMEOUT_MS = 5000;
const TMDB_IMG = { portrait: 'https://image.tmdb.org/t/p/w500', landscape: 'https://image.tmdb.org/t/p/w1280' };
const TMDB_PATH = /^\/[\w.-]+$/;

async function fetchImage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill a provider template. Order matters: key/id tokens that mention tmdb or mdblist are
 * matched before the generic "anything containing id" rule, which takes the imdb id (covers
 * {imdbId}, {id}, {imdb_id}, ...). Keys are filled server-side only, never sent to clients.
 */
function buildImageUrl(template, { imdbId, tmdbId, type, imagePath }) {
  return template
    .replace(/\{[^{}]*tmdb[^{}]*key[^{}]*\}/gi, () => encodeURIComponent(process.env.TMDB_API_KEY || ''))
    .replace(/\{[^{}]*mdblist[^{}]*\}/gi, () => encodeURIComponent(process.env.MDBLIST_API_KEY || ''))
    .replace(/\{[^{}]*tmdb[^{}]*id[^{}]*\}/gi, () => encodeURIComponent(tmdbId || ''))
    .replace(/\{[^{}]*backdrop[^{}]*\}/gi, () => imagePath || '')
    .replace(/\{[^{}]*type[^{}]*\}/gi, () => (type === 'series' ? 'tv' : 'movie'))
    .replace(/\{[^{}]*id[^{}]*\}/gi, () => encodeURIComponent(imdbId));
}

function providerTemplate(src, shape, cfg) {
  if (src === 'betterposters') return BETTER_POSTERS_URL;
  if (src === 'custom') return shape === 'landscape' ? cfg.backdropUrlTemplate : cfg.posterUrlTemplate;
  return null;
}

module.exports = withCors(async (req, res) => {
  const q = req.query;
  if (!q.imdb) {
    res.status(400).json({ err: 'missing imdb id' });
    return;
  }
  const shape = q.shape === 'landscape' ? 'landscape' : 'portrait';
  const corner = q.corner === 'tr' ? 'tr' : 'tl';
  const rank = Math.max(1, parseInt(q.rank, 10) || 1);
  // Legacy URLs (catalogs still cached on a client from before this scheme): bp/art/fallback.
  const img = q.img || q.bp || (q.fallback || '').replace(/^https:\/\/image\.tmdb\.org\/t\/p\/\w+/, '');
  const src = q.src || q.art || (shape === 'portrait' ? 'custom' : 'tmdb');

  const cfg = await getConfig();
  const template = providerTemplate(src, shape, cfg);
  let image = null;
  if (template) {
    image = await fetchImage(buildImageUrl(template, { imdbId: q.imdb, tmdbId: q.tmdb, type: q.type, imagePath: img }), PROVIDER_TIMEOUT_MS);
  }
  if (!image && TMDB_PATH.test(img)) image = await fetchImage(TMDB_IMG[shape] + img, TMDB_TIMEOUT_MS);
  if (!image) {
    res.status(404).json({ err: 'image not found' });
    return;
  }

  const logo = q.lg && TMDB_PATH.test(q.lg) ? await fetchImage(`https://image.tmdb.org/t/p/w500${q.lg}`, TMDB_TIMEOUT_MS) : null;

  try {
    const out = await applyOverlays(image, {
      rank,
      statusLabel: q.ctx || null,
      corner,
      shape,
      logo,
      // Portrait: vignette only on TMDB art (providers style their own). Landscape: always.
      vignette: shape === 'landscape' || src === 'tmdb',
    });
    res.setHeader('Content-Type', 'image/jpeg');
    // A day: card URLs already change with every rank, label or art-setting change (catalog `v`
    // tag), so the same URL always means the same image. Only re-render when one is new.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=3600');
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ err: String((e && e.message) || e) });
  }
});
