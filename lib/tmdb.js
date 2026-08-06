// lib/tmdb.js
// Talks to TMDB. Two lists:
//  - getTopMovies(): US movies currently out digitally or on home release (not theatrical-only),
//    ranked by popularity. Uses TMDB's discover endpoint with with_release_type=4|6 (Digital, Physical).
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

/**
 * Top 20 movies, US, released digitally or on home release only (release types
 * 4 = Digital, 6 = Physical), ranked by popularity, excludes anything whose
 * regional release date hasn't happened yet.
 */
async function getTopMovies() {
  const discover = await tmdbGet('/discover/movie', {
    region: 'US',
    sort_by: 'popularity.desc',
    with_release_type: '4|6',
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
