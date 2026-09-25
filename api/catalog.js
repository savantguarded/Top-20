// api/catalog.js
// /catalog/:type/:id.json -- the ranked list as Stremio meta previews (see vercel.json).
// Per item:
//  - poster:          portrait card from /poster (rank, status pill, art per Portrait art)
//  - landscapePoster: landscape card from /poster (art per Landscape art). Nuvio reads this
//                     first for landscape cards and draws nothing over it, so every mode ships
//                     its logo baked in.
//  - background:      clean TMDB backdrop, no overlays (full-screen backdrop in Wuplay, etc.)
//  - logo:            TMDB clearlogo, for clients that use it elsewhere
// Detail pages stay the metadata addon's job (and lib/meta.js as fallback).
// Edge-cached for an hour; tagged `catalog` so /backstage can drop it on save.

const crypto = require('crypto');
const { getTopMovies, getTopShows } = require('../lib/tmdb');
const { withCors } = require('../lib/cors');
const { getConfig, BETTER_POSTERS_URL } = require('../lib/config');

// Bump when the rendering changes, so clients re-fetch cards instead of reusing cached ones.
const RENDER_VERSION = 3;

const tag = (...parts) => crypto.createHash('sha1').update([RENDER_VERSION, ...parts].join('|')).digest('hex').slice(0, 8);

/** { src, img, lg } for the portrait card. Alternate falls back to TMDB's poster (no logo). */
function portraitArt(item, mode) {
  if (mode === 'betterposters' || mode === 'custom') return { src: mode, img: item.poster_path };
  if (mode === 'alternate' && item.textless_poster_path) return { src: 'tmdb', img: item.textless_poster_path, lg: item.logo_path };
  return { src: 'tmdb', img: item.poster_path };
}

/** { src, img, lg } for the landscape card. Default TMDB falls back to alternate + our logo. */
function landscapeArt(item, mode) {
  if (mode === 'custom') return { src: 'custom', img: item.backdrop_path };
  if (mode === 'tmdb' && item.logo_backdrop_path) return { src: 'tmdb', img: item.logo_backdrop_path };
  return { src: 'tmdb', img: item.backdrop_path, lg: item.logo_path };
}

function cardUrl(base, type, item, rank, art, extra) {
  if (!art.img && art.src === 'tmdb') return undefined; // providers may still have art for it
  const p = new URLSearchParams({ ...extra, src: art.src });
  if (art.img) p.set('img', art.img);
  if (art.lg) p.set('lg', art.lg);
  if (item.tmdbId) p.set('tmdb', item.tmdbId);
  if (item.context) p.set('ctx', item.context);
  return `${base}/poster/${type}/${item.imdbId}/${rank}.jpg?${p}`;
}

module.exports = withCors(async (req, res) => {
  const { type, id } = req.query;
  // 'tr' for the /stremio/ install (clears Stremio's own top-left watched checkmark).
  const corner = req.query.corner === 'tr' ? 'tr' : 'tl';

  let items;
  try {
    if (type === 'movie' && id === 'top-movies-today') items = await getTopMovies();
    else if (type === 'series' && id === 'top-shows-today') items = await getTopShows();
    else {
      res.status(404).json({ err: 'unknown catalog' });
      return;
    }
  } catch (e) {
    res.status(500).json({ err: String((e && e.message) || e) });
    return;
  }

  const cfg = await getConfig();
  const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const posterTemplate = { betterposters: BETTER_POSTERS_URL, custom: cfg.posterUrlTemplate }[cfg.posterArt] || '';
  const portraitTag = tag('portrait', cfg.posterArt, posterTemplate);
  const landscapeTag = tag('landscape', cfg.landscapeArt, cfg.landscapeArt === 'custom' ? cfg.backdropUrlTemplate : '');

  const metas = items.map((item, idx) => {
    const rank = idx + 1;
    const landscapePoster = cardUrl(base, type, item, rank, landscapeArt(item, cfg.landscapeArt), { shape: 'landscape', v: landscapeTag, corner });
    return {
      id: item.imdbId,
      type,
      name: item.name,
      releaseInfo: item.releaseInfo || undefined,
      poster: cardUrl(base, type, item, rank, portraitArt(item, cfg.posterArt), { v: portraitTag, corner }),
      posterShape: 'poster',
      background: item.main_backdrop_path ? `https://image.tmdb.org/t/p/original${item.main_backdrop_path}` : landscapePoster,
      landscapePoster,
      logo: item.logo_path ? `https://image.tmdb.org/t/p/w500${item.logo_path}` : undefined,
    };
  });

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=1200');
  res.setHeader('Vercel-Cache-Tag', 'catalog');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ metas }));
});
