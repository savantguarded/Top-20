// lib/art.js
// Art pools for the 'alternate' modes, and the daily rotation through them.
//
// Pools: TMDB often holds several uploads of the same key art (re-crops, re-encodes), so a
// candidate only joins a pool if it looks unlike everything already in it. Landscape pools also
// skip anything close to the references (TMDB's main backdrop and the top textless one), since
// the `background` behind the row is one of those. Similarity = Pearson correlation of tiny
// greyscale thumbnails (a few KB each); correlation rather than pixel difference so two
// unrelated dark images don't match. Runs on the final list only, in parallel, under a time
// budget; anything unfinished keeps a one-image pool (its top-voted alternate).
//
// Rotation: pickRotating() is deterministic (same title + same period = same image, so card
// URLs and every cache stay valid) and staggered per title, so a row changes a card or two at
// a time instead of all at once, which also spreads the re-render load.

const crypto = require('crypto');
const sharp = require('sharp');

const THUMB = {
  landscape: { base: 'https://image.tmdb.org/t/p/w300', w: 32, h: 18 },
  portrait: { base: 'https://image.tmdb.org/t/p/w92', w: 12, h: 18 },
};
const SIMILAR = 0.75; // correlation above this reads as the same art
const FETCH_TIMEOUT_MS = 3000;
const TOTAL_BUDGET_MS = 4000;

async function signature(path, shape) {
  const t = THUMB[shape];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(t.base + path, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const px = await sharp(buf).resize(t.w, t.h, { fit: 'fill' }).greyscale().raw().toBuffer();
    return Array.from(px);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function correlation(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let s = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    s += x * y; sa += x * x; sb += y * y;
  }
  const d = Math.sqrt(sa * sb);
  return d ? s / d : 1;
}

const closest = (sig, others) => (others.length ? Math.max(...others.map((o) => correlation(o, sig))) : -1);

/** Keep candidates (in order) that are unlike every one already kept, up to `max`. */
function dedupe(cands, max) {
  const kept = [];
  for (const c of cands) {
    if (kept.length >= max) break;
    if (closest(c.sig, kept.map((k) => k.sig)) < SIMILAR) kept.push(c);
  }
  return kept.map((k) => k.path);
}

/**
 * Landscape pool: alternates most distinct from the references first, near-copies of a
 * reference or of each other dropped. If every alternate is near a reference, the single most
 * distinct one (the pre-rotation behaviour).
 */
async function landscapePool(item, max) {
  const refs = item.artReferences || [];
  const alts = item.artAlternates || [];
  if (!alts.length || !refs.length) return null;
  const [refSigs, altSigs] = await Promise.all([
    Promise.all(refs.map((p) => signature(p, 'landscape'))),
    Promise.all(alts.map((p) => signature(p, 'landscape'))),
  ]);
  const usableRefs = refSigs.filter(Boolean);
  if (!usableRefs.length) return null;
  const scored = alts.map((path, i) => ({ path, sig: altSigs[i] })).filter((c) => c.sig)
    .map((c) => ({ ...c, score: closest(c.sig, usableRefs) }))
    .sort((a, b) => a.score - b.score);
  if (!scored.length) return null;
  const pool = dedupe(scored.filter((c) => c.score < SIMILAR), max);
  return pool.length ? pool : [scored[0].path];
}

/** Portrait pool: the top-voted textless poster, then any others that aren't near-copies. */
async function portraitPool(item, max) {
  const cands = item.posterCandidates || [];
  if (cands.length < 2 || max < 2) return null;
  const sigs = await Promise.all(cands.map((p) => signature(p, 'portrait')));
  if (!sigs[0]) return null;
  return dedupe(cands.map((path, i) => ({ path, sig: sigs[i] })).filter((c) => c.sig), max);
}

/**
 * Set item.posterPool / item.backdropPool. Items start with one-image pools (see lib/tmdb.js),
 * so anything that fails or misses the time budget still has art.
 */
async function applyArtPools(items, { portrait, landscape, max }) {
  const work = Promise.all(items.map(async (item) => {
    const [p, l] = await Promise.all([
      portrait ? portraitPool(item, max) : null,
      landscape ? landscapePool(item, landscape === 'single' ? 1 : max) : null,
    ]);
    if (p && p.length) item.posterPool = p;
    if (l && l.length) item.backdropPool = l;
  }));
  const budget = new Promise((resolve) => setTimeout(resolve, TOTAL_BUDGET_MS));
  await Promise.race([work, budget]);
  return items;
}

function hash32(str) {
  return parseInt(crypto.createHash('sha1').update(str).digest('hex').slice(0, 8), 16);
}

/**
 * The pool entry for this period. Each title (key) gets its own start image and its own
 * change-over time within the period, and steps through the pool one image per period.
 */
function pickRotating(pool, key, periodHours, now = Date.now()) {
  if (!pool || !pool.length) return null;
  if (pool.length === 1 || !(periodHours > 0)) return pool[0];
  const period = periodHours * 3600e3;
  const h = hash32(key);
  const bucket = Math.floor((now + (h % period)) / period);
  return pool[(h + bucket) % pool.length];
}

module.exports = { applyArtPools, pickRotating, correlation };
