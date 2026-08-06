// lib/tmdb.js
// Talks to TMDB. Two lists:
//  - getTopMovies(): US movies currently out digitally or on home release (not theatrical-only),
//    ranked by popularity. Uses TMDB's discover endpoint with with_release_type=4|5
//    (TMDB release type codes: 1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital,
//    5 Physical, 6 TV — so this is Digital OR Physical, deliberately excluding theatrical/TV).
//  - getTopShows(): TMDB's daily trending TV list, US region.
// Both resolve each title's imdb_id (needed for the poster source and for Stremio to match
// the item across other addons), and both come back pre-capped at 20 (TMDB's default page size).

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
 * Top 20 movies, US, released digitally or on home release only (release types
 * 4 = Digital, 5 = Physical), ranked by popularity, excludes anything whose
 * regional release date hasn't happened yet.
 */
async function getTopMovies() {
  const discover = await tmdbGet('/discover/movie', {
    region: 'US',
    sort_by: 'popularity.desc',
    with_release_type: '4|5',
    'release_date.lte': todayISO(),
    include_adult: 'false',
    page: 1,
  });

  const results = (discover.results || []).slice(0, 20);

  const withIds = await Promise.all(
    results.map(async (m) => {
      try {
        const details = await tmdbGet(`/movie/${m.id}`, { append_to_response: 'external_ids' });
        const imdbId = details.external_ids && details.external_ids.imdb_id;
        if (!imdbId) return null;

        const verified = await verifyImdbMatch(m.id, imdbId, m.title, 'movie');
        if (!verified) return null;

        return {
          imdbId,
          name: m.title,
          poster_path: m.poster_path,
          releaseInfo: (m.release_date || '').slice(0, 4),
        };
      } catch {
        return null;
      }
    })
  );

  return withIds.filter(Boolean).slice(0, 20);
}

/**
 * Top 20 shows trending today (TMDB trending/tv/day), US region context.
 */
async function getTopShows() {
  const trending = await tmdbGet('/trending/tv/day', {});
  const results = (trending.results || []).slice(0, 20);

  const withIds = await Promise.all(
    results.map(async (s) => {
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
        };
      } catch {
        return null;
      }
    })
  );

  return withIds.filter(Boolean).slice(0, 20);
}

module.exports = { getTopMovies, getTopShows };
