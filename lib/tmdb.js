// lib/tmdb.js
// Talks to TMDB. Two lists:
//  - getTopMovies(): TMDB's daily trending movies, filtered down to only titles that
//    actually have a confirmed digital or physical release in the configured region (TMDB
//    release type codes: 1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital,
//    5 Physical, 6 TV -- so theatrical-only titles are still excluded, same rule as before),
//    plus titles whose confirmed digital release is imminent (see movie.comingSoonWindowDays).
//  - getTopShows(): TMDB's daily trending TV list, filtered like getTopMovies() --
//    eligible only if the show has already aired at least one episode, or its confirmed
//    premiere is within show.comingSoonWindowDays days out (see isShowEligible below).
//    trending/tv/day can surface a show purely on announcement/casting buzz months before it
//    airs; without this filter that show would sit in the Top 20 with no pill at all, taking
//    a slot a currently-airing or imminently-premiering show could use instead.
// Both resolve each title's imdb_id (needed for the poster source and for Stremio to match
// the item across other addons) and verify it via /find before trusting it.
//
// Both also work out a short status label ("Just Added", "New Episode", "Season Finale <date>", etc,
// see computeMovieContext / computeShowContext below) purely from fields TMDB already returns
// in the same requests -- no extra API calls, no database, no cron job.
//
// Filling the list: trending/day is a raw popularity feed, it doesn't know or care
// whether a movie is out digitally yet. On a day when several trending movies are still
// theatrical-only, a *fixed-size* pool (e.g. the first 30 trending titles) can easily lose
// more than 10 of those to the digital/physical filter, leaving the catalog short. So instead
// of pulling one fixed pool and filtering it, collectUntilFilled() below keeps requesting
// more pages of trending results -- in original ranking order -- until either the target
// count of titles have passed every check, or the max-pages cap is hit (a safety cap so a
// slow news day can't make the function fetch forever / time out the serverless function).
//
// Dedup: collectUntilFilled() also dedupes by raw TMDB id (before spending a details/verify
// call on it) and by resolved imdb_id (defensive, in case two different TMDB ids ever resolve
// to the same imdb_id). Two metas sharing an id collapse to one tile in Stremio's catalog
// renderer, which silently eats tiles after the second copy -- that's what showed up as
// "posters skipping" near the tail of the row. Dropping a duplicate still lets the loop keep
// paging until it actually has the target number of unique items, same safety net as the
// digital/physical filter above.
//
// Every tunable mentioned above (region, catalog size, page cap, status-label day windows,
// foreign-language vote gate) is read from lib/config.js at the start of each request --
// see that file for how to change them live from Vercel's dashboard, no redeploy needed.

const { getConfig } = require('./config');

const TMDB_BASE = 'https://api.themoviedb.org/3';

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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Whole-day difference between an ISO date string and today, computed in UTC so the
// server's local timezone can't shift the result. Negative means the date is in the future.
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

// TMDB gives runtime in whole minutes (movie `runtime`, show `episode_run_time[0]`).
// Stremio's convention is a short display string like "148 min"; undefined/0 means
// TMDB doesn't have a runtime for this title yet, so omit the field rather than show "0 min".
function formatRuntime(minutes) {
  if (!minutes) return undefined;
  return `${minutes} min`;
}

/**
 * Page through a TMDB list endpoint, resolving each raw result with `resolveItem`
 * (which returns either a finished catalog item, or null to drop a candidate),
 * stopping as soon as `targetCount` resolved items have been collected or
 * `maxPages` pages have been scanned. Preserves TMDB's original ranking order.
 *
 * Dedupes twice: raw TMDB id (before `resolveItem` spends a details/verify call on it --
 * trending pages can occasionally repeat an id if popularity shifts between page fetches),
 * and resolved imdb_id (defensive, in case two different TMDB ids ever resolve to the same
 * imdb_id). Either kind of duplicate is dropped and paging continues, so the result still
 * fills to `targetCount` unique items instead of coming up short.
 */
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
  // One containing the other covers subtitle/edition differences
  // ("Dune" vs "Dune: Part Two" would still fail deliberately, that's a real mismatch).
  return na.includes(nb) || nb.includes(na);
}

/**
 * English-language trending candidates pass through untouched -- the digital/physical
 * release filter already does real filtering work for them. Non-English candidates need
 * `minVoteCount` votes on TMDB before they're worth spending a details/verify call on, so a
 * globally popular foreign title (thousands of votes) still gets through while a title that
 * only spiked on a small fandom's watchlist doesn't. Reads straight off the raw trending
 * list item (`original_language`, `vote_count`), no extra request.
 */
function passesLanguagePopularityGate(raw, minVoteCount) {
  if (raw.original_language === 'en') return true;
  return (raw.vote_count || 0) >= minVoteCount;
}

/**
 * Round-trip an imdb_id back through TMDB's own /find endpoint (which uses a
 * separate lookup index from the /movie or /tv external_ids field) and confirm
 * it resolves back to the same TMDB id and a matching title. TMDB's external_ids
 * data is normally reliable, but merges/redirects occasionally leave a stale
 * imdb_id on the wrong record, this catches that before it reaches Stremio and
 * shows the wrong title when the user clicks in.
 */
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

/**
 * Earliest release date in `region`, of a given TMDB release type, that has already
 * happened (type 4 = Digital, type 5 = Physical), or null if the title has no such
 * release yet.
 */
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

/**
 * Earliest digital (type 4) release date in `region`, or null. Kept as its own helper
 * since eligibility (does this title have *any* qualifying release yet) and the
 * physical-release Blu-ray tag both need to read this independently of the type argument
 * at the call site.
 */
function regionDigitalReleaseDate(releaseDatesPayload, region) {
  return regionReleaseDateByType(releaseDatesPayload, 4, region);
}

/** Earliest physical (type 5, e.g. Blu-ray/DVD) release date in `region`, or null. */
function regionPhysicalReleaseDate(releaseDatesPayload, region) {
  return regionReleaseDateByType(releaseDatesPayload, 5, region);
}

/**
 * Earliest digital (type 4) release date in `region` that hasn't happened yet, or null.
 * Mirrors regionReleaseDateByType but keeps future dates instead of dropping them, since
 * this is what powers the movie Coming Soon tag.
 */
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

/**
 * A show belongs in the Top Shows list if it's already aired at least one episode
 * (first_air_date has passed), or hasn't aired yet but its confirmed first_air_date is
 * within `comingSoonWindowDays` -- mirrors the movie list's eligibility rule
 * (regionDigitalReleaseDate / regionUpcomingDigitalReleaseDate in resolveMovie). No
 * confirmed first_air_date at all means there's nothing to qualify it on, so it's excluded.
 */
function isShowEligible(firstAirDate, comingSoonWindowDays) {
  if (!firstAirDate) return false;
  const days = daysSince(firstAirDate);
  if (days >= 0) return true;
  return Math.abs(days) <= comingSoonWindowDays;
}

/**
 * "Now on Blu-ray" takes priority whenever the confirmed physical release is within
 * movieCfg.blurayWindowDays, regardless of how long the title's been out digitally --
 * a disc release is its own newsworthy moment, often months after the digital one.
 * Otherwise: "Just Added" within movieCfg.justAddedWindowDays of the digital release,
 * "Now Streaming" through movieCfg.nowStreamingWindowDays, "Coming Soon" if the digital
 * release hasn't happened yet but is within movieCfg.comingSoonWindowDays, then no pill.
 */
function computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate, movieCfg) {
  const blurayDays = daysSince(physicalReleaseDate);
  if (blurayDays >= 0 && blurayDays <= movieCfg.blurayWindowDays) return 'Now on Blu-ray';

  const days = daysSince(digitalReleaseDate);
  if (days <= movieCfg.justAddedWindowDays) return 'Just Added';
  if (days <= movieCfg.nowStreamingWindowDays) return 'Now Streaming';

  if (isUpcomingWithin(upcomingDigitalReleaseDate, movieCfg.comingSoonWindowDays)) return 'Coming Soon';

  return null;
}

/**
 * Short status label for a show:
 * Coming Soon, New Season [date], Premiere, Season Premiere, New Episode,
 * Season Finale [date], Series Finale. Returns null (no pill) once nothing recent enough
 * is left to report. Built entirely from fields TMDB's base /tv/{id} response already
 * includes (status, first_air_date, last_episode_to_air, next_episode_to_air, seasons) --
 * no extra requests needed.
 *
 * Coming Soon is checked before anything else: getTopShows() (unlike getTopMovies()) has no
 * release-date eligibility filter, trending/tv/day can surface a show that's generating
 * anticipation buzz before it's actually aired, so an unreleased show (first_air_date still
 * in the future) needs its own label rather than falling through to the recency logic below,
 * which assumes the show has aired at least one episode. Only shown when the premiere is
 * within showCfg.comingSoonWindowDays -- a season announced months out doesn't get a pill yet.
 *
 * New Season [date] is the season-2+ counterpart of Coming Soon: a returning show's next
 * season, announced but not yet aired (season_number > 1, air_date still in the future,
 * within showCfg.comingSoonWindowDays), gets its own pre-release heads-up. This ONLY fires
 * before the season airs -- once the air_date has passed, this function no longer calls it
 * "New Season" at all, it falls through to the Premiere/Season Premiere check below. (An
 * earlier version of this tag fired on a season that had already aired, within the recency
 * window -- so a still-recent season showed up as e.g. "New Season Aug 27" days after the
 * fact, a forward-looking label carrying a past date. Fixed: New Season is now exclusively
 * the pre-release heads-up, symmetric with how Coming Soon works for a show's very first
 * season.)
 *
 * Premiere / Season Premiere is "just aired", checked directly off a season's own air_date
 * rather than last_episode_to_air, for ANY season number (season 1 -> "Premiere", season 2+
 * -> "Season Premiere") -- both read the same underlying `recentSeasonPremiere` check below,
 * only the label differs. This matters for two reasons, not just one:
 *   1. Netflix-style drops where a whole season releases the same day -- last_episode_to_air
 *      would point at whichever episode aired last (e.g. episode 8 of an 8-episode season),
 *      not episode 1, so reading last_episode_to_air alone would misreport a same-day season
 *      drop as "Season Finale" instead of a premiere.
 *   2. TMDB's last_episode_to_air field itself lags the real air date by up to about a week
 *      right after a fresh release (documented via the Reacher case, and again via The
 *      Gentlemen/Chad Powers going tagless on their season-2 premiere day -- both Session 11
 *      /12). Reading the season's own air_date sidesteps that lag entirely, for premieres of
 *      any season number, not just season 1.
 * (Earlier versions of this function only did this for season 1 -- season 2+ relied
 * entirely on last_episode_to_air below, which is exactly what produced both bugs above.
 * Also naturally covers the single-episode-season edge case, a TV movie/one-off/show
 * canceled after one episode: technically both the first and last episode of its season,
 * and should still read as a premiere, not a finale.)
 *
 * Season/Series Finale: shown *with* a date only while the finale is still upcoming (next
 * showCfg.recencyWindowDays days), read off `next_episode_to_air` -- a heads-up that it's
 * coming, not a recap of something that already happened. Once the finale has actually
 * aired (picked up via `last_episode_to_air` instead), the tag stays but the date drops --
 * it's no longer news that it happens "on <date>". The upcoming check can't distinguish
 * Series Finale from Season Finale (TMDB's `status` only flips to Ended/Canceled after the
 * finale airs, so there's no reliable "this is the last season" signal beforehand), so it
 * always says "Season Finale <date>"; Series Finale only appears after the fact. Both checks
 * exclude single-episode seasons (episode_count === 1), since that's really a premiere, same
 * edge case as above -- and in practice the recentSeasonPremiere check above already claims
 * those before either finale check is reached.
 */
function computeShowContext(details, showCfg) {
  const seasons = (details.seasons || []).filter((s) => s.season_number > 0);

  if (details.first_air_date) {
    const premiereDays = daysSince(details.first_air_date);
    if (premiereDays < 0) {
      // Hasn't aired its first episode yet -- only worth flagging within the window.
      return Math.abs(premiereDays) <= showCfg.comingSoonWindowDays ? 'Coming Soon' : null;
    }
  }

  // A returning show's next season, announced but not yet aired -- checked before
  // Premiere/New Episode/Finale below since an upcoming season is more newsworthy than
  // whatever aired in the previous one.
  const upcomingSeason = seasons.find((s) => {
    if (s.season_number <= 1 || !s.air_date) return false;
    const d = daysSince(s.air_date);
    return d < 0 && Math.abs(d) <= showCfg.comingSoonWindowDays;
  });
  if (upcomingSeason) return `New Season ${formatShortDate(upcomingSeason.air_date)}`;

  // Any season (1 or later) that itself started within the recency window, checked
  // straight off that season's own air_date -- see the docstring above for why this has
  // to run, and win, before last_episode_to_air is ever consulted.
  const recentSeasonPremiere = seasons.find((s) => {
    if (!s.air_date) return false;
    const d = daysSince(s.air_date);
    return d >= 0 && d <= showCfg.recencyWindowDays;
  });
  if (recentSeasonPremiere) {
    return recentSeasonPremiere.season_number === 1 ? 'Premiere' : 'Season Premiere';
  }

  const next = details.next_episode_to_air;
  if (next && next.air_date) {
    const days = daysSince(next.air_date);
    if (days < 0 && Math.abs(days) <= showCfg.recencyWindowDays) {
      const nextSeason = seasons.find((s) => s.season_number === next.season_number);
      const isUpcomingFinale =
        !!nextSeason && nextSeason.episode_count > 1 && next.episode_number === nextSeason.episode_count;
      if (isUpcomingFinale) return `Season Finale ${formatShortDate(next.air_date)}`;
    }
  }

  const ep = details.last_episode_to_air;
  if (ep && ep.air_date) {
    const days = daysSince(ep.air_date);
    if (days >= 0 && days <= showCfg.recencyWindowDays) {
      const season = seasons.find((s) => s.season_number === ep.season_number);
      const isSeasonFinaleEp = !!season && ep.episode_number === season.episode_count;
      const maxSeasonNumber = seasons.length
        ? Math.max(...seasons.map((s) => s.season_number))
        : ep.season_number;
      const isLastSeason = ep.season_number === maxSeasonNumber;
      const showEnded = details.status === 'Ended' || details.status === 'Canceled';

      // Already aired -- the date drops here (see docstring above); it's reserved for the
      // still-upcoming case handled above.
      if (isSeasonFinaleEp && isLastSeason && showEnded) return 'Series Finale';
      if (isSeasonFinaleEp) return 'Season Finale';
      return 'New Episode';
    }
  }

  return null;
}

async function resolveMovie(m, cfg) {
  if (!passesLanguagePopularityGate(m, cfg.foreignMinVoteCount)) return null;

  try {
    const details = await tmdbGet(`/movie/${m.id}`, {
      append_to_response: 'external_ids,release_dates',
    });
    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(m.id, imdbId, m.title, 'movie');
    if (!verified) return null;

    const digitalReleaseDate = regionDigitalReleaseDate(details.release_dates, cfg.region);
    const physicalReleaseDate = regionPhysicalReleaseDate(details.release_dates, cfg.region);
    const upcomingDigitalReleaseDate = regionUpcomingDigitalReleaseDate(details.release_dates, cfg.region);
    const isComingSoon = isUpcomingWithin(upcomingDigitalReleaseDate, cfg.movie.comingSoonWindowDays);
    // Eligible if it's already out digitally/physically in the configured region, or if
    // it's not out yet but the confirmed digital release is imminent (Coming Soon window).
    if (!digitalReleaseDate && !physicalReleaseDate && !isComingSoon) return null;

    return {
      imdbId,
      tmdbId: m.id,
      name: m.title,
      poster_path: m.poster_path,
      backdrop_path: details.backdrop_path,
      releaseInfo: (m.release_date || '').slice(0, 4),
      context: computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate, cfg.movie),
      description: details.overview || undefined,
      genres: (details.genres || []).map((g) => g.name),
      imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
      runtime: formatRuntime(details.runtime),
    };
  } catch {
    return null;
  }
}

async function resolveShow(s, cfg) {
  if (!passesLanguagePopularityGate(s, cfg.foreignMinVoteCount)) return null;

  try {
    const details = await tmdbGet(`/tv/${s.id}`, { append_to_response: 'external_ids' });
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
      backdrop_path: details.backdrop_path,
      releaseInfo: (s.first_air_date || '').slice(0, 4),
      context: computeShowContext(details, cfg.show),
      description: details.overview || undefined,
      genres: (details.genres || []).map((g) => g.name),
      imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
      runtime: formatRuntime((details.episode_run_time || [])[0]),
    };
  } catch {
    return null;
  }
}

/**
 * Top movies trending today (TMDB trending/movie/day), filtered to only titles with a
 * confirmed digital or physical release in the configured region (so theatrical-only titles
 * are still excluded, same rule as before), plus titles whose digital release is confirmed
 * but still imminent (tagged Coming Soon by computeMovieContext). Pages through trending
 * results (up to the configured max pages) until the catalog size is filled, instead of
 * pulling one fixed pool -- see the comment at the top of this file for why.
 */
async function getTopMovies() {
  const cfg = await getConfig();
  return collectUntilFilled(
    '/trending/movie/day',
    (m) => resolveMovie(m, cfg),
    cfg.catalogSize,
    cfg.maxPages
  );
}

/**
 * Top shows trending today (TMDB trending/tv/day), filtered to shows that have already
 * aired at least one episode or premiere within the configured Coming Soon window (see
 * isShowEligible). Pages through trending results (up to the configured max pages) until
 * the catalog size is filled, same as getTopMovies() -- see the comment at the top of this
 * file for why.
 */
async function getTopShows() {
  const cfg = await getConfig();
  return collectUntilFilled(
    '/trending/tv/day',
    (s) => resolveShow(s, cfg),
    cfg.catalogSize,
    cfg.maxPages
  );
}

module.exports = { getTopMovies, getTopShows, tmdbGet, formatRuntime };
