// api/config.js
// /backstage-<key> (see vercel.json): the settings page. Only served when <key> matches the
// BACKSTAGE_KEY env var (kept out of this public repo); anything else, /api/config included, 404s.
// Reads/writes the "topTwentyConfig" Edge Config item that lib/config.js reads, touching only
// the keys in FIELDS plus `catalogs` (names and order of the installed rows); other tunables
// stay editable in Vercel's Edge Config "Items" tab. Saves also drop the cached catalogs and
// manifests so changes show on the next request.
// Needs VERCEL_API_TOKEN (and VERCEL_TEAM_ID for team projects).

const { DEFAULTS, ART_MODES, CATALOGS, CATALOG_NAME_MAX, CATALOG_SHAPES, normalizeCatalogs, resolveConfig, primeCache, getConfig, getRawOverrides } = require('../lib/config');
const { withCors } = require('../lib/cors');

const LABELS = { tmdb: 'Default TMDB', alternate: 'Alternate TMDB', betterposters: 'BetterPosters', custom: 'Custom URL' };
const SHAPE_LABELS = { install: 'Follow install', portrait: 'Portrait', landscape: 'Landscape' };
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
  if (params.reset === 'catalogs') {
    delete existing.catalogs;
    return 'Catalogs reset to default.';
  }
  const one = FIELDS.find((f) => f.key === params.reset);
  if (one) {
    if (one.options) existing[one.key] = DEFAULTS[one.key];
    else delete existing[one.key];
    return `${one.label} reset to default.`;
  }
  if (params.action === 'reset') {
    for (const f of FIELDS) delete existing[f.key];
    delete existing.catalogs;
    return 'All fields reset to default.';
  }
  const order = String(params.catalogOrder || '').split(',');
  const catalogs = normalizeCatalogs(order.map((id) => ({ id, name: params[`catalogName_${id}`], shape: params[`catalogShape_${id}`] })));
  if (isDefaultCatalogs(catalogs)) delete existing.catalogs;
  else existing.catalogs = catalogs;
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

const isDefaultCatalogs = (list) => list.length === CATALOGS.length
  && list.every((c, i) => c.id === CATALOGS[i].id && c.name === CATALOGS[i].name && c.shape === 'install');

/** Rename, set orientation, and reorder rows. The hidden catalogOrder input carries the order the arrows set. */
function renderCatalogs(cfg) {
  const items = cfg.catalogs.map((c) => {
    const def = CATALOGS.find((d) => d.id === c.id);
    const kind = def.type === 'movie' ? 'Movies' : 'Shows';
    return `
        <li class="row cat" data-id="${c.id}">
          <input type="text" name="catalogName_${c.id}" value="${escapeHtml(c.name)}" placeholder="${escapeHtml(def.name)}" maxlength="${CATALOG_NAME_MAX}" spellcheck="false" autocomplete="off" aria-label="${kind} catalog name" />
          <select class="shape" name="catalogShape_${c.id}" aria-label="${escapeHtml(c.name)} orientation">${CATALOG_SHAPES.map((v) => `<option value="${v}"${v === c.shape ? ' selected' : ''}>${SHAPE_LABELS[v]}</option>`).join('')}</select>
          <button class="secondary move" type="button" data-dir="-1" aria-label="Move up">&#8593;</button>
          <button class="secondary move" type="button" data-dir="1" aria-label="Move down">&#8595;</button>
        </li>`;
  }).join('');
  return `
      <div class="field">
        <span class="field-label">Catalogs</span>
        <span class="row">
          <ol class="cats" id="cats">${items}
          </ol>
          <button class="secondary" type="submit" name="reset" value="catalogs"${isDefaultCatalogs(cfg.catalogs) ? ' disabled' : ''}>Reset</button>
        </span>
        <p class="hint">Rename, set each row's card orientation, or use the arrows to set the row order. Follow install uses the install link's shape; Portrait or Landscape applies on every install. Names and order are read at install: if one doesn't show, reinstall. Orientation applies on the next refresh.</p>
        <input type="hidden" name="catalogOrder" id="cat-order" value="${cfg.catalogs.map((c) => c.id).join(',')}" />
      </div>`;
}

function renderPage({ cfg, message, error, path, base }) {
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
<title>Daily Charts</title>
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
  .install { margin-top: 36px; padding-top: 24px; border-top: 1px solid #2c2d34; display: flex; flex-direction: column; gap: 10px; }
  .install h2 { font-size: 1rem; margin: 0; }
  .hint { font-size: 0.82rem; color: #8b8b96; margin: 0; }
  .toggle { display: flex; background: #1a1b20; border: 1px solid #2c2d34; border-radius: 6px; padding: 3px; align-self: flex-start; }
  .toggle button { background: none; color: #8b8b96; padding: 8px 16px; }
  .toggle button[aria-pressed="true"] { background: #2c2d34; color: #e8e8ec; }
  .cats { flex: 1; min-width: 0; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .cat .move { padding: 10px 12px; }
  .cat .shape { flex: 0 0 auto; width: 9.5em; }
  @media (max-width: 480px) { .cat { flex-wrap: wrap; } .cat input { flex-basis: 100%; } .cat .shape { flex: 1; width: auto; } }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Daily Charts</h1>
    ${message ? `<div class="banner ok">${escapeHtml(message)}</div>` : ''}
    ${error ? `<div class="banner err">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="${path}">
      ${rows}
      ${renderCatalogs(cfg)}
      <div class="actions">
        <button class="primary" type="submit" name="action" value="save">Save</button>
        <button class="secondary" type="submit" name="action" value="reset">Reset all</button>
      </div>
    </form>
    <section class="install">
      <h2>Install link</h2>
      <p class="hint">For Nuvio. For Landscape, leave Nuvio's Landscape posters toggle off. Not saved: each link is its own install, so switching here never changes an existing one.</p>
      <div class="toggle" role="group" aria-label="Install type">
        <button type="button" data-url="${base}/manifest.json" aria-pressed="true">Portrait</button>
        <button type="button" data-url="${base}/landscape/manifest.json" aria-pressed="false">Landscape</button>
      </div>
      <span class="row">
        <input type="text" id="install-url" value="${base}/manifest.json" readonly spellcheck="false" />
        <button class="secondary" type="button" id="copy">Copy</button>
      </span>
    </section>
  </div>
  <script>
    const sync = () => document.querySelectorAll('[data-if]').forEach((el) => {
      el.hidden = document.getElementById('f-' + el.dataset.if).value !== el.dataset.is;
    });
    document.querySelectorAll('select').forEach((s) => s.addEventListener('change', sync));
    const cats = document.getElementById('cats');
    const syncCats = () => {
      const rows = [...cats.children];
      document.getElementById('cat-order').value = rows.map((r) => r.dataset.id).join(',');
      rows.forEach((r, i) => {
        r.querySelector('[data-dir="-1"]').disabled = i === 0;
        r.querySelector('[data-dir="1"]').disabled = i === rows.length - 1;
      });
    };
    cats.addEventListener('click', (e) => {
      const b = e.target.closest('.move');
      if (!b) return;
      const row = b.closest('li');
      if (b.dataset.dir === '-1' && row.previousElementSibling) cats.insertBefore(row, row.previousElementSibling);
      if (b.dataset.dir === '1' && row.nextElementSibling) cats.insertBefore(row.nextElementSibling, row);
      syncCats();
      b.focus();
    });
    syncCats();
    const url = document.getElementById('install-url');
    const copy = document.getElementById('copy');
    document.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.toggle button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      url.value = b.dataset.url;
      copy.textContent = 'Copy';
    }));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url.value); } catch { url.select(); document.execCommand('copy'); }
      copy.textContent = 'Copied';
    });
    // After a save, turn this entry into a plain GET so a refresh reloads the page instead of
    // re-sending the form (which re-showed the banner), and fade the banner out.
    history.replaceState(null, '', location.pathname);
    setTimeout(() => document.querySelectorAll('.banner').forEach((b) => b.remove()), 4000);
  </script>
</body>
</html>`;
}

module.exports = withCors(async (req, res) => {
  const key = process.env.BACKSTAGE_KEY;
  if (!key || req.query.key !== key) {
    res.status(404).send('Not found');
    return;
  }
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
  const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  res.status(200).send(renderPage({ cfg: cfg || (await getConfig()), message, error, path: `/backstage-${key}`, base: escapeHtml(base) }));
});
