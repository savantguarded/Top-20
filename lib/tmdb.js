// lib/tmdb.js
// Talks to TMDB. Two lists:
//  - getTopMovies(): TMDB's daily trending movies, filtered down to only titles that
//    actually have a confirmed US digital or physical release (TMDB release type codes:
//    1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV -- so
//    theatrical-only titles are still excluded, same rule as before, just sourced from
//    a list that genuinely refreshes daily instead of an all-time popularity sort that
//    barely moved).
//  - getTopShows(): TMDB's daily trending TV list, US region.
// Both resolve each title's imdb_id (needed for the poster source and for Stremio to match
// the item across other addons) and verify it via /find before trusting it. That verification
// step can drop a small number of candidates, so both functions pull a larger raw pool
// (POOL_SIZE) than the final 20 needed, so the catalog still comes back full.
//
// Both also work out a short status label ("Just Added", "New Episode", "Season Finale", etc,
// see computeMovieContext / computeShowContext below) purely from fields TMDB already returns
// in the same requests -- no extra API calls, no database, no cron job.

const TMDB_BASE = 'https://api.themoviedb.org/3';
const POOL_SIZE = 30;
const TARGET_COUNT = 20;
const RECENCY_WINDOW_DAYS = 7;

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

/**
 * Fetch consecutive pages from a TMDB list endpoint until at least `poolSize`
 * raw results are collected (or TMDB runs out of pages), preserving order.
 */
async function fetchPool(pathname, baseParams, poolSize) {
  let results = [];
  let page = 1;
  let totalPages = Infinity;
  while (results.length < poolSize && page <= totalPages) {
    const data = await tmdbGet(pathname, { ...baseParams, page });
    const pageResults = data.results || [];
    totalPages = data.total_pages || page;
    results = results.concat(pageResults);
    if (pageResults.length === 0) break;
    page += 1;
  }
  return results.slice(0, poolSize);
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
 * Earliest US digital/physical (release type 4 or 5) release date that has
 * already happened, or null if the title has no such release yet.
 */
function usDigitalReleaseDate(releaseDatesPayload) {
  const usEntry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === 'US'
  );
  if (!usEntry) return null;
  const dates = (usEntry.release_dates || [])
    .filter((rd) => (rd.type === 4 || rd.type === 5) && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .filter((d) => daysSince(d) >= 0) // drop dates still in the future
    .sort();
  return dates[0] || null;
}

function computeMovieContext(digitalReleaseDate) {
  return daysSince(digitalReleaseDate) <= RECENCY_WINDOW_DAYS ? 'Just Added' : 'Now Streaming';
}

/**
 * Short status label for a show, mirroring toptoday.llamayu.com's set:
 * Premiere, New Episode, New Season, Season Finale, Finale <date>, Now Streaming.
 * Built entirely from fields TMDB's base /tv/{id} response already includes
 * (status, last_episode_to_air, seasons) -- no extra requests needed.
 */
function computeShowContext(details) {
  const ep = details.last_episode_to_air;
  if (!ep || !ep.air_date) return 'Now Streaming';

  const days = daysSince(ep.air_date);
  if (days < 0 || days > RECENCY_WINDOW_DAYS) return 'Now Streaming';

  const seasons = (details.seasons || []).filter((s) => s.season_number > 0);
  const season = seasons.find((s) => s.season_number === ep.season_number);
  const isSeasonFinaleEp = !!season && ep.episode_number === season.episode_count;
  const maxSeasonNumber = seasons.length
    ? Math.max(...seasons.map((s) => s.season_number))
    : ep.season_number;
  const isLastSeason = ep.season_number === maxSeasonNumber;
  const showEnded = details.status === 'Ended' || details.status === 'Canceled';

  if (isSeasonFinaleEp && isLastSeason && showEnded) return `Finale ${formatShortDate(ep.air_date)}`;
  if (ep.episode_number === 1 && ep.season_number === 1) return 'Premiere';
  if (ep.episode_number === 1 && ep.season_number > 1) return 'New Season';
  if (isSeasonFinaleEp) return 'Season Finale';
  return 'New Episode';
}

/**
 * Top 20 movies trending today (TMDB trending/movie/day), filtered to only
 * titles with a confirmed US digital or physical release (so theatrical-only
 * titles are still excluded, same rule as before -- just sourced from a list
 * that actually refreshes daily instead of an all-time popularity sort).
 */
async function getTopMovies() {
  const pool = await fetchPool('/trending/movie/day', {}, POOL_SIZE);

  const withIds = await Promise.all(
    pool.map(async (m) => {
      try {
        const details = await tmdbGet(`/movie/${m.id}`, {
          append_to_response: 'external_ids,release_dates',
        });
        const imdbId = details.external_ids && details.external_ids.imdb_id;
        if (!imdbId) return null;

        const verified = await verifyImdbMatch(m.id, imdbId, m.title, 'movie');
        if (!verified) return null;

        const digitalReleaseDate = usDigitalReleaseDate(details.release_dates);
        if (!digitalReleaseDate) return null; // not out digitally/physically in the US yet

        return {
          imdbId,
          name: m.title,
          poster_path: m.poster_path,
          releaseInfo: (m.release_date || '').slice(0, 4),
          context: computeMovieContext(digitalReleaseDate),
        };
      } catch {
        return null;
      }
    })
  );

  return withIds.filter(Boolean).slice(0, TARGET_COUNT);
}

/**
 * Top 20 shows trending today (TMDB trending/tv/day), US region context.
 */
async function getTopShows() {
  const pool = await fetchPool('/trending/tv/day', {}, POOL_SIZE);

  const withIds = await Promise.all(
    pool.map(async (s) => {
      try {
        const details = await tmdbGet(`/tv/${s.id}`, { append_to_response: 'external_ids' });
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
        };
      } catch {
        return null;
      }
    })
  );

  return withIds.filter(Boolean).slice(0, TARGET_COUNT);
}

module.exports = { getTopMovies, getTopShows };
