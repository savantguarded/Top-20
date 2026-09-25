// lib/meta.js
// Fallback `meta` resource (/meta/:type/:id.json) built from TMDB, for titles the primary meta
// addon (e.g. AIOMetadata) has no data for. Nuvio/Stremio only try a later meta addon once the
// ones ahead of it return nothing, so keep this addon listed after the primary one.

const { tmdbGet } = require('./tmdb');

// Past this many seasons the meta comes back without per-episode `videos` (one call per season).
const MAX_SEASONS_FOR_EPISODES = 20;
const SEASON_FETCH_TIMEOUT_MS = 6000;

async function tmdbGetWithTimeout(pathname, params, timeoutMs) {
  return Promise.race([
    tmdbGet(pathname, params),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('TMDB request timed out')), timeoutMs);
    }),
  ]);
}

function formatRuntime(minutes) {
  return minutes ? `${minutes} min` : undefined;
}

function isoDate(dateStr) {
  if (!dateStr) return undefined;
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Cast, director, writer from `credits`. Series use `created_by` as director (TMDB credits
 * direction per episode, so series-level crew rarely has a Director). Writers are Writer or
 * Screenplay credits only (not source material like "Book").
 */
function creditsFromDetails(details, { seriesCreators } = {}) {
  const credits = details.credits || {};
  const cast = (credits.cast || [])
    .slice(0, 10)
    .map((c) => c.name)
    .filter(Boolean);
  const crewDirectors = (credits.crew || [])
    .filter((c) => c.job === 'Director')
    .map((c) => c.name)
    .filter(Boolean);
  const director = seriesCreators && seriesCreators.length ? seriesCreators : crewDirectors;
  const writer = (credits.crew || [])
    .filter((c) => c.job === 'Writer' || c.job === 'Screenplay')
    .map((c) => c.name)
    .filter((name, idx, arr) => name && arr.indexOf(name) === idx)
    .slice(0, 5);
  return { cast, director, writer };
}

/** Per-episode `videos`, id'd "<imdbId>:<season>:<episode>". Failed seasons are just dropped. */
async function fetchSeasonVideos(tmdbId, imdbId, seasons) {
  const eligible = seasons.filter((s) => s.season_number > 0);
  if (!eligible.length || eligible.length > MAX_SEASONS_FOR_EPISODES) return [];

  const results = await Promise.allSettled(
    eligible.map((s) => tmdbGetWithTimeout(`/tv/${tmdbId}/season/${s.season_number}`, {}, SEASON_FETCH_TIMEOUT_MS))
  );

  const videos = [];
  results.forEach((r, idx) => {
    if (r.status !== 'fulfilled') return;
    const season = eligible[idx];
    for (const ep of r.value.episodes || []) {
      videos.push({
        id: `${imdbId}:${season.season_number}:${ep.episode_number}`,
        title: ep.name || `Episode ${ep.episode_number}`,
        season: season.season_number,
        episode: ep.episode_number,
        released: isoDate(ep.air_date),
        overview: ep.overview || undefined,
        thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : undefined,
      });
    }
  });

  videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return videos;
}

async function fetchMovieMeta(imdbId) {
  const found = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const hit = (found.movie_results || [])[0];
  if (!hit) return null;

  const details = await tmdbGet(`/movie/${hit.id}`, { append_to_response: 'credits' });
  const { cast, director, writer } = creditsFromDetails(details);

  return {
    id: imdbId,
    type: 'movie',
    name: details.title || hit.title,
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined,
    background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : undefined,
    description: details.overview || undefined,
    releaseInfo: (details.release_date || '').slice(0, 4) || undefined,
    imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
    runtime: formatRuntime(details.runtime),
    genres: (details.genres || []).map((g) => g.name),
    cast: cast.length ? cast : undefined,
    director: director.length ? director : undefined,
    writer: writer.length ? writer : undefined,
  };
}

async function fetchSeriesMeta(imdbId) {
  const found = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const hit = (found.tv_results || [])[0];
  if (!hit) return null;

  const details = await tmdbGet(`/tv/${hit.id}`, { append_to_response: 'credits' });
  const seriesCreators = (details.created_by || []).map((c) => c.name).filter(Boolean);
  const { cast, director, writer } = creditsFromDetails(details, { seriesCreators });

  let videos = [];
  try {
    videos = await fetchSeasonVideos(hit.id, imdbId, details.seasons || []);
  } catch {
    videos = [];
  }

  return {
    id: imdbId,
    type: 'series',
    name: details.name || hit.name,
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined,
    background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : undefined,
    description: details.overview || undefined,
    releaseInfo: (details.first_air_date || '').slice(0, 4) || undefined,
    imdbRating: details.vote_average ? details.vote_average.toFixed(1) : undefined,
    runtime: formatRuntime((details.episode_run_time || [])[0]),
    genres: (details.genres || []).map((g) => g.name),
    cast: cast.length ? cast : undefined,
    director: director.length ? director : undefined,
    writer: writer.length ? writer : undefined,
    videos: videos.length ? videos : undefined,
  };
}

/** Stremio meta for an imdb id, or null. Never throws. */
async function fetchMeta(type, id) {
  try {
    if (type === 'movie') return await fetchMovieMeta(id);
    if (type === 'series') return await fetchSeriesMeta(id);
    return null;
  } catch {
    return null;
  }
}

module.exports = { fetchMeta };
