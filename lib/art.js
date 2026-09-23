// lib/art.js
// Picks the landscape card image so it's visibly DIFFERENT from the title's main backdrop.
//
// Why: Nuvio shows a big backdrop behind the home rows (the hero / focused-item background,
// from the metadata addon) and our landscape card underneath it. When both use the same
// image, the card just repeats what's already on screen. TMDB usually has dozens of textless
// backdrops per title, but its top-voted ones are often variants of the SAME key art (same
// photoshoot, slightly different crop), so "next image by votes" frequently still looks the
// same. No similarity threshold separated those reliably when tested on live data, but one
// rule held up across every title checked: among the top few alternates by votes, take the
// one LEAST like the images the backdrop behind the row is likely to be (TMDB's main
// backdrop_path, and the top-voted textless one). That stays within TMDB's best-rated art
// while guaranteeing a different composition.
//
// Similarity = Pearson correlation of a 32x18 greyscale thumbnail (w300 from TMDB's CDN, a
// few KB each). Correlation, not raw pixel difference, because two unrelated DARK images
// otherwise look "close" just by both being dark.
//
// Runs once per catalog build on the final list only (not every trending candidate), all
// titles in parallel, under a hard time budget -- anything not finished in time keeps its
// top-voted alternate, which is still a different file from the main backdrop.

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
