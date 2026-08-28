// lib/tmdb.js
// Talks to TMDB. Two lists:
//  - getTopMovies(): TMDB's daily trending movies, filtered down to only titles that
//    actually have a confirmed US digital or physical release (TMDB release type codes:
//    1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV -- so
//    theatrical-only titles are still excluded, same rule as before), plus titles whose
//    confirmed digital release is imminent (see MOVIE_COMING_SOON_WINDOW_DAYS below).
//  - getTopShows(): TMDB's daily trending TV list, US region, filtered like getTopMovies() --
//    eligible only if the show has already aired at least one episode, or its confirmed
//    premiere is within SHOW_COMING_SOON_WINDOW_DAYS days out (see isShowEligible below).
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
// Filling the list to 20: trending/day is a raw popularity feed, it doesn't know or care
// whether a movie is out digitally yet. On a day when several trending movies are still
// theatrical-only, a *fixed-size* pool (e.g. the first 30 trending titles) can easily lose
// more than 10 of those to the digital/physical filter, leaving the catalog short. So instead
// of pulling one fixed pool and filtering it, collectUntilFilled() below keeps requesting
// more pages of trending results -- in original ranking order -- until either TARGET_COUNT
// titles have passed every check, or MAX_PAGES is hit (a safety cap so a slow news day can't
// make the function fetch forever / time out the serverless function).
//
// Dedup: collectUntilFilled() also dedupes by raw TMDB id (before spending a details/verify
// call on it) and by resolved imdb_id (defensive, in case two different TMDB ids ever resolve
// to the same imdb_id). Two metas sharing an id collapse to one tile in Stremio's catalog
// renderer, which silently eats tiles after the second copy -- that's what showed up as
// "posters skipping" near the tail of the row. Dropping a duplicate still lets the loop keep
// paging until it actually has TARGET_COUNT unique items, same safety net as the digital/
// physical filter above.

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TARGET_COUNT = 20;
const MAX_PAGES = 6; // TMDB returns ~20 results/page, so up to ~120 raw candidates get scanned

// Foreign-language titles need to clear a minimum vote_count before they're eligible.
// trending/day is a global feed; a small but vocal foreign-language fandom can spike a
// niche title onto it with only a handful of votes. English-language titles aren't gated
// here -- the digital/physical release filter further down already does real filtering
// work for them. Checked directly off the raw trending payload (original_language and
// vote_count are already present there) before spending a details/verify API call on the
// candidate. Tune this number up/down depending on how aggressive the cut should be.
const FOREIGN_MIN_VOTE_COUNT = 50;

// Movies: "Just Added" for the first 3 days after the confirmed US digital release, "Now
// Streaming" from day 4 through day 14, no pill at all past that -- a title that's been out
// for two weeks doesn't need a freshness callout every time it shows up in the list.
const MOVIE_JUST_ADDED_WINDOW_DAYS = 3;
const MOVIE_NOW_STREAMING_WINDOW_DAYS = 14;

// "Now on Blu-ray" takes priority over the digital-release-based labels above, for a title
// whose confirmed US physical (type 5) release date is within this many days -- independent
// of how long it's already been out digitally. A title can be "Just Added" on digital in
// week 1, then months later pick up "Now on Blu-ray" when the disc drops.
const MOVIE_BLURAY_WINDOW_DAYS = 7;

// A movie with a confirmed US digital release date at most this many days out (not yet
// released) is included and tagged "Coming Soon" instead of waiting for the release to
// actually land -- gives titles a preview slot on the list right before they go live.
const MOVIE_COMING_SOON_WINDOW_DAYS = 3;

// Shows: any episode-based tag (Premiere / New Season / New Episode) only applies within a
// week of that episode's air date. Past that, no pill. Season/Series Finale tags use this
// same window on both sides of the air date -- see computeShowContext for how the date is
// shown (or dropped) depending on whether the finale is still upcoming or has already aired.
const SHOW_RECENCY_WINDOW_DAYS = 7;

// Does double duty: (1) a show that hasn't aired its first episode yet only gets "Coming
// Soon" once that premiere is within this many days, and (2) isShowEligible uses the same
// window to decide whether a not-yet-aired show belongs in the Top Shows list at all -- a
// season announced months out doesn't need a slot yet, same reasoning as the movie list's
// MOVIE_COMING_SOON_WINDOW_DAYS. Same value as SHOW_RECENCY_WINDOW_DAYS by design (both mean
// "within a week"), kept as its own constant so the two can be tuned independently later
// without a naming clash.
const SHOW_COMING_SOON_WINDOW_DAYS = 7;

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
async function collectUntilFilled(pathname, resolveItem, targetCount = TARGET_COUNT, maxPages = MAX_PAGES) {
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
 * FOREIGN_MIN_VOTE_COUNT votes on TMDB before they're worth spending a details/verify call
 * on, so a globally popular foreign title (thousands of votes) still gets through while a
 * title that only spiked on a small fandom's watchlist doesn't. Reads straight off the raw
 * trending list item (`original_language`, `vote_count`), no extra request.
 */
function passesLanguagePopularityGate(raw) {
  if (raw.original_language === 'en') return true;
  return (raw.vote_count || 0) >= FOREIGN_MIN_VOTE_COUNT;
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
 * Earliest US release date, of a given TMDB release type, that has already happened
 * (type 4 = Digital, type 5 = Physical), or null if the title has no such release yet.
 */
function usReleaseDateByType(releaseDatesPayload, type) {
  const usEntry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === 'US'
  );
  if (!usEntry) return null;
  const dates = (usEntry.release_dates || [])
    .filter((rd) => rd.type === type && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .filter((d) => daysSince(d) >= 0) // drop dates still in the future
    .sort();
  return dates[0] || null;
}

/**
 * Earliest US digital (type 4) release date, or null. Kept as its own helper since
 * eligibility (does this title have *any* qualifying US release yet) and the physical-
 * release Blu-ray tag both need to read this independently of usReleaseDateByType's type
 * argument at the call site.
 */
function usDigitalReleaseDate(releaseDatesPayload) {
  return usReleaseDateByType(releaseDatesPayload, 4);
}

/** Earliest US physical (type 5, e.g. Blu-ray/DVD) release date, or null. */
function usPhysicalReleaseDate(releaseDatesPayload) {
  return usReleaseDateByType(releaseDatesPayload, 5);
}

/**
 * Earliest US digital (type 4) release date that hasn't happened yet, or null. Mirrors
 * usReleaseDateByType but keeps future dates instead of dropping them, since this is what
 * powers the movie Coming Soon tag.
 */
function usUpcomingDigitalReleaseDate(releaseDatesPayload) {
  const usEntry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === 'US'
  );
  if (!usEntry) return null;
  const dates = (usEntry.release_dates || [])
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
 * within SHOW_COMING_SOON_WINDOW_DAYS -- mirrors the movie list's eligibility rule
 * (usDigitalReleaseDate / usUpcomingDigitalReleaseDate in resolveMovie). No confirmed
 * first_air_date at all means there's nothing to qualify it on, so it's excluded.
 */
function isShowEligible(firstAirDate) {
  if (!firstAirDate) return false;
  const days = daysSince(firstAirDate);
  if (days >= 0) return true;
  return Math.abs(days) <= SHOW_COMING_SOON_WINDOW_DAYS;
}

/**
 * "Now on Blu-ray" takes priority whenever the confirmed US physical release is within
 * MOVIE_BLURAY_WINDOW_DAYS, regardless of how long the title's been out digitally --
 * a disc release is its own newsworthy moment, often months after the digital one.
 * Otherwise: "Just Added" within MOVIE_JUST_ADDED_WINDOW_DAYS of the digital release,
 * "Now Streaming" through MOVIE_NOW_STREAMING_WINDOW_DAYS, "Coming Soon" if the digital
 * release hasn't happened yet but is within MOVIE_COMING_SOON_WINDOW_DAYS, then no pill.
 */
function computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate) {
  const blurayDays = daysSince(physicalReleaseDate);
  if (blurayDays >= 0 && blurayDays <= MOVIE_BLURAY_WINDOW_DAYS) return 'Now on Blu-ray';

  const days = daysSince(digitalReleaseDate);
  if (days <= MOVIE_JUST_ADDED_WINDOW_DAYS) return 'Just Added';
  if (days <= MOVIE_NOW_STREAMING_WINDOW_DAYS) return 'Now Streaming';

  if (isUpcomingWithin(upcomingDigitalReleaseDate, MOVIE_COMING_SOON_WINDOW_DAYS)) return 'Coming Soon';

  return null;
}

/**
 * Short status label for a show, mirroring toptoday.llamayu.com's set:
 * Coming Soon, Premiere, New Episode, New Season, Season Finale [date], Series Finale.
 * Returns null (no pill) once the most recent episode is more than SHOW_RECENCY_WINDOW_DAYS
 * old. Built entirely from fields TMDB's base /tv/{id} response already includes (status,
 * first_air_date, last_episode_to_air, next_episode_to_air, seasons) -- no extra requests
 * needed.
 *
 * Coming Soon is checked before anything else: getTopShows() (unlike getTopMovies()) has no
 * release-date eligibility filter, trending/tv/day can surface a show that's generating
 * anticipation buzz before it's actually aired, so an unreleased show (first_air_date still
 * in the future) needs its own label rather than falling through to the recency logic below,
 * which assumes the show has aired at least one episode. Only shown when the premiere is
 * within SHOW_COMING_SOON_WINDOW_DAYS -- a season announced months out doesn't get a pill yet.
 *
 * Premiere/New Season are checked next, independently of last_episode_to_air, using each
 * season's own air_date: a season whose first-ever episode aired within the window gets its
 * label, full stop, regardless of season number. This matters for Netflix-style drops where
 * a whole season releases the same day -- last_episode_to_air would point at whichever
 * episode aired last (e.g. episode 8 of an 8-episode season), not episode 1, so checking
 * last_episode_to_air alone would misread a same-day season drop as "New Episode" (season 2+)
 * or a plain "Season Finale" instead of "New Season", or miss a brand-new show entirely
 * (season 1 case). Checking the season's own air_date instead catches all of this correctly,
 * and also naturally covers the single-episode-season edge case (a TV movie, one-off
 * special, or a show canceled after one episode, which is technically both the first and
 * last episode of the last season -- that should still read "Premiere", not "Finale").
 *
 * Season/Series Finale: shown *with* a date only while the finale is still upcoming (next
 * SHOW_RECENCY_WINDOW_DAYS days), read off `next_episode_to_air` -- a heads-up that it's
 * coming, not a recap of something that already happened. Once the finale has actually
 * aired (picked up via `last_episode_to_air` instead), the tag stays but the date drops --
 * it's no longer news that it happens "on <date>". The upcoming check can't distinguish
 * Series Finale from Season Finale (TMDB's `status` only flips to Ended/Canceled after the
 * finale airs, so there's no reliable "this is the last season" signal beforehand), so it
 * always says "Season Finale <date>"; Series Finale only appears after the fact. Both checks
 * exclude single-episode seasons (episode_count === 1), since that's really a Premiere, same
 * edge case as above.
 */
function computeShowContext(details) {
  if (details.first_air_date) {
    const premiereDays = daysSince(details.first_air_date);
    if (premiereDays < 0) {
      // Hasn't aired its first episode yet -- only worth flagging within the window.
      return Math.abs(premiereDays) <= SHOW_COMING_SOON_WINDOW_DAYS ? 'Coming Soon' : null;
    }
  }

  const seasons = (details.seasons || []).filter((s) => s.season_number > 0);
  const recentSeason = seasons.find((s) => {
    if (!s.air_date) return false;
    const d = daysSince(s.air_date);
    return d >= 0 && d <= SHOW_RECENCY_WINDOW_DAYS;
  });
  if (recentSeason) return recentSeason.season_number === 1 ? 'Premiere' : 'New Season';

  const next = details.next_episode_to_air;
  if (next && next.air_date) {
    const days = daysSince(next.air_date);
    if (days < 0 && Math.abs(days) <= SHOW_RECENCY_WINDOW_DAYS) {
      const nextSeason = seasons.find((s) => s.season_number === next.season_number);
      const isUpcomingFinale =
        !!nextSeason && nextSeason.episode_count > 1 && next.episode_number === nextSeason.episode_count;
      if (isUpcomingFinale) return `Season Finale ${formatShortDate(next.air_date)}`;
    }
  }

  const ep = details.last_episode_to_air;
  if (!ep || !ep.air_date) return null;

  const days = daysSince(ep.air_date);
  if (days < 0 || days > SHOW_RECENCY_WINDOW_DAYS) return null;

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

async function resolveMovie(m) {
  if (!passesLanguagePopularityGate(m)) return null;

  try {
    const details = await tmdbGet(`/movie/${m.id}`, {
      append_to_response: 'external_ids,release_dates',
    });
    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(m.id, imdbId, m.title, 'movie');
    if (!verified) return null;

    const digitalReleaseDate = usDigitalReleaseDate(details.release_dates);
    const physicalReleaseDate = usPhysicalReleaseDate(details.release_dates);
    const upcomingDigitalReleaseDate = usUpcomingDigitalReleaseDate(details.release_dates);
    const isComingSoon = isUpcomingWithin(upcomingDigitalReleaseDate, MOVIE_COMING_SOON_WINDOW_DAYS);
    // Eligible if it's already out digitally/physically in the US, or if it's not out yet
    // but the confirmed digital release is imminent (Coming Soon window).
    if (!digitalReleaseDate && !physicalReleaseDate && !isComingSoon) return null;

    return {
      imdbId,
      name: m.title,
      poster_path: m.poster_path,
      backdrop_path: details.backdrop_path,
      releaseInfo: (m.release_date || '').slice(0, 4),
      context: computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate),
      description: details.overview || undefined,
      genres: (details.genres || []).map((g) => g.name),
      imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
      runtime: formatRuntime(details.runtime),
    };
  } catch {
    return null;
  }
}

async function resolveShow(s) {
  if (!passesLanguagePopularityGate(s)) return null;

  try {
    const details = await tmdbGet(`/tv/${s.id}`, { append_to_response: 'external_ids' });
    if (!isShowEligible(details.first_air_date)) return null;

    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(s.id, imdbId, s.name, 'tv');
    if (!verified) return null;

    return {
      imdbId,
      name: s.name,
      poster_path: s.poster_path,
      backdrop_path: details.backdrop_path,
      releaseInfo: (s.first_air_date || '').slice(0, 4),
      context: computeShowContext(details),
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
 * Top 20 movies trending today (TMDB trending/movie/day), filtered to only titles with a
 * confirmed US digital or physical release (so theatrical-only titles are still excluded,
 * same rule as before), plus titles whose digital release is confirmed but still up to
 * MOVIE_COMING_SOON_WINDOW_DAYS away (tagged Coming Soon by computeMovieContext). Pages
 * through trending results (up to MAX_PAGES) until 20 pass, instead of pulling one fixed
 * pool -- see the comment at the top of this file for why.
 */
async function getTopMovies() {
  return collectUntilFilled('/trending/movie/day', resolveMovie);
}

/**
 * Top 20 shows trending today (TMDB trending/tv/day), US region context, filtered to shows
 * that have already aired at least one episode or premiere within SHOW_COMING_SOON_WINDOW_DAYS
 * (see isShowEligible). Pages through trending results (up to MAX_PAGES) until 20 pass, same
 * as getTopMovies() -- see the comment at the top of this file for why.
 */
async function getTopShows() {
  return collectUntilFilled('/trending/tv/day', resolveShow);
}

module.exports = { getTopMovies, getTopShows };
