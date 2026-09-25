// api/config.js
// /backstage (see vercel.json): the settings page. Reads/writes the "topTwentyConfig" Edge Config
// item that lib/config.js reads, touching only the keys in FIELDS (other tunables stay editable
// in Vercel's Edge Config "Items" tab). Saves also drop the cached catalogs so changes show on
// the next catalog request.
// Needs VERCEL_API_TOKEN (and VERCEL_TEAM_ID for team projects). No password by design: keep the
// URL private.

const { DEFAULTS, ART_MODES, resolveConfig, primeCache, getConfig, getRawOverrides } = require('../lib/config');
const { withCors } = require('../lib/cors');

const LABELS = { tmdb: 'Default TMDB', alternate: 'Alternate TMDB', betterposters: 'BetterPosters', custom: 'Custom URL' };
const options = (modes) => modes.map((value) => ({ value, label: LABELS[value] }));

// `showIf`: rendered and saved only while that select has that value.
const FIELDS = [
  { key: 'posterArt', label: 'Portrait art', options: options(ART_MODES.poster) },
  { key: 'posterUrlTemplate', label: 'Portrait poster URL', showIf: ['posterArt', 'custom'] },
  { key: 'landscapeArt', label: 'Landscape art', options: options(ART_MODES.landscape) },
  { key: 'backdropUrlTemplate', label: 'Landscape poster URL', showIf: ['landscapeArt', 'custom'] },
];

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function vercelApi(pathname, query, body, method = 'POST') {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error('VERCEL_API_TOKEN is not set (see README).');
  const qs = new URLSearchParams(query);
  if (process.env.VERCEL_TEAM_ID) qs.set('teamId', process.env.VERCEL_TEAM_ID);
  return fetch(`https://api.vercel.com${pathname}?${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function writeOverrides(value) {
  const id = (() => {
    try {
      return new URL(process.env.EDGE_CONFIG).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();
  if (!id) throw new Error('EDGE_CONFIG is not set: connect an Edge Config store first (see README).');
  const r = await vercelApi(`/v1/edge-config/${id}/items`, {}, { items: [{ operation: 'upsert', key: 'topTwentyConfig', value }] }, 'PATCH');
  if (!r.ok) throw new Error(`Vercel API ${r.status}: ${await r.text()}`);
}

/** Delete (not just invalidate) the `catalog` tag, so the very next request is fresh. */
async function purgeCatalogCache() {
  if (!process.env.VERCEL_PROJECT_ID) return false;
  try {
    const r = await vercelApi('/v1/edge-cache/dangerously-delete-by-tags', { projectIdOrName: process.env.VERCEL_PROJECT_ID }, { tags: ['catalog'], target: 'production' });
    return r.ok;
  } catch {
    return false;
  }
}

async function parseFormBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Apply a form post to the raw overrides; returns the banner message. Mode selects are always
 * stored explicitly (even at their default), so lib/config.js's legacy "saved URL means custom"
 * rule never overrides a choice made here.
 */
function applyForm(existing, params) {
  const one = FIELDS.find((f) => f.key === params.reset);
  if (one) {
    if (one.options) existing[one.key] = DEFAULTS[one.key];
    else delete existing[one.key];
    return `${one.label} reset to default.`;
  }
  if (params.action === 'reset') {
    for (const f of FIELDS) delete existing[f.key];
    return 'All fields reset to default.';
  }
  for (const f of FIELDS) {
    if (f.showIf && params[f.showIf[0]] !== f.showIf[1]) continue; // hidden field keeps its saved value
    const raw = (params[f.key] || '').trim();
    if (f.options) {
      if (f.options.some((o) => o.value === raw)) existing[f.key] = raw;
    } else if (!raw || raw === DEFAULTS[f.key]) delete existing[f.key];
    else existing[f.key] = raw;
  }
  return 'Saved.';
}

function renderPage({ cfg, message, error }) {
  const rows = FIELDS.map((f) => {
    const value = cfg[f.key];
    const def = DEFAULTS[f.key];
    const control = f.options
      ? `<select name="${f.key}" id="f-${f.key}">${f.options.map((o) => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`
      : `<input type="text" name="${f.key}" value="${escapeHtml(value)}" placeholder="${escapeHtml(def)}" spellcheck="false" autocomplete="off" />`;
    const cond = f.showIf ? ` data-if="${f.showIf[0]}" data-is="${f.showIf[1]}"${cfg[f.showIf[0]] !== f.showIf[1] ? ' hidden' : ''}` : '';
    return `
      <label class="field"${cond}>
        <span class="field-label">${escapeHtml(f.label)}</span>
        <span class="row">
          ${control}
          <button class="secondary" type="submit" name="reset" value="${f.key}"${value === def ? ' disabled' : ''}>Reset</button>
        </span>
      </label>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Top Charts Today</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 16px 64px; background: #0b0c0f; color: #e8e8ec;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 28px; }
  .banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.92rem; }
  .ok { background: #113a24; color: #7ee2a8; border: 1px solid #1f6b41; }
  .err { background: #3a1414; color: #ff9e9e; border: 1px solid #6b1f1f; }
  form { display: flex; flex-direction: column; gap: 18px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field[hidden] { display: none; }
  .field-label { font-size: 0.88rem; font-weight: 600; color: #cfcfd8; }
  .row { display: flex; gap: 8px; }
  input, select { flex: 1; min-width: 0; background: #1a1b20; border: 1px solid #2c2d34; color: #e8e8ec;
    border-radius: 6px; padding: 10px 12px; font-size: 0.95rem; }
  input:focus, select:focus { outline: none; border-color: #5b7cff; }
  .actions { display: flex; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
  button { border: none; border-radius: 6px; padding: 11px 18px; font-size: 0.92rem; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.35; cursor: default; }
  .primary { background: #5b7cff; color: #fff; }
  .secondary { background: #2c2d34; color: #e8e8ec; }
  .row .secondary { padding: 10px 14px; }
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
        <button class="primary" type="submit" name="action" value="save">Save</button>
        <button class="secondary" type="submit" name="action" value="reset">Reset all</button>
      </div>
    </form>
  </div>
  <script>
    const sync = () => document.querySelectorAll('[data-if]').forEach((el) => {
      el.hidden = document.getElementById('f-' + el.dataset.if).value !== el.dataset.is;
    });
    document.querySelectorAll('select').forEach((s) => s.addEventListener('change', sync));
  </script>
</body>
</html>`;
}

module.exports = withCors(async (req, res) => {
  let message = null;
  let error = null;
  let cfg = null;

  if (req.method === 'POST') {
    try {
      const existing = { ...((await getRawOverrides()) || {}) };
      message = applyForm(existing, await parseFormBody(req));
      await writeOverrides(existing);
      message += (await purgeCatalogCache()) ? ' Catalogs refreshed.' : ' Catalogs update within the hour.';
      // Render what was just written: a getConfig() re-read could still be the pre-write value.
      cfg = primeCache(resolveConfig(existing));
    } catch (e) {
      error = String((e && e.message) || e);
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(renderPage({ cfg: cfg || (await getConfig()), message, error }));
});
