// lib/config.js
// Runtime-tunable settings. Read from Vercel Edge Config (a free key-value store
// built into Vercel) so they can be changed from Vercel's own dashboard -- a plain
// form, no code, no git push, no redeploy -- and take effect within a few seconds.
//
// If Edge Config isn't set up yet (no EDGE_CONFIG environment variable) or a read
// fails for any reason, every setting silently falls back to DEFAULTS below, which
// match the addon's original hardcoded behavior exactly. Nothing breaks if you
// never touch Edge Config at all.
//
// One-time setup (see README "Live config" section for the full walkthrough):
//   1. Vercel dashboard -> Storage -> Create Database -> Edge Config -> connect it
//      to this project. Vercel adds the EDGE_CONFIG env var for you.
//   2. In the Edge Config's "Items" tab, add one item: key "topTwentyConfig",
//      value a JSON object with only the keys you want to override (see DEFAULTS
//      below for the full shape -- partial objects are merged onto the defaults).
//   3. Edit that value any time. No redeploy needed.

const DEFAULTS = {
  // Country code used for release-date eligibility checks (movie digital/physical
  // release, show premiere). TMDB's trending lists themselves are global/popularity
  // based and aren't region-scoped -- this only controls which country's release
  // dates get checked.
  region: 'US',

  // How many items each catalog tries to fill to.
  catalogSize: 20,

  // Safety cap on how many pages of TMDB's trending list collectUntilFilled() will
  // page through while trying to reach catalogSize.
  maxPages: 6,

  // Non-English trending candidates need at least this many TMDB votes to be
  // considered (see passesLanguagePopularityGate in lib/tmdb.js).
  foreignMinVoteCount: 50,

  // Base poster image source, as a URL template. `{imdbId}` (or `{id}` -- both work,
  // since third-party providers document their own placeholder either way) is replaced
  // with the title's IMDb id (e.g. "tt1234567"). Swap providers by changing just this
  // string -- no code change. TMDB's own poster is always the automatic fallback if
  // this URL 404s, errors, or takes longer than api/poster.js's own timeout to answer.
  //
  // Examples:
  //   btttr.cc (current default):
  //     "https://btttr.cc/poster-n/imdb/poster-default/{imdbId}.jpg?tag=none"
  //   TMDB via imdb passthrough is not directly URL-able (needs a lookup), so TMDB
  //   stays as the built-in fallback rather than a template option.
  //   RPDB / aiometadata-style (ratings baked into the poster, needs your own API key):
  //     "https://api.ratingposterdb.com/<your-api-key>/imdb/poster-default/{imdbId}.jpg?fallback=true"
  posterUrlTemplate: 'https://postersplus.stremio.ru/poster?tmdb_id={tmdb_id}&stremio_id={id}&type={type}&primary_client=stremio_tv_nuvio&tmdb_key={tmdb_key}&mdblist_key={mdblist_key}&top_gradient=off&bottom_gradient=off&fallback_to_imdb=true&rating_display_mode=0&fallback_bg_style=photoreal&logo_max_w_ratio=0.95&logo_max_h_ratio=0.30&logo_bottom_ratio=0.15&logo_bottom_anchor=true&sash_mode=hidden&cinema_greyscale=false&badge_display_mode=0',

  movie: {
    // "Just Added" for this many days after the confirmed digital release.
    justAddedWindowDays: 3,
    // "Now Streaming" through this many days after the confirmed digital release.
    nowStreamingWindowDays: 14,
    // "Now on Blu-ray" if the confirmed physical release is within this many days.
    blurayWindowDays: 7,
    // "Coming Soon" if the confirmed digital release is within this many days out.
    comingSoonWindowDays: 3,
  },

  show: {
    // Episode-based tags (Premiere/New Season/New Episode/Finale) only show within
    // this many days of the relevant air date.
    recencyWindowDays: 7,
    // A not-yet-aired show only gets a "Coming Soon" tag -- and only counts as
    // eligible for the catalog at all -- once its premiere is within this window.
    comingSoonWindowDays: 7,
  },
};

let edgeConfigClient = null;
let edgeConfigLoadAttempted = false;

function getEdgeConfigClient() {
  if (edgeConfigLoadAttempted) return edgeConfigClient;
  edgeConfigLoadAttempted = true;
  if (!process.env.EDGE_CONFIG) return null;
  try {
    // Lazy require so a deploy that hasn't run `npm install` with this dependency
    // yet, or hasn't set EDGE_CONFIG, never fails on this line.
    // eslint-disable-next-line global-require
    const { createClient } = require('@vercel/edge-config');
    edgeConfigClient = createClient(process.env.EDGE_CONFIG);
  } catch {
    edgeConfigClient = null;
  }
  return edgeConfigClient;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Overlay `override` onto `base`, recursing into nested plain objects. Ignores
 * undefined/null/empty-string override values so a half-filled Edge Config item
 * still falls back to defaults key by key rather than clobbering with blanks. */
function mergeDeep(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else if (value !== undefined && value !== null && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

let cached = null;
let cachedAt = 0;
const CACHE_MS = 30000; // avoid a redundant Edge Config read per request within a warm instance

/**
 * Resolved config: DEFAULTS overlaid with whatever's in the "topTwentyConfig"
 * Edge Config item (missing keys, or no Edge Config at all, just use the
 * default). Cached for CACHE_MS per warm serverless instance.
 */
async function getConfig() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;

  let overrides = null;
  const client = getEdgeConfigClient();
  if (client) {
    try {
      overrides = await client.get('topTwentyConfig');
    } catch {
      overrides = null; // Edge Config hiccup -- fall back to defaults, never fail the request over this
    }
  }

  cached = mergeDeep(DEFAULTS, overrides);
  cachedAt = now;
  return cached;
}

/**
 * Force the in-memory cache to a known-good value (and reset its age), instead of
 * waiting up to CACHE_MS for the next natural read to pick it up. Used right after a
 * successful write (e.g. from api/config.js) so that: (a) the very next getConfig()
 * call on this same warm instance -- including the one used to redisplay the settings
 * page itself -- reflects the change immediately instead of replaying a stale read
 * from before the write, and (b) other requests hitting this same warm instance (a
 * poster fetch, a catalog fetch) within the cache window also see the new value right
 * away rather than up to CACHE_MS late.
 */
function primeCache(value) {
  cached = value;
  cachedAt = Date.now();
}

module.exports = { getConfig, DEFAULTS, mergeDeep, primeCache };
