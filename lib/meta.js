// lib/meta.js
// Builds a full Stremio `meta` object for a single title (movie or series), by imdb id
// (e.g. "tt1234567") -- served at /meta/:type/:id.json (see api/meta.js + vercel.json).
//
// This exists purely as a fallback. This addon's *catalog* is deliberately thin (see the
// header comment in api/catalog.js) so a real meta addon like aiometadata owns the detail
// page. But both Nuvio and Stremio only try a second `meta`-declaring addon once every addon
// ahead of it in the user's install order has already returned nothing for that id -- and
// Nuvio's own built-in TMDB fallback (Settings -> TMDB) only fires for `tmdb:`-prefixed
// catalog ids, not the `tt...` imdb ids this addon (and most Stremio catalog addons) hand
// out. So when the primary meta addon has no data for a title, there was previously nothing
// else to fall back to. This gives Nuvio/Stremio something to try next, built from data this
// project already has an API key and helper functions for (see lib/tmdb.js). Full research
// trail in the project's progress log, Session 14/15.
//
// Deliberately a fallback, not a competitor: which meta addon gets tried first is decided by
// install order in Nuvio/Stremio's own addon list, not by anything in this code -- this addon
// should stay listed AFTER aiometadata so it's only ever reached when aiometadata comes back
// empty for a given title.

const { tmdbGet, formatRuntime } = require('./tmdb');

// A handful of long-running procedurals have 20+ seasons -- fetching every season's full
// episode list for one of those means 20+ extra TMDB calls (in parallel, but still) on a
// single request. Past this cap, the meta response still comes back with full basic info
// (name/poster/description/cast/genres/etc), it just won't carry a per-episode `videos`
// array -- same fail-soft philosophy as the rest of this addon (poster.js's provider
// timeout, verifyImdbMatch's try/catch-to-false in lib/tmdb.js): a fallback that mostly
// works beats one that times out trying to be complete.
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

function isoDate(dateStr) {
  if (!dateStr) return undefined;
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Top cast names, writer(s), and director(s) -- all from a single `append_to_response=credits`
 * call on the /movie or /tv details request, no extra requests.
 *
 * `seriesCreators` (TMDB's own `created_by`, movies don't have this field) takes over the
 * `director` slot for a series when present: TMDB's per-title `credits.crew` almost never has
 * a "Director" job entry for a TV show (direction is credited per-episode, not per-series --
 * confirmed against a real Breaking Bad fetch while building this, `credits.crew` came back
 * with zero Director entries even though the show obviously has directors), so falling back
 * to crew-Director alone would leave `director` empty for most shows. The showrunner/creator
 * is the closest per-series equivalent, and matches how other Stremio meta addons (Cinemeta
 * included) fill this field for TV.
 *
 * Writer stays crew-based for both types, but only a real screenwriting credit (Writer or
 * Screenplay) counts -- an earlier version also matched anything in the "Writing" department,
 * which pulled in source-material credits like "Book" (confirmed against Oppenheimer: Kai
 * Bird and Martin Sherwin, credited for the biography it's based on, both have department
 * "Writing" but job "Book" -- not screenwriters).
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

/** Stremio's per-episode `videos` array, id'd as "<imdbId>:<season>:<episode>" -- matches the
 * convention every Stremio-compatible client (Nuvio included, confirmed against its own
 * MetaDetailsRepository.findEmbeddedStreams()) expects for matching a stream/progress entry
 * back to an episode. One TMDB call per season (`/tv/{id}/season/{n}`), run in parallel and
 * individually timed out -- a single slow/failed season is dropped from the list rather than
 * failing the whole meta response (Promise.allSettled, not Promise.all). Skipped entirely
 * (returns []) for shows with more seasons than MAX_SEASONS_FOR_EPISODES, or with no
 * numbered seasons at all.
 */
async function fetchSeasonVideos(tmdbId, imdbId, seasons) {
  const eligible = seasons.filter((s) => s.season_number > 0);
  if (!eligible.length || eligible.length > MAX_SEASONS_FOR_EPISODES) return [];

  const results = await Promise.allSettled(
    eligible.map((s) => tmdbGetWithTimeout(`/tv/${tmdbId}/season/${s.season_number}`, {}, SEASON_FETCH_TIMEOUT_MS))
  );

  const videos = [];
  results.forEach((r, idx) => {
    if (r.status !== 'fulfilled') return; // that one season just gets dropped, not the whole response
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
    videos = []; // episode-list trouble should never take down the base meta response
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

/** Full Stremio meta object for `type`/`id` (id is an imdb id, e.g. "tt1234567"), or null if
 * TMDB has no matching record for it. Never throws -- api/meta.js treats a null/failed result
 * as "nothing to fall back to here either", the same as any other addon with no data for
 * this id. */
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
