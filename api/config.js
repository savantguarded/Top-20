// api/config.js
// Served at /config (see vercel.json rewrite). A small password-protected HTML page for
// changing the addon's live settings (poster provider, region, catalog size, status-label
// windows) without touching Vercel's dashboard or the GitHub repo -- just a form. Reads/writes
// the same "topTwentyConfig" Edge Config item that lib/config.js reads from -- see that file
// and the README's "Live config" section for the full picture and one-time setup.
//
// Protection: a single shared password, set as the CONFIG_PASSWORD environment variable.
// Bookmark this page as /config?key=<your password> -- viewing and saving both require it.
// Deliberately simple (no accounts, no sessions) since this is a single-owner tool; treat a
// URL with the key in it like a password itself, don't share it.
//
// Writing to Edge Config needs a Vercel API token (Edge Config is read-only from application
// code otherwise) -- see README for how to create one. Set as VERCEL_API_TOKEN. If the Edge
// Config store belongs to a Vercel team rather than a personal account, also set
// VERCEL_TEAM_ID. Both are separate from TMDB_API_KEY and EDGE_CONFIG.

const { getConfig, DEFAULTS, mergeDeep, primeCache } = require('../lib/config');
const { withCors } = require('../lib/cors');

const FIELDS = [
  {
    key: 'posterUrlTemplate',
    label: 'Poster provider URL template',
    type: 'text',
    hint: 'Use {imdbId} or {id} as a placeholder (both work), e.g. https://btttr.cc/poster-n/imdb/poster-default/{imdbId}.jpg?tag=none',
    path: ['posterUrlTemplate'],
  },
  {
    key: 'region',
    label: 'Region (release-date country code)',
    type: 'text',
    hint: 'e.g. US, GB, CA',
    path: ['region'],
  },
  {
    key: 'catalogSize',
    label: 'Catalog size',
    type: 'number',
    hint: 'How many items each catalog tries to fill to',
    path: ['catalogSize'],
  },
  {
    key: 'maxPages',
    label: 'Max trending pages to search',
    type: 'number',
    hint: 'Safety cap on how deep to page through TMDB while filling the catalog',
    path: ['maxPages'],
  },
  {
    key: 'foreignMinVoteCount',
    label: 'Foreign-language minimum vote count',
    type: 'number',
    hint: 'Minimum TMDB votes for a non-English trending title to qualify',
    path: ['foreignMinVoteCount'],
  },
  {
    key: 'movie.justAddedWindowDays',
    label: 'Movie: "Just Added" window (days)',
    type: 'number',
    path: ['movie', 'justAddedWindowDays'],
  },
  {
    key: 'movie.nowStreamingWindowDays',
    label: 'Movie: "Now Streaming" window (days)',
    type: 'number',
    path: ['movie', 'nowStreamingWindowDays'],
  },
  {
    key: 'movie.blurayWindowDays',
    label: 'Movie: "Now on Blu-ray" window (days)',
    type: 'number',
    path: ['movie', 'blurayWindowDays'],
  },
  {
    key: 'movie.comingSoonWindowDays',
    label: 'Movie: "Coming Soon" window (days)',
    type: 'number',
    path: ['movie', 'comingSoonWindowDays'],
  },
  {
    key: 'show.recencyWindowDays',
    label: 'Show: episode-tag recency window (days)',
    type: 'number',
    hint: 'How long Premiere/New Season/New Episode/Finale tags stay visible',
    path: ['show', 'recencyWindowDays'],
  },
  {
    key: 'show.comingSoonWindowDays',
    label: 'Show: "Coming Soon" / eligibility window (days)',
    type: 'number',
    path: ['show', 'comingSoonWindowDays'],
  },
];

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

function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[path[path.length - 1]] = value;
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

function renderPage({ key, cfg, message, error }) {
  const rows = FIELDS.map((f) => {
    const value = getPath(cfg, f.path);
    return `
      <label class="field">
        <span class="field-label">${escapeHtml(f.label)}</span>
        <input type="${f.type}" name="${f.key}" value="${escapeHtml(value)}" ${f.type === 'number' ? 'step="1" min="0"' : ''} />
        ${f.hint ? `<span class="field-hint">${escapeHtml(f.hint)}</span>` : ''}
      </label>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Top Charts Today — Settings</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px 80px;
    background: #0b0c0f; color: #e8e8ec;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p.sub { color: #9a9aa5; margin: 0 0 28px; font-size: 0.92rem; }
  .banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.92rem; }
  .banner.ok { background: #113a24; color: #7ee2a8; border: 1px solid #1f6b41; }
  .banner.err { background: #3a1414; color: #ff9e9e; border: 1px solid #6b1f1f; }
  form { display: flex; flex-direction: column; gap: 18px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 0.88rem; font-weight: 600; color: #cfcfd8; }
  .field-hint { font-size: 0.78rem; color: #83838f; }
  input {
    background: #1a1b20; border: 1px solid #2c2d34; color: #e8e8ec;
    border-radius: 6px; padding: 10px 12px; font-size: 0.95rem;
  }
  input:focus { outline: none; border-color: #5b7cff; }
  .actions { display: flex; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
  button {
    border: none; border-radius: 6px; padding: 11px 18px; font-size: 0.92rem; font-weight: 600;
    cursor: pointer;
  }
  button.save { background: #5b7cff; color: white; }
  button.reset { background: #2c2d34; color: #e8e8ec; }
  .foot { margin-top: 32px; font-size: 0.78rem; color: #66666f; line-height: 1.5; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Top Charts Today — Live Settings</h1>
    <p class="sub">Changes here apply within a few seconds. No redeploy, nothing to push to GitHub.</p>
    ${message ? `<div class="banner ok">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="banner err">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/config?key=${encodeURIComponent(key)}">
      ${rows}
      <div class="actions">
        <button class="save" type="submit" name="action" value="save">Save changes</button>
        <button class="reset" type="submit" name="action" value="reset">Reset all to defaults</button>
      </div>
    </form>
    <div class="foot">Bookmark this page's exact URL (with your key) to come back later. Anyone with this URL can change the addon's settings, so don't share it.</div>
  </div>
</body>
</html>`;
}

module.exports = withCors(async (req, res) => {
  const expectedKey = process.env.CONFIG_PASSWORD;
  const providedKey = (req.query && req.query.key) || '';

  if (!expectedKey) {
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      '<p style="font-family:sans-serif;max-width:520px;margin:40px auto">' +
        'CONFIG_PASSWORD is not set. Add it as an environment variable in Vercel (any password ' +
        'you choose), redeploy once, then reload this page as <code>/config?key=&lt;that password&gt;</code>. ' +
        'See the README’s "Live config" section for the full setup.' +
        '</p>'
    );
    return;
  }

  if (!providedKey || providedKey !== expectedKey) {
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      '<p style="font-family:sans-serif;max-width:520px;margin:40px auto">' +
        'Missing or wrong key. Open this page as <code>/config?key=&lt;your CONFIG_PASSWORD&gt;</code>.' +
        '</p>'
    );
    return;
  }

  let message = null;
  let error = null;
  let justWrittenCfg = null;

  if (req.method === 'POST') {
    try {
      const params = await parseFormBody(req);
      const action = params.action;

      if (action === 'reset') {
        await writeEdgeConfigItem('topTwentyConfig', undefined);
        justWrittenCfg = mergeDeep(DEFAULTS, {});
        message = 'Reset to defaults.';
      } else {
        const overrides = {};
        for (const f of FIELDS) {
          const raw = params[f.key];
          if (raw === undefined || raw === '') continue;
          if (f.type === 'number') {
            const value = Number(raw);
            if (!Number.isFinite(value) || value < 0) {
              throw new Error(`"${f.label}" must be a non-negative number.`);
            }
            setPath(overrides, f.path, value);
          } else {
            setPath(overrides, f.path, raw);
          }
        }
        await writeEdgeConfigItem('topTwentyConfig', overrides);
        justWrittenCfg = mergeDeep(DEFAULTS, overrides);
        message = 'Saved. Give it a few seconds to take effect.';
      }
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
  res.status(200).send(renderPage({ key: providedKey, cfg, message, error }));
});
