// lib/tmdb.js
// TMDB data for the two catalogs:
//  - getTopMovies(): trending/movie/day, kept only if released digitally or physically in the
//    configured region, or if the digital release is inside the Coming Soon window.
//  - getTopShows(): trending/tv/day minus anime/donghua, kept only if it has aired, or premieres inside
//    the Coming Soon window (trending can surface shows on pre-release buzz alone).
//  - getComingSoon(): the next comingSoon.windowDays of US digital movie releases and show
//    premieres / new seasons / returns, most popular first, then sorted soonest first (mixed row).
// Every imdb_id is round-tripped through /find before it's trusted. Status labels and art are
// derived from the same details request (append_to_response), so one details call per title.
// collectUntilFilled() pages through trending until catalogSize titles pass, deduping by TMDB
// and imdb id (duplicate ids collapse to one tile in Stremio and eat the rest of the row).

const { getConfig } = require('./config');
const { applyArtPools } = require('./art');

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

const WEEKDAY_WITHIN_DAYS = 5;
const MIDSEASON_BREAK_DAYS = 14;

/** Label date: "Tomorrow", then weekday ("Wed") within 5 days, else "Oct 3". */
function formatShortDate(dateStr) {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const daysAway = -daysSince(dateStr);
  if (daysAway === 1) return 'Tomorrow';
  if (daysAway >= 0 && daysAway <= WEEKDAY_WITHIN_DAYS) return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
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

/**
 * Anime and East Asian animation (Japanese anime, Chinese donghua, Korean animation): TMDB has
 * no anime genre, so it's Animation (16) with a Japanese, Chinese or Korean original language or
 * origin country. Western animation (The Simpsons, Invincible, ...) stays. Checked on the
 * trending result, before any details call. TMDB codes Cantonese as 'cn'.
 */
const ANIMATION_GENRE = 16;
const EAST_ASIAN_LANGUAGES = ['ja', 'zh', 'cn', 'ko'];
const EAST_ASIAN_COUNTRIES = ['JP', 'CN', 'HK', 'TW', 'KR'];
function isAnime(raw) {
  if (!(raw.genre_ids || []).includes(ANIMATION_GENRE)) return false;
  return EAST_ASIAN_LANGUAGES.includes(raw.original_language) || (raw.origin_country || []).some((c) => EAST_ASIAN_COUNTRIES.includes(c));
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
 *  - Full Season: a binge drop (finale out on premiere day), for the whole recency window.
 *  - New Series / New Season: the rest of the recency window after a premiere. Beats aired
 *    finales.
 *  - Season Finale <date>: the finale is upcoming within the window (next_episode_to_air).
 *    TMDB only flags a show Ended after its finale, so an upcoming one is always "Season".
 *  - Series Finale / Season Finale: latest aired episode within the window.
 *  - New Episode: latest aired episode, only up to newEpisodeWindowDays (2) after it aired.
 *  - Next Ep <date> / Returns <date>: fallback when nothing above applies and the next episode is
 *    within the window; Returns when the last episode aired over two weeks ago.
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
  // Binge drop: the season's finale aired on its premiere day. Reads Full Season all window.
  const isFullDrop = !!recentPremiere && recentPremiere.episode_count > 1 && [last, next].some((e) =>
    e && e.air_date && e.season_number === recentPremiere.season_number &&
    e.episode_number === recentPremiere.episode_count && e.air_date === premiereDate(recentPremiere));
  if (isFullDrop) return 'Full Season';
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
      else if (epDays === 0) epLabel = 'Airing Today';
      else if (epDays <= (showCfg.newEpisodeWindowDays ?? 2)) epLabel = 'New Episode';
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
      // Nothing fresher: point at the next episode ("Returns" after a MIDSEASON_BREAK_DAYS gap).
      if (!epLabel) {
        const onBreak = !last || !last.air_date || daysSince(last.air_date) > MIDSEASON_BREAK_DAYS;
        return `${onBreak ? 'Returns' : 'Next Ep'} ${formatShortDate(next.air_date)}`;
      }
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

// How many top-voted textless images lib/art.js screens for the rotation pools.
const ART_ALTERNATES = 5;
const POSTER_CANDIDATES = 6;

/**
 * Art paths for one title:
 *  - textless_poster_path: portrait 'alternate' base (logo drawn by us).
 *  - posterPool / posterCandidates: textless posters the portrait card rotates through
 *    (one-image pool until lib/art.js screens the candidates).
 *  - backdrop_path / backdropPool: landscape 'alternate' card, textless backdrops other than
 *    the main one (lib/art.js narrows them to ones that look unlike the references).
 *  - main_backdrop_path: clean backdrop sent as `background`.
 *  - logo_backdrop_path: landscape 'tmdb' card, a backdrop with the title logo baked in.
 */
function titleArt(images, mainBackdrop, originalLanguage) {
  const posters = bestFirst((images && images.posters || []).filter((p) => p.iso_639_1 == null), 500);
  const topPoster = posters.length ? posters[0].file_path : null;
  // Rotation extras must be full size; only the top one may fall back to a small upload.
  const posterCandidates = [topPoster, ...posters.slice(1).filter((p) => !p.width || p.width >= 500).map((p) => p.file_path)]
    .filter(Boolean).slice(0, POSTER_CANDIDATES);
  const textless = bestFirst((images && images.backdrops || []).filter((b) => b.iso_639_1 == null), 1280);
  const topTextless = textless.length ? textless[0].file_path : null;
  const refs = [...new Set([mainBackdrop, topTextless].filter(Boolean))];
  const alternates = textless.map((b) => b.file_path).filter((p) => !refs.includes(p)).slice(0, ART_ALTERNATES);
  const backdropPath = alternates[0] || topTextless || mainBackdrop || null;
  return {
    textless_poster_path: topPoster,
    posterPool: topPoster ? [topPoster] : [],
    posterCandidates,
    backdrop_path: backdropPath,
    backdropPool: backdropPath ? [backdropPath] : [],
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

/** Service name reduced for matching: "Amazon Prime Video" ~ "Prime Video", "Apple TV+" ~ "Apple TV". */
function serviceKey(name) {
  return String(name || '').toLowerCase().replace(/\bamazon\b|\bwith ads\b|\bplus\b|\+/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Streamer that belongs to the same company as a linear network (keys as serviceKey() makes them),
 * so an NBC show points to Peacock rather than whichever service ranks higher. Networks with a
 * same-name streamer (HBO, AMC, Starz, ...) already match without an entry.
 */
const NETWORK_HOME = {
  nbc: 'peacock', bravo: 'peacock', usanetwork: 'peacock', syfy: 'peacock',
  cbs: 'paramount', showtime: 'paramount', comedycentral: 'paramount', mtv: 'paramount', nickelodeon: 'paramount', paramountnetwork: 'paramount',
  abc: 'hulu', fx: 'hulu', fxx: 'hulu', freeform: 'hulu', fox: 'hulu',
  tnt: 'hbomax', tbs: 'hbomax', adultswim: 'hbomax', cartoonnetwork: 'hbomax',
};

/**
 * Logo of the top US subscription service carrying the title. A show's own network (or its
 * company's streamer, NETWORK_HOME) wins when it's among them (Dark Matter: Apple TV+ over Prime
 * Video, which only licenses season 1); otherwise TMDB's display_priority decides. Resold
 * "Channels" are skipped.
 */
function topStreamingLogo(watchProviders, region, networks = []) {
  const r = watchProviders && watchProviders.results && watchProviders.results[region];
  const own = (networks || []).flatMap((n) => {
    const k = serviceKey(n.name);
    return [k, NETWORK_HOME[k]].filter((x) => x && x.length >= 3);
  });
  const isOwn = (p) => {
    const k = serviceKey(p.provider_name);
    return own.some((n) => k === n || (k.length >= 3 && (k.includes(n) || n.includes(k))));
  };
  const top = ((r && r.flatrate) || []).filter((p) => p.logo_path && !RESOLD_CHANNEL.test(p.provider_name || ''))
    .sort((a, b) => isOwn(b) - isOwn(a) || (a.display_priority ?? 999) - (b.display_priority ?? 999))[0];
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
  if (isAnime(s)) return null;
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
      provider_logo_path: topStreamingLogo(details['watch/providers'], cfg.region, details.networks),
    };
  } catch {
    return null;
  }
}

/**
 * What lib/art.js screens: portrait pools only when Alternate TMDB portrait art rotates;
 * landscape whenever TMDB art is used (with rotation off, a pool of one: the most distinct).
 */
function artPoolOptions(cfg) {
  const rotating = cfg.artRotationHours > 0;
  return {
    portrait: rotating && cfg.posterArt === 'alternate',
    landscape: cfg.landscapeArt === 'custom' ? false : rotating ? 'pool' : 'single',
    max: cfg.artRotationPool,
  };
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
  await applyArtPools(items, artPoolOptions(cfg));
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
  await applyArtPools(items, artPoolOptions(cfg));
  return items;
}

// ---- Coming Soon ------------------------------------------------------------------
// One mixed row: movies with a US digital release, and shows premiering, starting a new season
// or returning from a break, all dated today..windowDays ahead. Candidates come from /discover,
// most popular first and above minPopularity; each type is resolved (details + /find, as in the
// ranked rows) until `catalogSize` pass or the candidates run out. The row keeps minPerType of
// each type (as far as they exist), fills the rest by popularity, then sorts soonest first.

const DISCOVER_PAGES = 5;

function addDaysISO(days) {
  return localISO(new Date(Date.now() + days * 86400000));
}

/** Candidates from discover, popularity-sorted, stopping at the popularity floor. */
async function discoverCandidates(pathname, params, floor) {
  const out = [];
  for (let page = 1; page <= DISCOVER_PAGES; page += 1) {
    const data = await tmdbGet(pathname, { ...params, sort_by: 'popularity.desc', include_adult: 'false', page });
    const results = data.results || [];
    const above = results.filter((r) => (r.popularity || 0) >= floor);
    out.push(...above);
    if (above.length < results.length || page >= (data.total_pages || page)) break;
  }
  return out;
}

/** Resolve candidates in rank order, `batch` at a time, until `target` pass. */
async function resolveUntil(candidates, resolveItem, target, batch = 40) {
  const passing = [];
  const seen = new Set();
  for (let i = 0; i < candidates.length && passing.length < target; i += batch) {
    const resolved = await Promise.all(candidates.slice(i, i + batch).map(resolveItem));
    for (const item of resolved) {
      if (!item || seen.has(item.imdbId) || passing.length >= target) continue;
      seen.add(item.imdbId);
      passing.push(item);
    }
  }
  return passing;
}

/** Earliest US digital release inside today..windowDays, if it is the movie's first one. */
function comingDigitalDate(releaseDatesPayload, region, windowDays) {
  const entry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find((r) => r.iso_3166_1 === region);
  const dates = ((entry && entry.release_dates) || [])
    .filter((rd) => rd.type === 4 && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .sort();
  const first = dates[0];
  if (!first) return null;
  const days = daysSince(first);
  return days <= 0 && -days <= windowDays ? first : null;
}

/** Movie pill: Out Today on the day, else Streaming <date>. */
function comingMovieLabel(date) {
  return daysSince(date) === 0 ? 'Out Today' : `Streaming ${formatShortDate(date)}`;
}

/**
 * What a show is coming back as, or null: a premiere (first episode), a new season (episode 1 of
 * season 2+), or a return (next episode after a MIDSEASON_BREAK_DAYS gap), dated in the window.
 */
function classifyComingShow(details, windowDays) {
  const inWindow = (d) => !!d && daysSince(d) <= 0 && -daysSince(d) <= windowDays;
  const { last_episode_to_air: last, next_episode_to_air: next } = details;
  // On release day TMDB may already have moved that episode into last_episode_to_air.
  const upcoming = [last, next].find((e) => e && inWindow(e.air_date));
  const prior = upcoming === last ? null : last;
  const premiere = upcoming && upcoming.season_number === 1 && upcoming.episode_number === 1 ? upcoming.air_date : details.first_air_date;
  if (daysSince(details.first_air_date) <= 0 && inWindow(premiere)) return { kind: 'premiere', date: premiere };
  if (!upcoming) return null;
  if (upcoming.episode_number === 1 && upcoming.season_number >= 2) return { kind: 'season', date: upcoming.air_date };
  if (upcoming === next && (!prior || !prior.air_date || daysSince(prior.air_date) > MIDSEASON_BREAK_DAYS)) return { kind: 'return', date: next.air_date };
  return null;
}

/** Show pill: Premieres / New Season / Returns <date>; on the day, the ranked rows' day-of labels. */
function comingShowLabel(coming, details, showCfg) {
  if (daysSince(coming.date) === 0) {
    if (coming.kind === 'return') return 'Returns Today';
    const today = computeShowContext(details, showCfg); // Series/Season Premiere, Full Season
    if (today) return today;
    return coming.kind === 'premiere' ? 'Series Premiere' : 'Season Premiere';
  }
  const word = { premiere: 'Premieres', season: 'New Season', return: 'Returns' }[coming.kind];
  return `${word} ${formatShortDate(coming.date)}`;
}

// "Real release" gate (comingSoon.mode 'notable'): instead of a popularity floor, a title has to
// come from a real outlet. Shows: a network that is a major streamer or US/UK broadcaster/cable
// channel (US, UK, Canada). Movies: a US theatrical release with popularity of at least
// THEATRICAL_MIN_POPULARITY (plenty of VOD indies get a token run), a streamer as a production
// company, or already listed on a US subscription service. Keys as serviceKey() makes them;
// a network or company matches when its key starts with one of these.
const MAJOR_OUTLETS = [
  'netflix', 'appletv', 'apple', 'primevideo', 'hulu', 'disney', 'peacock', 'paramount', 'hbo', 'max',
  'amc', 'starz', 'mgm', 'showtime', 'fx', 'cbs', 'nbc', 'abc', 'fox', 'thecw', 'pbs', 'usanetwork',
  'syfy', 'bravo', 'freeform', 'tnt', 'tbs', 'adultswim', 'cartoonnetwork', 'nickelodeon',
  'comedycentral', 'bet', 'shudder', 'acorntv', 'britbox', 'bbc', 'itv', 'channel4', 'sky',
  'nationalgeographic', 'history', 'ae', 'epix', 'cinemax', 'youtubepremium', 'roku',
  'cbc', 'ctv', 'citytv', 'global',
];
const THEATRICAL_MIN_POPULARITY = 3;
const STREAMER_STUDIOS = /netflix|apple|amazon|prime video|disney\+|hbo|max original|peacock|paramount\+|hulu/i;

function isMajorOutlet(name) {
  const k = serviceKey(name);
  return k.length >= 2 && MAJOR_OUTLETS.some((o) => k === o || k.startsWith(o));
}

/** Why a movie counts as a real release, or null. */
function movieNotability(details, region, popularity) {
  const entry = ((details.release_dates && details.release_dates.results) || []).find((r) => r.iso_3166_1 === region);
  const types = ((entry && entry.release_dates) || []).map((rd) => rd.type);
  if (popularity >= THEATRICAL_MIN_POPULARITY && types.includes(3)) return 'wide theatrical';
  if (popularity >= THEATRICAL_MIN_POPULARITY && types.includes(2)) return 'limited theatrical';
  if ((details.production_companies || []).some((c) => STREAMER_STUDIOS.test(c.name || ''))) return 'streamer original';
  const r = details['watch/providers'] && details['watch/providers'].results && details['watch/providers'].results[region];
  if (((r && r.flatrate) || []).length) return 'on a service';
  return null;
}

/** Why a show counts as a real release, or null. */
function showNotability(details) {
  const hit = (details.networks || []).find((n) => isMajorOutlet(n.name));
  return hit ? hit.name : null;
}

/** 'notable' mode drops non-notable titles before the /find check (saves a call each). */
const skipUnnotable = (cfg) => cfg.comingSoon.mode === 'notable';

async function resolveComingMovie(m, cfg) {
  if (!passesLanguagePopularityGate(m, cfg.foreignMinVoteCount)) return null;
  try {
    const details = await tmdbGet(`/movie/${m.id}`, {
      append_to_response: 'external_ids,release_dates,images,watch/providers',
      include_image_language: imageLanguages(m.original_language),
    });
    const date = comingDigitalDate(details.release_dates, cfg.region, cfg.comingSoon.windowDays);
    if (!date) return null;
    const imdbId = details.external_ids && details.external_ids.imdb_id;
    const notable = movieNotability(details, cfg.region, m.popularity || 0);
    if (!imdbId || (skipUnnotable(cfg) && !notable)) return null;
    if (!(await verifyImdbMatch(m.id, imdbId, m.title, 'movie'))) return null;
    return {
      type: 'movie',
      notable,
      date,
      popularity: m.popularity || 0,
      imdbId,
      tmdbId: m.id,
      name: m.title,
      poster_path: m.poster_path,
      ...titleArt(details.images, details.backdrop_path, m.original_language),
      releaseInfo: (m.release_date || '').slice(0, 4),
      context: comingMovieLabel(date),
      provider_logo_path: topStreamingLogo(details['watch/providers'], cfg.region),
    };
  } catch {
    return null;
  }
}

// TMDB TV genres kept out of Coming Soon: Kids, News, Reality, Soap, Talk.
const UNWANTED_SHOW_GENRES = [10762, 10763, 10764, 10766, 10767];

// Kids shows TMDB doesn't tag Kids: animated family shows, and anything on a kids channel.
const ANIMATION = 16;
const FAMILY = 10751;
const KIDS_NETWORKS = ['disneyxd', 'disneyjunior', 'disneychannel', 'nickjr', 'nickelodeon', 'nicktoons', 'cartoonnetwork', 'cartoonito', 'pbskids', 'universalkids', 'cbeebies', 'cbbc', 'babytv', 'discoveryfamily'];

/** Coming Soon shows: English-language only, no kids, talk, reality, news or soaps. */
function isWantedComingShow(s) {
  if (s.original_language !== 'en') return false;
  const genres = s.genre_ids || (s.genres || []).map((g) => g.id);
  if (genres.includes(ANIMATION) && genres.includes(FAMILY)) return false;
  if ((s.networks || []).some((n) => KIDS_NETWORKS.includes(serviceKey(n.name)))) return false;
  return !genres.some((g) => UNWANTED_SHOW_GENRES.includes(g));
}

async function resolveComingShow(s, cfg) {
  if (isAnime(s) || !isWantedComingShow(s)) return null;
  try {
    const raw = await tmdbGet(`/tv/${s.id}`, {
      append_to_response: 'external_ids,images,watch/providers',
      include_image_language: imageLanguages(s.original_language),
    });
    const imdbId = raw.external_ids && raw.external_ids.imdb_id;
    if (!imdbId || !isWantedComingShow({ original_language: s.original_language, genres: raw.genres, networks: raw.networks })) return null;
    const details = await localizeEpisodeDates(raw, imdbId);
    const coming = classifyComingShow(details, cfg.comingSoon.windowDays);
    const notable = showNotability(details);
    if (!coming || (skipUnnotable(cfg) && !notable)) return null;
    if (!(await verifyImdbMatch(s.id, imdbId, s.name, 'tv'))) return null;
    return {
      type: 'series',
      notable,
      date: coming.date,
      popularity: s.popularity || 0,
      imdbId,
      tmdbId: s.id,
      name: s.name,
      poster_path: s.poster_path,
      ...titleArt(details.images, details.backdrop_path, s.original_language),
      releaseInfo: (s.first_air_date || '').slice(0, 4),
      context: comingShowLabel(coming, details, cfg.show),
      provider_logo_path: topStreamingLogo(details['watch/providers'], cfg.region, details.networks),
    };
  } catch {
    return null;
  }
}

/**
 * Pick `size` from two lists: up to minPerType of each first, the rest from whatever is left.
 * 'popular' picks the most popular; 'notable' (a calendar) picks the soonest. Either way the
 * row reads soonest first, more popular first on the same day.
 */
function mixComingSoon(movies, shows, size, minPerType, mode = 'popular') {
  const byPop = (a, b) => b.popularity - a.popularity;
  const bySoon = (a, b) => a.date.localeCompare(b.date) || byPop(a, b);
  const pickOrder = mode === 'notable' ? bySoon : byPop;
  const [ms, ss] = [[...movies].sort(pickOrder), [...shows].sort(pickOrder)];
  const floor = Math.min(minPerType, Math.floor(size / 2));
  const picked = [...ms.slice(0, floor), ...ss.slice(0, floor)];
  const rest = [...ms.slice(floor), ...ss.slice(floor)].sort(pickOrder);
  picked.push(...rest.slice(0, Math.max(0, size - picked.length)));
  return picked.sort(bySoon);
}

/**
 * Coming Soon (mixed movies and shows). Mode 'notable' (default): no floor, real releases only
 * (see MAJOR_OUTLETS), the soonest 20, no per-type minimum. Mode 'popular': candidates above
 * minPopularity, the most popular 20 with minPerType of each.
 * `diag` (temporary) returns both selections from one set of candidates instead.
 */
async function getComingSoon({ diag = false } = {}) {
  const cfg = await getConfig();
  const { windowDays, minPerType, mode } = cfg.comingSoon;
  const floor = diag || mode === 'notable' ? 0 : cfg.comingSoon.minPopularity;
  const from = todayISO();
  const to = addDaysISO(windowDays);
  const tvLang = { with_original_language: 'en' };

  const [movieCands, premiereCands, airingCands] = await Promise.all([
    discoverCandidates('/discover/movie', {
      region: cfg.region,
      with_release_type: 4,
      'release_date.gte': from,
      'release_date.lte': to,
    }, floor),
    discoverCandidates('/discover/tv', { ...tvLang, 'first_air_date.gte': from, 'first_air_date.lte': to }, floor),
    discoverCandidates('/discover/tv', { ...tvLang, 'air_date.gte': from, 'air_date.lte': to, timezone: TIMEZONE }, floor),
  ]);
  const seenShows = new Set();
  const showCands = [...premiereCands, ...airingCands]
    .filter((s) => !seenShows.has(s.id) && seenShows.add(s.id))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

  // 'notable' picks by date, so every candidate has to be resolved; 'popular' can stop at 20.
  const want = diag || mode === 'notable' ? Infinity : cfg.catalogSize;
  const [movies, shows] = await Promise.all([
    resolveUntil(movieCands, (m) => resolveComingMovie(m, cfg), want),
    resolveUntil(showCands, (s) => resolveComingShow(s, cfg), want),
  ]);
  const aboveFloor = (x) => x.popularity >= cfg.comingSoon.minPopularity;
  const pick = (m) => (m === 'notable'
    ? mixComingSoon(movies.filter((x) => x.notable), shows.filter((x) => x.notable), cfg.catalogSize, 0, 'notable')
    : mixComingSoon(movies.filter(aboveFloor), shows.filter(aboveFloor), cfg.catalogSize, minPerType, 'popular'));

  if (diag) {
    const brief = (x) => ({ name: x.name, type: x.type, popularity: Math.round(x.popularity * 10) / 10, date: x.date, label: x.context, notable: x.notable });
    return { popular: pick('popular').map(brief), notable: pick('notable').map(brief), all: [...movies, ...shows].map(brief) };
  }
  const items = pick(mode);
  await applyArtPools(items, artPoolOptions(cfg));
  return items;
}

module.exports = { getTopMovies, getTopShows, getComingSoon, tmdbGet };
