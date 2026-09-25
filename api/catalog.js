// api/catalog.js
// Served at /catalog/:type/:id.json (see vercel.json rewrite -> ?type=&id=).
// Builds the top-20 list from TMDB and returns a minimal Stremio "meta preview"
// per item -- id, type, name, poster, background, releaseInfo -- and lets
// Vercel's edge cache hold the response for 1 hour so it refreshes itself with
// no cron job or database needed.
//
// Deliberately does NOT include description/genres/imdbRating/runtime/logo --
// this addon only declares `resources: ['catalog']` (api/manifest.js), so those
// stay aiometadata's job on the real detail page. `background` exists specifically
// so Nuvio's home-screen hero carousel and landscape-mode catalog cards have a real
// image to show -- without it they fall back to `poster`, which has the rank badge
// burned into the top-left corner and looked wrong blown up to hero size (confirmed
// against Nuvio's own source: HomeCatalogParser.kt reads background/banner,
// HomeHeroSection.kt falls back to poster when both are absent).
//
// `background` now carries the same rank badge + status pill as `poster` does, just
// laid out for a wide frame (pill flush to the TOP edge instead of the bottom -- see
// lib/badge.js) -- it's no longer a plain, unbadged TMDB backdrop. Routed through the
// same /poster/... endpoint as `poster`, with `shape=landscape` and `bp=` (TMDB's
// backdrop_path) telling api/poster.js which image source and layout to use.
//
// Update: the edited landscape card now goes in `landscapePoster` (a Nuvio field, read first for
// landscape cards -- NuvioTV ModernHomeRows.kt), and `background` is a CLEAN, unbadged TMDB
// backdrop. Clients without `landscapePoster` support (e.g. Wuplay) use `background` as their
// full-screen backdrop, so they were showing our badged card blown up. Now backdrop and
// landscape card are separate images everywhere: backdrop = top-voted textless main art,
// card = the distinct alternate from lib/art.js with rank/pill/vignette.
//
// `logo` (TMDB clearlogo) is sent too: Nuvio TV draws it over landscape cards itself, and
// only fetches one lazily near focus if the catalog doesn't supply it. Because Nuvio adds
// its own logo, the landscape base image must stay logo-free (bp is a textless backdrop,
// see lib/tmdb.js) or the logo doubles up. Full history in the project's progress log.

const crypto = require('crypto');
const { getTopMovies, getTopShows } = require('../lib/tmdb');
const { withCors } = require('../lib/cors');
const { getConfig } = require('../lib/config');

module.exports = withCors(async (req, res) => {
  const { type, id } = req.query;
  // Which corner the rank badge renders in on this catalog's posters -- 'tl' (default) for
  // the original Nuvio install, 'tr' for the /stremio/ install (see vercel.json), which avoids
  // colliding with Stremio's own top-left "watched" checkmark overlay. Threaded onto every
  // poster URL below so api/poster.js knows which corner to draw, and so the two flavors get
  // separate edge cache entries instead of one flavor's cached poster leaking into the other.
  const corner = req.query.corner === 'tr' ? 'tr' : 'tl';

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

  // api/poster.js is cached at Vercel's edge for up to an hour, keyed by its full request
  // URL -- and that URL is otherwise identical (same type/imdb/rank) no matter which poster
  // provider is configured. Without something to change in the URL, swapping providers via
  // /config wouldn't show up for real users until each already-cached poster URL happened to
  // fall out of cache on its own, up to an hour+ later. `pv` (poster version) is a short tag
  // derived from the current posterUrlTemplate, included on every poster URL this endpoint
  // hands out -- so the moment the template changes, every poster URL changes too, and the
  // edge cache treats them as brand new (never-cached) requests instead of serving stale art.
  const cfg = await getConfig();
  const posterTag = crypto.createHash('sha1').update(cfg.posterUrlTemplate || '').digest('hex').slice(0, 8);
  // Same cache-busting idea as posterTag, but for the backdrop/landscape provider -- kept as
  // a SEPARATE tag so swapping one provider via /backstage doesn't needlessly invalidate the
  // other shape's already-cached poster URLs.
  // Landscape art mode (see lib/config.js). Legacy/unknown values read as 'alternate'.
  const artMode = ['tmdb-logo', 'alternate', 'custom'].includes(cfg.landscapeArt) ? cfg.landscapeArt : 'alternate';
  // The mode is part of the tag, so switching modes gives every card a fresh URL too. v2 marks
  // the logo/vignette render change so already-cached old cards aren't reused.
  const backdropTag = crypto.createHash('sha1')
    .update(`v2|${artMode}|${artMode === 'custom' ? cfg.backdropUrlTemplate || '' : ''}`)
    .digest('hex').slice(0, 8);

  const metas = items.map((item, idx) => {
    const rank = idx + 1;
    const params = new URLSearchParams();
    params.set('pv', posterTag);
    params.set('corner', corner);
    // Threaded through so api/poster.js can fill TMDB-id-keyed provider templates (e.g.
    // Posters+), which need the numeric TMDB id, not just the imdb_id every provider so far
    // has taken. Harmless/unused for imdb-only templates like btttr.cc or XRDB.
    if (item.tmdbId) {
      params.set('tmdb', item.tmdbId);
    }
    if (item.poster_path) {
      params.set('fallback', `https://image.tmdb.org/t/p/w500${item.poster_path}`);
    }
    if (item.context) {
      params.set('ctx', item.context);
    }

    // `landscapePoster`: same rank badge + status pill as `poster`, laid out for a wide frame
    // (see lib/badge.js's shape='landscape' branch, which also adds the corner vignette),
    // routed through the same /poster/... endpoint. Only set when TMDB has a backdrop.
    // Which base image, and whether we draw the clearlogo onto it:
    //  - tmdb-logo: TMDB backdrop with the logo already in it; no drawn logo. If TMDB has none,
    //    fall back to the alternate + drawn logo so the card is never logo-less.
    //  - alternate: clean textless alternate + drawn logo.
    //  - custom: provider template (brings its own logo); no drawn logo.
    let cardPath = item.backdrop_path;
    let drawLogo = artMode === 'alternate';
    if (artMode === 'tmdb-logo') {
      if (item.logo_backdrop_path) cardPath = item.logo_backdrop_path;
      else drawLogo = true;
    }

    let landscapePoster;
    if (cardPath) {
      const bgParams = new URLSearchParams();
      bgParams.set('shape', 'landscape');
      bgParams.set('pv', backdropTag);
      bgParams.set('art', artMode === 'custom' ? 'custom' : 'tmdb');
      bgParams.set('corner', corner);
      bgParams.set('bp', cardPath);
      if (drawLogo && item.logo_path) bgParams.set('lg', item.logo_path);
      if (item.tmdbId) {
        bgParams.set('tmdb', item.tmdbId);
      }
      if (item.context) {
        bgParams.set('ctx', item.context);
      }
      landscapePoster = `${base}/poster/${type}/${item.imdbId}/${rank}.jpg?${bgParams.toString()}`;
    }

    return {
      id: item.imdbId,
      type,
      name: item.name,
      releaseInfo: item.releaseInfo || undefined,
      poster: `${base}/poster/${type}/${item.imdbId}/${rank}.jpg?${params.toString()}`,
      posterShape: 'poster',
      // Clean backdrop, no overlays. Falls back to the card art only if TMDB has no main one.
      background: item.main_backdrop_path
        ? `https://image.tmdb.org/t/p/original${item.main_backdrop_path}`
        : landscapePoster,
      landscapePoster,
      // TMDB clearlogo. Nuvio TV draws this over landscape cards; without it in the catalog,
      // Nuvio only fetches a logo for items near focus, so logos popped in late. See
      // pickLogo() in lib/tmdb.js for the language/format preference.
      logo: item.logo_path ? `https://image.tmdb.org/t/p/w500${item.logo_path}` : undefined,
    };
  });

  // 1-hour edge cache, background revalidation, zero maintenance.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=1200');
  // Lets /backstage drop every cached catalog the moment settings are saved (api/config.js).
  res.setHeader('Vercel-Cache-Tag', 'catalog');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ metas }));
});
