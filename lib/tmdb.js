// lib/tmdb.js
// Talks to TMDB. Two lists:
//  - getTopMovies(): TMDB's daily trending movies, filtered down to only titles that
//    actually have a confirmed US digital or physical release (TMDB release type codes:
//    1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV -- so
//    theatrical-only titles are still excluded, same rule as before).
//  - getTopShows(): TMDB's daily trending TV list, US region.
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

// Shows: any episode-based tag (Premiere / New Season / New Episode / Season Finale <date> /
// series Finale) only applies within a week of that episode's air date. Past that, no pill.
const SHOW_RECENCY_WINDOW_DAYS = 7;

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

// TMDB serves provider logos as relative paths off this base; w45 is plenty for a small
// corner badge and keeps the extra poster-fetch this adds lightweight.
const TMDB_PROVIDER_LOGO_BASE = 'https://image.tmdb.org/t/p/w92';

/**
 * Pick the one streaming service to badge onto the poster, out of however many a title's
 * flatrate providers list has for the US. TMDB returns that list pre-sorted by its own
 * display_priority (a JustWatch-derived popularity/prominence ranking, lowest number =
 * most prominent), so taking the first entry is the same "which logo would a human show
 * first" call TMDB itself makes -- no separate provider allowlist to maintain.
 */
function primaryUsProvider(watchProvidersPayload) {
  const us = (watchProvidersPayload && watchProvidersPayload.results && watchProvidersPayload.results.US) || null;
  const flatrate = (us && us.flatrate) || [];
  if (!flatrate.length) return undefined;
  const top = [...flatrate].sort((a, b) => (a.display_priority || 0) - (b.display_priority || 0))[0];
  if (!top || !top.logo_path) return undefined;
  return {
    name: top.provider_name,
    logo: `${TMDB_PROVIDER_LOGO_BASE}${top.logo_path}`,
  };
}

/**
 * "Now on Blu-ray" takes priority whenever the confirmed US physical release is within
 * MOVIE_BLURAY_WINDOW_DAYS, regardless of how long the title's been out digitally --
 * a disc release is its own newsworthy moment, often months after the digital one.
 * Otherwise: "Just Added" within MOVIE_JUST_ADDED_WINDOW_DAYS of the digital release,
 * "Now Streaming" through MOVIE_NOW_STREAMING_WINDOW_DAYS, then no pill.
 */
function computeMovieContext(digitalReleaseDate, physicalReleaseDate) {
  const blurayDays = daysSince(physicalReleaseDate);
  if (blurayDays >= 0 && blurayDays <= MOVIE_BLURAY_WINDOW_DAYS) return 'Now on Blu-ray';

  const days = daysSince(digitalReleaseDate);
  if (days <= MOVIE_JUST_ADDED_WINDOW_DAYS) return 'Just Added';
  if (days <= MOVIE_NOW_STREAMING_WINDOW_DAYS) return 'Now Streaming';
  return null;
}

/**
 * Short status label for a show, mirroring toptoday.llamayu.com's set:
 * Premiere, New Episode, New Season, Season Finale <date>, Finale <date>. Returns null (no pill)
 * once the most recent episode is more than SHOW_RECENCY_WINDOW_DAYS old. Built entirely
 * from fields TMDB's base /tv/{id} response already includes (status, last_episode_to_air,
 * seasons) -- no extra requests needed.
 *
 * Premiere is checked first, independently of last_episode_to_air, using season 1's own
 * air_date: a show whose first-ever episode aired within the window is a premiere, full
 * stop. This matters for Netflix-style drops where a whole first season releases the same
 * day -- last_episode_to_air would point at episode 6 or 8 of season 1 (whichever aired
 * last), not episode 1, so checking last_episode_to_air alone would misread a brand-new
 * show as a plain "New Episode". Checking season 1's air_date instead catches it correctly,
 * and also naturally covers the single-episode-season edge case (a TV movie, one-off
 * special, or a show canceled after one episode, which is technically both the first and
 * last episode of the last season -- that should still read "Premiere", not "Finale").
 */
function computeShowContext(details) {
  const seasonOne = (details.seasons || []).find((s) => s.season_number === 1);
  if (seasonOne && seasonOne.air_date) {
    const seasonOneDays = daysSince(seasonOne.air_date);
    if (seasonOneDays >= 0 && seasonOneDays <= SHOW_RECENCY_WINDOW_DAYS) return 'Premiere';
  }

  const ep = details.last_episode_to_air;
  if (!ep || !ep.air_date) return null;

  const days = daysSince(ep.air_date);
  if (days < 0 || days > SHOW_RECENCY_WINDOW_DAYS) return null;

  const seasons = (details.seasons || []).filter((s) => s.season_number > 0);
  const season = seasons.find((s) => s.season_number === ep.season_number);
  const isSeasonFinaleEp = !!season && ep.episode_number === season.episode_count;
  const maxSeasonNumber = seasons.length
    ? Math.max(...seasons.map((s) => s.season_number))
    : ep.season_number;
  const isLastSeason = ep.season_number === maxSeasonNumber;
  const showEnded = details.status === 'Ended' || details.status === 'Canceled';

  if (isSeasonFinaleEp && isLastSeason && showEnded) return `Finale ${formatShortDate(ep.air_date)}`;
  if (ep.episode_number === 1 && ep.season_number > 1) return 'New Season';
  if (isSeasonFinaleEp) return `Season Finale ${formatShortDate(ep.air_date)}`;
  return 'New Episode';
}

async function resolveMovie(m) {
  if (!passesLanguagePopularityGate(m)) return null;

  try {
    const details = await tmdbGet(`/movie/${m.id}`, {
      append_to_response: 'external_ids,release_dates,watch/providers',
    });
    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(m.id, imdbId, m.title, 'movie');
    if (!verified) return null;

    const digitalReleaseDate = usDigitalReleaseDate(details.release_dates);
    const physicalReleaseDate = usPhysicalReleaseDate(details.release_dates);
    if (!digitalReleaseDate && !physicalReleaseDate) return null; // not out digitally/physically in the US yet

    return {
      imdbId,
      name: m.title,
      poster_path: m.poster_path,
      releaseInfo: (m.release_date || '').slice(0, 4),
      context: computeMovieContext(digitalReleaseDate, physicalReleaseDate),
      provider: primaryUsProvider(details['watch/providers']),
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
    const details = await tmdbGet(`/tv/${s.id}`, {
      append_to_response: 'external_ids,watch/providers',
    });
    const imdbId = details.external_ids && details.external_ids.imdb_id;
    if (!imdbId) return null;

    const verified = await verifyImdbMatch(s.id, imdbId, s.name, 'tv');
    if (!verified) return null;

    return {
      imdbId,
      name: s.name,
      poster_path: s.poster_path,
      releaseInfo: (s.first_air_date || '').slice(0, 4),
      context: computeShowContext(details),
      provider: primaryUsProvider(details['watch/providers']),
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
 * Top 20 movies trending today (TMDB trending/movie/day), filtered to only
 * titles with a confirmed US digital or physical release (so theatrical-only
 * titles are still excluded, same rule as before). Pages through trending
 * results (up to MAX_PAGES) until 20 pass, instead of pulling one fixed pool
 * -- see the comment at the top of this file for why.
 */
async function getTopMovies() {
  return collectUntilFilled('/trending/movie/day', resolveMovie);
}

/**
 * Top 20 shows trending today (TMDB trending/tv/day), US region context.
 */
async function getTopShows() {
  return collectUntilFilled('/trending/tv/day', resolveShow);
}

module.exports = { getTopMovies, getTopShows };
