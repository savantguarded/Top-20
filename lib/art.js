// lib/art.js
// Picks the landscape 'alternate' card so it looks different from the backdrop behind the row.
// TMDB's top-voted textless backdrops are often crops of the same key art, so among the top
// alternates we take the one LEAST correlated with the references (TMDB's main backdrop and the
// top textless one). Similarity = Pearson correlation of 32x18 greyscale thumbnails (w300, a few
// KB each); correlation rather than pixel difference so two unrelated dark images don't match.
// Runs on the final list only, in parallel, under a time budget; anything unfinished keeps its
// top-voted alternate.

const sharp = require('sharp');

const THUMB_BASE = 'https://image.tmdb.org/t/p/w300';
const THUMB_W = 32;
const THUMB_H = 18;
const FETCH_TIMEOUT_MS = 3000;
const TOTAL_BUDGET_MS = 4000;

async function thumbSignature(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(THUMB_BASE + path, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const px = await sharp(buf).resize(THUMB_W, THUMB_H, { fit: 'fill' }).greyscale().raw().toBuffer();
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

/** For one item: the alternate least like any of its reference images, or null. */
async function pickMostDistinct(item) {
  const refs = item.artReferences || [];
  const alts = item.artAlternates || [];
  if (!alts.length || !refs.length) return null;

  const [refSigs, altSigs] = await Promise.all([
    Promise.all(refs.map(thumbSignature)),
    Promise.all(alts.map(thumbSignature)),
  ]);
  const usableRefs = refSigs.filter(Boolean);
  if (!usableRefs.length) return null;

  let best = null;
  let bestScore = Infinity;
  alts.forEach((path, i) => {
    const sig = altSigs[i];
    if (!sig) return;
    // Score = how close it is to the MOST similar reference; lower is more distinct.
    const score = Math.max(...usableRefs.map((r) => correlation(r, sig)));
    if (score < bestScore) { bestScore = score; best = path; }
  });
  return best;
}

/**
 * Set each item's backdrop_path to its most distinct alternate. Items start out with the
 * top-voted alternate already in backdrop_path (see lib/tmdb.js), so anything that fails or
 * misses the time budget is still left with a different image from the main backdrop.
 */
async function applyDistinctBackdrops(items) {
  const work = Promise.all(items.map(async (item) => {
    const path = await pickMostDistinct(item);
    if (path) item.backdrop_path = path;
  }));
  const budget = new Promise((resolve) => setTimeout(resolve, TOTAL_BUDGET_MS));
  await Promise.race([work, budget]);
  return items;
}

module.exports = { applyDistinctBackdrops, correlation };
