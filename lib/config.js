// lib/config.js
// Runtime settings: DEFAULTS overlaid with the "topTwentyConfig" item in Vercel Edge Config.
// /backstage (api/config.js) edits that item; changes apply within seconds, no redeploy. With
// no EDGE_CONFIG env var, or on any read error, everything silently uses DEFAULTS.

const BETTER_POSTERS_URL = 'https://btttr.cc/poster-n/imdb/poster-default/{imdbId}.jpg?tag=none';

const ART_MODES = {
  // Portrait:  tmdb = TMDB's own poster (title art included), untouched
  //            alternate = textless TMDB poster + our clearlogo above the pill
  //            betterposters = BETTER_POSTERS_URL; custom = posterUrlTemplate
  poster: ['tmdb', 'alternate', 'betterposters', 'custom'],
  // Landscape: tmdb = TMDB backdrop with the logo already in it (else falls back to alternate)
  //            alternate = textless TMDB backdrop, distinct from the main one, + our clearlogo
  //            custom = backdropUrlTemplate
  landscape: ['tmdb', 'alternate', 'custom'],
};

// The installable catalogs. Names and order are editable on /backstage (cfg.catalogs); ids and
// types are fixed, since clients key watched state and row settings on them.
const CATALOGS = [
  { type: 'movie', id: 'top-movies-today', name: 'Top Movies Today' },
  { type: 'series', id: 'top-shows-today', name: 'Top Shows Today' },
];
const CATALOG_NAME_MAX = 40;

const DEFAULTS = {
  region: 'US', // country used for release-date checks
  catalogSize: 20,
  maxPages: 6, // cap on trending pages scanned to fill catalogSize
  foreignMinVoteCount: 50, // non-English candidates need this many TMDB votes

  posterArt: 'alternate',
  landscapeArt: 'alternate',
  // Provider templates for the 'custom' modes. Placeholders: {imdbId}/{id}, {tmdb_id}, {type}
  // (movie/tv), {tmdb_key}, {mdblist_key}, {backdrop_path}. See buildImageUrl() in api/poster.js.
  posterUrlTemplate: BETTER_POSTERS_URL,
  backdropUrlTemplate: 'https://image.tmdb.org/t/p/w1280{backdrop_path}',

  // Alternate TMDB art steps through up to artRotationPool distinct images per title, one per
  // artRotationHours (staggered per title; see lib/art.js). 0 turns rotation off.
  artRotationHours: 24,
  artRotationPool: 4,

  catalogs: CATALOGS.map(({ id, name }) => ({ id, name })),

  movie: {
    justAddedWindowDays: 3, // after digital release
    nowStreamingWindowDays: 14, // after digital release
    blurayWindowDays: 7, // after physical release
    comingSoonWindowDays: 3, // before digital release
  },
  show: {
    recencyWindowDays: 7, // episode-based tags
    comingSoonWindowDays: 7, // unaired shows: tag + catalog eligibility
  },
};

let edgeConfigClient;
function getEdgeConfigClient() {
  if (edgeConfigClient !== undefined) return edgeConfigClient;
  edgeConfigClient = null;
  if (!process.env.EDGE_CONFIG) return null;
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require('@vercel/edge-config');
    edgeConfigClient = createClient(process.env.EDGE_CONFIG);
  } catch {
    // leave null: defaults only
  }
  return edgeConfigClient;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge; undefined/null/'' overrides are ignored so partial items fall back per key. */
function mergeDeep(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = mergeDeep(base[key], value);
    else if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

/** Saved catalog list made safe: known ids only, each once, all present, names trimmed. */
function normalizeCatalogs(list) {
  const saved = Array.isArray(list) ? list : [];
  const out = [];
  for (const entry of saved) {
    const known = CATALOGS.find((c) => entry && c.id === entry.id);
    if (!known || out.some((c) => c.id === known.id)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, CATALOG_NAME_MAX) : '';
    out.push({ id: known.id, name: name || known.name });
  }
  for (const c of CATALOGS) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, name: c.name });
  return out;
}

/** Resolved config for a raw Edge Config item (or null). */
function resolveConfig(overrides) {
  const raw = overrides || {};
  const cfg = mergeDeep(DEFAULTS, raw);
  // A provider URL saved before portrait modes existed keeps working as 'custom'.
  if (!raw.posterArt && raw.posterUrlTemplate) cfg.posterArt = 'custom';
  if (cfg.landscapeArt === 'tmdb-logo') cfg.landscapeArt = 'tmdb'; // legacy value
  if (!ART_MODES.poster.includes(cfg.posterArt)) cfg.posterArt = DEFAULTS.posterArt;
  if (!ART_MODES.landscape.includes(cfg.landscapeArt)) cfg.landscapeArt = DEFAULTS.landscapeArt;
  cfg.catalogs = normalizeCatalogs(cfg.catalogs);
  cfg.artRotationHours = Math.max(0, Number(cfg.artRotationHours) || 0);
  cfg.artRotationPool = Math.min(6, Math.max(1, Math.floor(Number(cfg.artRotationPool) || 1)));
  return cfg;
}

/** Raw "topTwentyConfig" item, or null. Used by /backstage so saves only touch its own keys. */
async function getRawOverrides() {
  const client = getEdgeConfigClient();
  if (!client) return null;
  try {
    return (await client.get('topTwentyConfig')) || null;
  } catch {
    return null;
  }
}

const CACHE_MS = 30000; // per warm instance
let cached = null;
let cachedAt = 0;

async function getConfig() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  return primeCache(resolveConfig(await getRawOverrides()));
}

/** Set the cache to a known value, e.g. right after /backstage writes one. */
function primeCache(cfg) {
  cached = cfg;
  cachedAt = Date.now();
  return cfg;
}

module.exports = { DEFAULTS, ART_MODES, CATALOGS, CATALOG_NAME_MAX, normalizeCatalogs, BETTER_POSTERS_URL, getConfig, getRawOverrides, resolveConfig, primeCache };
