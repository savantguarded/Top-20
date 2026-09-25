// api/config.js
// Served at /backstage (see vercel.json rewrite -- deliberately not the more guessable
// "/config"). A small HTML page for changing the addon's poster provider (a URL template)
// without touching Vercel's dashboard or the GitHub repo -- just one field and a Save/Reset
// button. Reads/writes the same "topTwentyConfig" Edge Config item that lib/config.js reads
// from -- see that file and the README's "Live config" section for the full picture and
// one-time setup. Every other live setting (region, catalog size, status-label day windows)
// still lives in that same Edge Config item and still works exactly as before; this page
// just doesn't expose a control for them anymore (deliberately simplified) -- edit them
// directly in Vercel's Edge Config "Items" tab if you ever need to.
//
// NOT password-protected (removed at the user's explicit request, so the URL itself stays
// easy to remember/bookmark -- previously gated by a CONFIG_PASSWORD query-string key).
// Anyone who has or guesses the /backstage URL can view and change the poster provider.
// That's the accepted tradeoff here: low stakes (worst case someone points the poster
// template somewhere broken, one save away from fixing), but worth knowing before sharing
// this addon's manifest URL publicly, since /backstage is one guess away from it.
//
// Writing to Edge Config needs a Vercel API token (Edge Config is read-only from application
// code otherwise) -- see README for how to create one. Set as VERCEL_API_TOKEN. If the Edge
// Config store belongs to a Vercel team rather than a personal account, also set
// VERCEL_TEAM_ID. Both are separate from TMDB_API_KEY and EDGE_CONFIG.

const { getConfig, DEFAULTS, mergeDeep, primeCache, getRawOverrides } = require('../lib/config');
const { withCors } = require('../lib/cors');

// This page intentionally exposes only the poster and backdrop provider templates. Every
// other tunable (region, catalog size, status-label day windows, etc.) still lives in Edge
// Config and still works exactly as before -- it's just not editable from this simplified
// page anymore. Edit those directly in Vercel's Edge Config "Items" tab if you ever need to.
const LANDSCAPE_OPTIONS = [
  { value: 'tmdb-logo', label: 'Default TMDB' },
  { value: 'alternate', label: 'Alternate TMDB' },
  { value: 'custom', label: 'Custom URL' },
];

// `showIf`: the field only renders (and only saves) when landscapeArt matches.
const FIELDS = [
  {
    key: 'posterUrlTemplate',
    label: 'Portrait poster URL',
    type: 'text',
    path: ['posterUrlTemplate'],
  },
  {
    key: 'landscapeArt',
    label: 'Landscape art',
    type: 'select',
    options: LANDSCAPE_OPTIONS,
    path: ['landscapeArt'],
  },
  {
    key: 'backdropUrlTemplate',
    label: 'Landscape poster URL',
    type: 'text',
    showIf: 'custom',
    path: ['backdropUrlTemplate'],
  },
];

// Keys this page used to manage but no longer shows. Dropped from Edge Config on any save or reset.
const RETIRED_KEYS = [];

/** Legacy 'main' (and anything unknown) reads as the default. */
function landscapeMode(cfg) {
  return LANDSCAPE_OPTIONS.some((o) => o.value === cfg.landscapeArt) ? cfg.landscapeArt : DEFAULTS.landscapeArt;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPath(obj, path) {
  return path.reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** Pull the Edge Config store id (e.g. "ecfg_xxx") out of the EDGE_CONFIG connection string. */
function parseEdgeConfigId() {
  const raw = process.env.EDGE_CONFIG;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

/** Upsert (or delete, when value is undefined) the given key in Edge Config via Vercel's API. */
async function writeEdgeConfigItem(key, value) {
  const edgeConfigId = parseEdgeConfigId();
  const apiToken = process.env.VERCEL_API_TOKEN;
  if (!edgeConfigId) throw new Error('EDGE_CONFIG is not set -- connect an Edge Config store to this project first (see README).');
  if (!apiToken) throw new Error('VERCEL_API_TOKEN is not set -- create a Vercel API token first (see README).');

  const teamId = process.env.VERCEL_TEAM_ID;
  const url = `https://api.vercel.com/v1/edge-config/${edgeConfigId}/items${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`;

  const operation = value === undefined ? 'delete' : 'upsert';
  const item = operation === 'delete' ? { operation, key } : { operation, key, value };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items: [item] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel API ${res.status}: ${text}`);
  }
}

/**
 * Drop the cached catalogs so a settings change shows up on the very next catalog request,
 * instead of after the 1-hour edge cache expires. api/catalog.js tags its responses
 * `catalog` (Vercel-Cache-Tag); this deletes that tag via Vercel's REST API, reusing
 * VERCEL_API_TOKEN. Delete rather than invalidate, so the next request is fresh rather than
 * stale-once. Only ever 4 small catalog URLs, so no stampede risk. Never fails the save.
 */
async function purgeCatalogCache() {
  const apiToken = process.env.VERCEL_API_TOKEN;
  const project = process.env.VERCEL_PROJECT_ID;
  if (!apiToken || !project) return false;
  const teamId = process.env.VERCEL_TEAM_ID;
  const qs = new URLSearchParams({ projectIdOrName: project });
  if (teamId) qs.set('teamId', teamId);
  try {
    const r = await fetch(`https://api.vercel.com/v1/edge-cache/dangerously-delete-by-tags?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['catalog'], target: 'production' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Body comes pre-parsed into req.body when Vercel's Node runtime recognizes the content
 * type (application/x-www-form-urlencoded, from a plain HTML form); read the raw stream as
 * a fallback so this still works if that parsing is ever skipped. */
async function parseFormBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function renderPage({ cfg, message, error }) {
  const mode = landscapeMode(cfg);
  const rows = FIELDS.map((f) => {
    const value = f.key === 'landscapeArt' ? mode : getPath(cfg, f.path);
    const def = getPath(DEFAULTS, f.path);
    const control = f.type === 'select'
      ? `<select name="${f.key}" id="f-${f.key}">${f.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`
      : `<input type="text" name="${f.key}" value="${escapeHtml(value)}" placeholder="${escapeHtml(def)}" spellcheck="false" autocomplete="off" />`;
    const hidden = f.showIf && mode !== f.showIf ? ' hidden' : '';
    return `
      <label class="field"${f.showIf ? ` data-show-if="${f.showIf}"` : ''}${hidden}>
        <span class="field-label">${escapeHtml(f.label)}</span>
        <span class="row">
          ${control}
          <button class="reset-one" type="submit" name="reset" value="${f.key}" title="Reset to default"${value === def ? ' disabled' : ''}>Reset</button>
        </span>
      </label>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Top Charts Today</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 16px 64px;
    background: #0b0c0f; color: #e8e8ec;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 28px; }
  .banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.92rem; }
  .banner.ok { background: #113a24; color: #7ee2a8; border: 1px solid #1f6b41; }
  .banner.err { background: #3a1414; color: #ff9e9e; border: 1px solid #6b1f1f; }
  form { display: flex; flex-direction: column; gap: 18px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 0.88rem; font-weight: 600; color: #cfcfd8; }
  .row { display: flex; gap: 8px; }
  input {
    flex: 1; min-width: 0;
    background: #1a1b20; border: 1px solid #2c2d34; color: #e8e8ec;
    border-radius: 6px; padding: 10px 12px; font-size: 0.95rem;
  }
  select {
    flex: 1; min-width: 0;
    background: #1a1b20; border: 1px solid #2c2d34; color: #e8e8ec;
    border-radius: 6px; padding: 10px 12px; font-size: 0.95rem;
  }
  input:focus, select:focus { outline: none; border-color: #5b7cff; }
  [hidden] { display: none !important; }
  .actions { display: flex; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
  button {
    border: none; border-radius: 6px; padding: 11px 18px; font-size: 0.92rem; font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: 0.35; cursor: default; }
  button.save { background: #5b7cff; color: white; }
  button.reset, button.reset-one { background: #2c2d34; color: #e8e8ec; }
  button.reset-one { padding: 10px 14px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Top Charts Today</h1>
    ${message ? `<div class="banner ok">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="banner err">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/backstage">
      ${rows}
      <div class="actions">
        <button class="save" type="submit" name="action" value="save">Save</button>
        <button class="reset" type="submit" name="action" value="reset">Reset all</button>
      </div>
    </form>
  </div>
  <script>
    // Show the URL field only while "Custom URL" is picked (the server renders the same state).
    const sel = document.getElementById('f-landscapeArt');
    const sync = () => document.querySelectorAll('[data-show-if]').forEach((el) => {
      el.hidden = sel.value !== el.dataset.showIf;
    });
    sel.addEventListener('change', sync);
  </script>
</body>
</html>`;
}

module.exports = withCors(async (req, res) => {
  let message = null;
  let error = null;
  let justWrittenCfg = null;

  if (req.method === 'POST') {
    try {
      const params = await parseFormBody(req);
      const action = params.action;

      // Both branches start from the current RAW overrides (not getConfig()'s merged,
      // defaults-filled result) and only touch the keys in FIELDS -- every other field this
      // page no longer shows a control for (region, catalog size, status-label windows, ...)
      // is carried through untouched, whatever it's currently set to in Edge Config.
      const existing = { ...((await getRawOverrides()) || {}) };

      for (const k of RETIRED_KEYS) delete existing[k];
      const resetOne = FIELDS.find((f) => f.key === params.reset);

      if (resetOne) {
        // Per-field Reset: only that field goes back to default; the other field keeps its
        // SAVED value (unsaved edits in it are discarded, same as a normal page reload).
        delete existing[resetOne.key];
        message = `${resetOne.label} reset to default.`;
      } else if (action === 'reset') {
        for (const f of FIELDS) delete existing[f.key];
        message = 'All fields reset to default.';
      } else {
        const newMode = LANDSCAPE_OPTIONS.some((o) => o.value === params.landscapeArt) ? params.landscapeArt : null;
        for (const f of FIELDS) {
          // A hidden field keeps its saved value (e.g. a custom URL survives switching away and back).
          if (f.showIf && newMode !== f.showIf) continue;
          const raw = (params[f.key] || '').trim();
          if (f.type === 'select' && !f.options.some((o) => o.value === raw)) continue;
          if (!raw || raw === getPath(DEFAULTS, f.path)) delete existing[f.key];
          else existing[f.key] = raw;
        }
        message = 'Saved.';
      }
      await writeEdgeConfigItem('topTwentyConfig', existing);
      justWrittenCfg = mergeDeep(DEFAULTS, existing);
      const purged = await purgeCatalogCache();
      message += purged ? ' Catalogs refreshed.' : ' Catalogs update within the hour.';
      // Don't trust a getConfig() re-read here -- it can still be serving a value
      // cached from just before this write (up to CACHE_MS old), which makes a
      // successful save look like it silently reverted (the actual bug this fixes).
      // We already know exactly what we just wrote, so render that directly, and
      // prime the shared cache with it so every other request hitting this same warm
      // instance -- including the very next page load -- sees the new value right
      // away instead of up to CACHE_MS late.
      primeCache(justWrittenCfg);
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }
  }

  const cfg = justWrittenCfg || (await getConfig());
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(renderPage({ cfg, message, error }));
});
