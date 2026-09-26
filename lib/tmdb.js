// lib/tmdb.js
// TMDB data for the two catalogs:
//  - getTopMovies(): trending/movie/day, kept only if released digitally or physically in the
//    configured region, or if the digital release is inside the Coming Soon window.
//  - getTopShows(): trending/tv/day, kept only if it has aired, or premieres inside the
//    Coming Soon window (trending can surface shows on pre-release buzz alone).
// Every imdb_id is round-tripped through /find before it's trusted. Status labels and art are
// derived from the same details request (append_to_response), so one details call per title.
// collectUntilFilled() pages through trending until catalogSize titles pass, deduping by TMDB
// and imdb id (duplicate ids collapse to one tile in Stremio and eat the rest of the row).

const { getConfig } = require('./config');
const { applyDistinctBackdrops } = require('./art');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TVMAZE_BASE = 'https://api.tvmaze.com';
const TVMAZE_TIMEOUT_MS = 4000;

// All "today" math runs on the viewer's calendar, not UTC (labels flip at local midnight).
const TIMEZONE = 'Africa/Lagos';

function apiKey() {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY environment variable is not set');
  return key;
}

async function tmdbGet(pathname, params = {}) {
  const url = new URL(TMDB_BASE + pathname);
  url.searchParams.set('api_key', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`TMDB ${pathname} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** YYYY-MM-DD for an instant (default now) on the TIMEZONE calendar. */
function localISO(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

function todayISO() {
  return localISO();
}

// Whole days from dateStr to today (TIMEZONE calendar). Negative = future.
function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${todayISO()}T00:00:00Z`);
  if (Number.isNaN(then)) return Infinity;
  return Math.round((now - then) / 86400000);
}

function formatShortDate(dateStr) {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Page through a TMDB list until `targetCount` items resolve (or `maxPages`), in rank order. */
async function collectUntilFilled(pathname, resolveItem, targetCount, maxPages) {
  const passing = [];
  const seenRawIds = new Set();
  const seenImdbIds = new Set();
  let page = 1;
  let totalPages = Infinity;

  while (passing.length < targetCount && page <= totalPages && page <= maxPages) {
    const data = await tmdbGet(pathname, { page });
    totalPages = data.total_pages || page;
    const pageResults = data.results || [];
    if (!pageResults.length) break;

    const uniquePageResults = pageResults.filter((raw) => {
      if (seenRawIds.has(raw.id)) return false;
      seenRawIds.add(raw.id);
      return true;
    });

    const resolved = await Promise.all(uniquePageResults.map(resolveItem));
    for (const item of resolved) {
      if (passing.length >= targetCount) break;
      if (!item) continue;
      if (seenImdbIds.has(item.imdbId)) continue;
      seenImdbIds.add(item.imdbId);
      passing.push(item);
    }
    page += 1;
  }

  return passing.slice(0, targetCount);
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titlesRoughlyMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Containment covers subtitle/edition differences.
  return na.includes(nb) || nb.includes(na);
}

/** Non-English candidates need `minVoteCount` TMDB votes (filters small-fandom spikes). */
function passesLanguagePopularityGate(raw, minVoteCount) {
  if (raw.original_language === 'en') return true;
  return (raw.vote_count || 0) >= minVoteCount;
}

/** Confirm an imdb_id resolves back to the same TMDB id and a matching title via /find. */
async function verifyImdbMatch(tmdbId, imdbId, title, kind) {
  try {
    const found = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const bucket = kind === 'movie' ? found.movie_results : found.tv_results;
    if (!bucket || !bucket.length) return false;
    const match = bucket.find((r) => r.id === tmdbId);
    if (!match) return false;
    const matchTitle = kind === 'movie' ? match.title : match.name;
    return titlesRoughlyMatch(title, matchTitle);
  } catch {
    return false;
  }
}

/** Earliest past release date in `region` of TMDB release type (4 Digital, 5 Physical), or null. */
function regionReleaseDateByType(releaseDatesPayload, type, region) {
  const entry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === region
  );
  if (!entry) return null;
  const dates = (entry.release_dates || [])
    .filter((rd) => rd.type === type && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .filter((d) => daysSince(d) >= 0) // drop dates still in the future
    .sort();
  return dates[0] || null;
}

function regionDigitalReleaseDate(releaseDatesPayload, region) {
  return regionReleaseDateByType(releaseDatesPayload, 4, region);
}

function regionPhysicalReleaseDate(releaseDatesPayload, region) {
  return regionReleaseDateByType(releaseDatesPayload, 5, region);
}

/** Earliest FUTURE digital release date in `region`, or null (powers movie Coming Soon). */
function regionUpcomingDigitalReleaseDate(releaseDatesPayload, region) {
  const entry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === region
  );
  if (!entry) return null;
  const dates = (entry.release_dates || [])
    .filter((rd) => rd.type === 4 && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .filter((d) => daysSince(d) < 0) // keep only dates still in the future
    .sort();
  return dates[0] || null;
}

/** True if dateStr is a future date at most windowDays away from today. */
function isUpcomingWithin(dateStr, windowDays) {
  if (!dateStr) return false;
  const days = daysSince(dateStr);
  return days < 0 && Math.abs(days) <= windowDays;
}

/** A show qualifies once it has aired, or if its premiere is within the Coming Soon window. */
function isShowEligible(firstAirDate, comingSoonWindowDays) {
  if (!firstAirDate) return false;
  const days = daysSince(firstAirDate);
  if (days >= 0) return true;
  return Math.abs(days) <= comingSoonWindowDays;
}

/**
 * Movie label, in priority order: Now on Blu-ray (recent physical release, even long after
 * digital), Just Added, Now Streaming, Streaming <date> (only with no digital release yet: a
 * later second digital date, e.g. a streaming debut after PVOD, must not re-trigger it), else none.
 */
function computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate, movieCfg) {
  const blurayDays = daysSince(physicalReleaseDate);
  if (blurayDays >= 0 && blurayDays <= movieCfg.blurayWindowDays) return 'Now on Blu-ray';

  const days = daysSince(digitalReleaseDate);
  if (days <= movieCfg.justAddedWindowDays) return 'Just Added';
  if (days <= movieCfg.nowStreamingWindowDays) return 'Now Streaming';

  if (!digitalReleaseDate && isUpcomingWithin(upcomingDigitalReleaseDate, movieCfg.comingSoonWindowDays)) {
    return `Streaming ${formatShortDate(upcomingDigitalReleaseDate)}`;
  }

  return null;
}

/**
 * Show label, first match wins:
 *  - Premieres <date>: first episode not aired yet, premiere within the window.
 *  - New Season <date>: a season 2+ that hasn't aired yet, within the window (pre-release only).
 *  - Series Premiere / Season Premiere: on the premiere day itself only.
 *  - Series Finale / Season Finale / Airing Today: an episode airing today (today's episode may
 *    still sit in next_episode_to_air while TMDB catches up).
 *  - New Series / New Season: the rest of the recency window after a premiere. Beats aired
 *    finales, so a full-season drop (finale out on premiere day) reads New Season all week.
 *  - Season Finale <date>: the finale is upcoming within the window (next_episode_to_air).
 *    TMDB only flags a show Ended after its finale, so an upcoming one is always "Season".
 *  - Series Finale / Season Finale / New Episode: latest aired episode within the window.
 * Premiere dates come off the season (TMDB lags last_episode_to_air on full drops), or off its
 * episode 1 when that is at hand, since those dates are localized (localizeEpisodeDates).
 */
function computeShowContext(details, showCfg) {
  const seasons = (details.seasons || []).filter((s) => s.season_number > 0);
  const { last_episode_to_air: last, next_episode_to_air: next } = details;

  if (details.first_air_date) {
    const premiereDays = daysSince(details.first_air_date);
    if (premiereDays < 0) {
      return Math.abs(premiereDays) <= showCfg.comingSoonWindowDays ? `Premieres ${formatShortDate(details.first_air_date)}` : null;
    }
  }

  const upcomingSeason = seasons.find((s) => {
    if (s.season_number <= 1 || !s.air_date) return false;
    const d = daysSince(s.air_date);
    return d < 0 && Math.abs(d) <= showCfg.comingSoonWindowDays;
  });
  if (upcomingSeason) return `New Season ${formatShortDate(upcomingSeason.air_date)}`;

  // Premiere day, then the rest of the window as New Series / New Season.
  const premiereDate = (s) => {
    const ep1 = [last, next].find((e) => e && e.air_date && e.season_number === s.season_number && e.episode_number === 1);
    return ep1 ? ep1.air_date : s.air_date;
  };
  const recentPremiere = seasons.find((s) => {
    const d = daysSince(premiereDate(s));
    return d >= 0 && d <= showCfg.recencyWindowDays;
  });
  const isSeries = !!recentPremiere && recentPremiere.season_number === 1;
  if (recentPremiere && daysSince(premiereDate(recentPremiere)) === 0) return isSeries ? 'Series Premiere' : 'Season Premiere';

  // Latest episode label (Series/Season Finale, Airing Today, New Episode), today's first.
  const airsToday = (e) => !!(e && e.air_date && daysSince(e.air_date) === 0);
  const ep = [next, last].find(airsToday) || last;
  let epLabel = null;
  let epDays = Infinity;
  if (ep && ep.air_date) {
    epDays = daysSince(ep.air_date);
    if (epDays >= 0 && epDays <= showCfg.recencyWindowDays) {
      const season = seasons.find((s) => s.season_number === ep.season_number);
      const isSeasonFinaleEp = !!season && ep.episode_number === season.episode_count;
      const maxSeasonNumber = seasons.length ? Math.max(...seasons.map((s) => s.season_number)) : ep.season_number;
      const showEnded = details.status === 'Ended' || details.status === 'Canceled';
      if (isSeasonFinaleEp && ep.season_number === maxSeasonNumber && showEnded) epLabel = 'Series Finale';
      else if (isSeasonFinaleEp) epLabel = 'Season Finale';
      else epLabel = epDays === 0 ? 'Airing Today' : 'New Episode';
    }
  }
  if (epLabel && epDays === 0) return epLabel;

  if (recentPremiere) return isSeries ? 'New Series' : 'New Season';

  if (next && next.air_date) {
    const days = daysSince(next.air_date);
    if (days < 0 && Math.abs(days) <= showCfg.recencyWindowDays) {
      const nextSeason = seasons.find((s) => s.season_number === next.season_number);
      const isUpcomingFinale =
        !!nextSeason && nextSeason.episode_count > 1 && next.episode_number === nextSeason.episode_count;
      if (isUpcomingFinale) return `Season Finale ${formatShortDate(next.air_date)}`;
    }
  }

  return epLabel;
}

// ---- Art --------------------------------------------------------------------------
// All from the `images` block of the details call. api/catalog.js picks per the /backstage
// Portrait/Landscape art settings. "Textless" = iso_639_1 null (no title text in the image).

/** include_image_language: English, the original language, textless. */
function imageLanguages(originalLanguage) {
  const langs = ['en'];
  if (originalLanguage && originalLanguage !== 'en') langs.push(originalLanguage);
  langs.push('null');
  return langs.join(',');
}

function byVotes(a, b) {
  return (b.vote_average || 0) - (a.vote_average || 0) || (b.vote_count || 0) - (a.vote_count || 0);
}

/** Images best-voted first, preferring ones at least `minWidth` wide. */
function bestFirst(list, minWidth) {
  const all = (list || []).filter((i) => i.file_path);
  const big = all.filter((i) => !i.width || i.width >= minWidth);
  return (big.length ? big : all).sort(byVotes);
}

const langRank = (originalLanguage) => (i) => (i.iso_639_1 === 'en' ? 0 : i.iso_639_1 === originalLanguage ? 1 : 2);

/** Best image with title text in the user's languages (English, then original), or null. */
function pickTitled(list, minWidth, originalLanguage) {
  const rank = langRank(originalLanguage);
  const best = bestFirst(list, minWidth).filter((i) => i.iso_639_1 != null && rank(i) < 2)
    .sort((a, b) => rank(a) - rank(b) || byVotes(a, b))[0];
  return best ? best.file_path : null;
}

// How many top-voted textless backdrops lib/art.js compares for the most distinct one.
const ART_ALTERNATES = 5;

/**
 * Art paths for one title:
 *  - textless_poster_path: portrait 'alternate' base (logo drawn by us).
 *  - backdrop_path: landscape 'alternate' card, a textless backdrop other than the main one
 *    (refined by lib/art.js to the one that looks least like the references).
 *  - main_backdrop_path: clean backdrop sent as `background`.
 *  - logo_backdrop_path: landscape 'tmdb' card, a backdrop with the title logo baked in.
 */
function titleArt(images, mainBackdrop, originalLanguage) {
  const posters = bestFirst((images && images.posters || []).filter((p) => p.iso_639_1 == null), 500);
  const textless = bestFirst((images && images.backdrops || []).filter((b) => b.iso_639_1 == null), 1280);
  const topTextless = textless.length ? textless[0].file_path : null;
  const refs = [...new Set([mainBackdrop, topTextless].filter(Boolean))];
  const alternates = textless.map((b) => b.file_path).filter((p) => !refs.includes(p)).slice(0, ART_ALTERNATES);
  return {
    textless_poster_path: posters.length ? posters[0].file_path : null,
    backdrop_path: alternates[0] || topTextless || mainBackdrop || null,
    main_backdrop_path: topTextless || mainBackdrop || null,
    logo_backdrop_path: pickTitled(images && images.backdrops, 1280, originalLanguage),
    logo_path: pickLogo(images, originalLanguage),
    artReferences: refs,
    artAlternates: alternates,
  };
}

/**
 * Logo of the most prominent subscription service carrying the title in `region` (lowest
 * display_priority among `flatrate`), or null. Rent/buy stores are ignored, and so are resold
 * channels ("HBO Max Amazon Channel", "... Apple TV Channel", ...): their logos are combined
 * two-brand badges, and they duplicate the service itself. Data: JustWatch.
 */
const RESOLD_CHANNEL = /\bchannels?\b/i;

function topStreamingLogo(watchProviders, region) {
  const r = watchProviders && watchProviders.results && watchProviders.results[region];
  const top = ((r && r.flatrate) || []).filter((p) => p.logo_path && !RESOLD_CHANNEL.test(p.provider_name || ''))
    .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))[0];
  return top ? top.logo_path : null;
}

/** Best clearlogo: English, then the original language, then any. PNG preferred over SVG. */
function pickLogo(images, originalLanguage) {
  const logos = ((images && images.logos) || []).filter((l) => l.file_path);
  if (!logos.length) return null;
  const rank = langRank(originalLanguage);
  const isSvg = (l) => /\.svg$/i.test(l.file_path);
  logos.sort((a, b) => rank(a) - rank(b) || isSvg(a) - isSvg(b) || byVotes(a, b));
  return logos[0].file_path;
}

async function resolveMovie(m, cfg) {
  if (!passesLanguagePopularityGate(m, cfg.foreignMinVoteCount)) return null;

  try {
    const details = await tmdbGet(`/movie/${m.id}`, {
      append_to_response: 'external_ids,release_dates,images,watch/providers',
      include_image_language: imageLanguages(m.original_language),
    });
    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(m.id, imdbId, m.title, 'movie');
    if (!verified) return null;

    const digitalReleaseDate = regionDigitalReleaseDate(details.release_dates, cfg.region);
    const physicalReleaseDate = regionPhysicalReleaseDate(details.release_dates, cfg.region);
    const upcomingDigitalReleaseDate = regionUpcomingDigitalReleaseDate(details.release_dates, cfg.region);
    const isComingSoon = isUpcomingWithin(upcomingDigitalReleaseDate, cfg.movie.comingSoonWindowDays);
    if (!digitalReleaseDate && !physicalReleaseDate && !isComingSoon) return null;

    return {
      imdbId,
      tmdbId: m.id,
      name: m.title,
      poster_path: m.poster_path,
      ...titleArt(details.images, details.backdrop_path, m.original_language),
      releaseInfo: (m.release_date || '').slice(0, 4),
      context: computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate, cfg.movie),
      provider_logo_path: topStreamingLogo(details['watch/providers'], cfg.region),
    };
  } catch {
    return null;
  }
}

// ---- Local air dates (TVmaze) ----------------------------------------------------
// TMDB air dates are the network's own (US) calendar day, with no time. TVmaze has the exact
// airstamp, so episodes near today are re-dated onto the TIMEZONE calendar: a Sunday 9pm ET
// episode (01:00 UTC Monday) becomes Monday in Lagos. Only looked up when an episode is within
// a day of today, and any failure silently keeps TMDB's dates.

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TVMAZE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function localizeEpisodeDates(details, imdbId) {
  const near = (e) => e && e.air_date && Math.abs(daysSince(e.air_date)) <= 1;
  const { last_episode_to_air: last, next_episode_to_air: next } = details;
  if (!near(last) && !near(next)) return details;

  const show = await fetchJson(`${TVMAZE_BASE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`);
  if (!show || !show.id) return details;
  const full = await fetchJson(`${TVMAZE_BASE}/shows/${show.id}?embed[]=previousepisode&embed[]=nextepisode`);
  const eps = Object.values((full && full._embedded) || {}).filter((e) => e && e.airstamp);

  const relocate = (e) => {
    if (!e) return e;
    const hit = eps.find((m) => m.season === e.season_number && m.number === e.episode_number);
    return hit ? { ...e, air_date: localISO(new Date(hit.airstamp)) } : e;
  };
  return { ...details, last_episode_to_air: relocate(last), next_episode_to_air: relocate(next) };
}

async function resolveShow(s, cfg) {
  if (!passesLanguagePopularityGate(s, cfg.foreignMinVoteCount)) return null;

  try {
    const details = await tmdbGet(`/tv/${s.id}`, {
      append_to_response: 'external_ids,images,watch/providers',
      include_image_language: imageLanguages(s.original_language),
    });
    if (!isShowEligible(details.first_air_date, cfg.show.comingSoonWindowDays)) return null;

    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(s.id, imdbId, s.name, 'tv');
    if (!verified) return null;

    return {
      imdbId,
      tmdbId: s.id,
      name: s.name,
      poster_path: s.poster_path,
      ...titleArt(details.images, details.backdrop_path, s.original_language),
      releaseInfo: (s.first_air_date || '').slice(0, 4),
      context: computeShowContext(await localizeEpisodeDates(details, imdbId), cfg.show),
      provider_logo_path: topStreamingLogo(details['watch/providers'], cfg.region),
    };
  } catch {
    return null;
  }
}

/** Top Movies Today. */
async function getTopMovies() {
  const cfg = await getConfig();
  const items = await collectUntilFilled(
    '/trending/movie/day',
    (m) => resolveMovie(m, cfg),
    cfg.catalogSize,
    cfg.maxPages
  );
  if (cfg.landscapeArt !== 'custom') await applyDistinctBackdrops(items);
  return items;
}

/** Top Shows Today. */
async function getTopShows() {
  const cfg = await getConfig();
  const items = await collectUntilFilled(
    '/trending/tv/day',
    (s) => resolveShow(s, cfg),
    cfg.catalogSize,
    cfg.maxPages
  );
  if (cfg.landscapeArt !== 'custom') await applyDistinctBackdrops(items);
  return items;
}

module.exports = { getTopMovies, getTopShows, tmdbGet };
