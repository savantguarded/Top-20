// lib/tmdb.js

const { getConfig } = require('./config');

const TMDB_BASE = 'https://api.themoviedb.org/3';

// Sleep helper to force pauses between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    throw new Error(`TMDB ${pathname} failed: ${res.status}`);
  }
  return res.json();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

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

function formatRuntime(minutes) {
  if (!minutes) return undefined;
  return `${minutes} min`;
}

async function collectUntilFilled(pathname, resolveItem, targetCount, maxPages) {
  const passing = [];
  const seenRawIds = new Set();
  const seenImdbIds = new Set();
  let page = 1;
  let totalPages = Infinity;
  
  let lastError = null;

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

    // BATCH FETCHING: Process 5 items at a time, then pause 250ms.
    // Caps requests at 40 per second (TMDB limit is 50/sec).
    for (let i = 0; i < uniquePageResults.length; i += 5) {
      const chunk = uniquePageResults.slice(i, i + 5);
      
      const resolved = await Promise.all(chunk.map(async (raw) => {
        try {
          return await resolveItem(raw);
        } catch (err) {
          lastError = err.message;
          return null;
        }
      }));

      for (const item of resolved) {
        if (passing.length >= targetCount) break;
        if (!item) continue;
        if (seenImdbIds.has(item.imdbId)) continue;
        seenImdbIds.add(item.imdbId);
        passing.push(item);
      }
      if (passing.length >= targetCount) break;

      // Mandatory pause to respect TMDB rate limits
      await sleep(250);
    }
    page += 1;
  }

  // FAILSAFE: If list is empty, throw the last logged error to the browser screen
  if (passing.length === 0 && lastError) {
    throw new Error(`All items dropped. Last TMDB error: ${lastError}`);
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
  return na.includes(nb) || nb.includes(na);
}

function passesLanguagePopularityGate(raw, minVoteCount) {
  if (raw.original_language === 'en') return true;
  return (raw.vote_count || 0) >= minVoteCount;
}

async function verifyImdbMatch(tmdbId, imdbId, title, kind) {
  const found = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const bucket = kind === 'movie' ? found.movie_results : found.tv_results;
  if (!bucket || !bucket.length) return false;
  const match = bucket.find((r) => r.id === tmdbId);
  if (!match) return false;
  const matchTitle = kind === 'movie' ? match.title : match.name;
  return titlesRoughlyMatch(title, matchTitle);
}

function regionReleaseDateByType(releaseDatesPayload, type, region) {
  const entry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === region
  );
  if (!entry) return null;
  const dates = (entry.release_dates || [])
    .filter((rd) => rd.type === type && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .filter((d) => daysSince(d) >= 0)
    .sort();
  return dates[0] || null;
}

function regionDigitalReleaseDate(releaseDatesPayload, region) {
  return regionReleaseDateByType(releaseDatesPayload, 4, region);
}

function regionPhysicalReleaseDate(releaseDatesPayload, region) {
  return regionReleaseDateByType(releaseDatesPayload, 5, region);
}

function regionUpcomingDigitalReleaseDate(releaseDatesPayload, region) {
  const entry = ((releaseDatesPayload && releaseDatesPayload.results) || []).find(
    (r) => r.iso_3166_1 === region
  );
  if (!entry) return null;
  const dates = (entry.release_dates || [])
    .filter((rd) => rd.type === 4 && rd.release_date)
    .map((rd) => rd.release_date.slice(0, 10))
    .filter((d) => daysSince(d) < 0)
    .sort();
  return dates[0] || null;
}

function isUpcomingWithin(dateStr, windowDays) {
  if (!dateStr) return false;
  const days = daysSince(dateStr);
  return days < 0 && Math.abs(days) <= windowDays;
}

function isShowEligible(firstAirDate, comingSoonWindowDays) {
  if (!firstAirDate) return false;
  const days = daysSince(firstAirDate);
  if (days >= 0) return true;
  return Math.abs(days) <= comingSoonWindowDays;
}

function computeMovieContext(digitalReleaseDate, physicalReleaseDate, upcomingDigitalReleaseDate, movieCfg) {
  const blurayDays = daysSince(physicalReleaseDate);
  if (blurayDays >= 0 && blurayDays <= movieCfg.blurayWindowDays) return 'Now on Blu-ray';

  const days = daysSince(digitalReleaseDate);
  if (days <= movieCfg.justAddedWindowDays) return 'Just Added';
  if (days <= movieCfg.nowStreamingWindowDays) return 'Now Streaming';

  if (isUpcomingWithin(upcomingDigitalReleaseDate, movieCfg.comingSoonWindowDays)) return 'Coming Soon';

  return null;
}

function computeShowContext(details, showCfg) {
  if (details.first_air_date) {
    const premiereDays = daysSince(details.first_air_date);
    if (premiereDays < 0) {
      return Math.abs(premiereDays) <= showCfg.comingSoonWindowDays ? 'Coming Soon' : null;
    }
  }

  const seasons = (details.seasons || []).filter((s) => s.season_number > 0);
  const recentSeason = seasons.find((s) => {
    if (!s.air_date) return false;
    const d = daysSince(s.air_date);
    return d >= 0 && d <= showCfg.recencyWindowDays;
  });
  if (recentSeason) return recentSeason.season_number === 1 ? 'Premiere' : 'New Season';

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
  if (!ep || !ep.air_date) return null;

  const days = daysSince(ep.air_date);
  if (days < 0 || days > showCfg.recencyWindowDays) return null;

  const season = seasons.find((s) => s.season_number === ep.season_number);
  const isSeasonFinaleEp = !!season && ep.episode_number === season.episode_count;
  const maxSeasonNumber = seasons.length
    ? Math.max(...seasons.map((s) => s.season_number))
    : ep.season_number;
  const isLastSeason = ep.season_number === maxSeasonNumber;
  const showEnded = details.status === 'Ended' || details.status === 'Canceled';

  if (isSeasonFinaleEp && isLastSeason && showEnded) return 'Series Finale';
  if (isSeasonFinaleEp) return 'Season Finale';
  return 'New Episode';
}

async function resolveMovie(m, cfg) {
  if (!passesLanguagePopularityGate(m, cfg.foreignMinVoteCount)) return null;

  // Removed the inner try/catch block so collectUntilFilled catches the TMDB error
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

  if (!digitalReleaseDate && !physicalReleaseDate && !isComingSoon) return null;

  return {
    tmdbId: m.id,
    imdbId,
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
}

async function resolveShow(s, cfg) {
  if (!passesLanguagePopularityGate(s, cfg.foreignMinVoteCount)) return null;

  // Removed the inner try/catch block so collectUntilFilled catches the TMDB error
  const details = await tmdbGet(`/tv/${s.id}`, { append_to_response: 'external_ids' });
  if (!isShowEligible(details.first_air_date, cfg.show.comingSoonWindowDays)) return null;

  const imdbId = details.external_ids && details.external_ids.imdb_id;
  if (!imdbId) return null;

  const verified = await verifyImdbMatch(s.id, imdbId, s.name, 'tv');
  if (!verified) return null;

  return {
    tmdbId: s.id,
    imdbId,
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
}

async function getTopMovies() {
  const cfg = await getConfig();
  return collectUntilFilled(
    '/trending/movie/day',
    (m) => resolveMovie(m, cfg),
    cfg.catalogSize,
    cfg.maxPages
  );
}

async function getTopShows() {
  const cfg = await getConfig();
  return collectUntilFilled(
    '/trending/tv/day',
    (s) => resolveShow(s, cfg),
    cfg.catalogSize,
    cfg.maxPages
  );
}

module.exports = { getTopMovies, getTopShows };