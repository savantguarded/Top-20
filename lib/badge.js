// lib/badge.js
// Two overlays composited onto a poster:
//  1. A glossy rank number inset in the top-left corner (unchanged from before).
//  2. A bottom-flush status pill -- a blurred/tinted crop of the poster itself behind a
//     short status label ("Just Added", "New Episode", "Season Finale", etc.) -- modeled
//     directly on toptoday.llamayu.com's bottom overlay. Its geometry (centered, 47.6% of
//     poster width, 8% of poster height, flush with the bottom edge, rounded top corners
//     only) was measured by pixel-diffing a tagged vs. untagged render of the same poster
//     from that service, not guessed.
// Rendering pipeline for both: SVG (gradients / blurred image embed / text) -> resvg-js
// rasterizer (bundled Inter font, no system fonts needed) -> sharp composite.

const path = require('path');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'Inter-Bold.ttf');
const FONT_FAMILY = 'Inter';
const FONT_WEIGHT = '700';

function renderSvgToPng(svg, width) {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
    fitTo: { mode: 'width', value: width },
  });
  return resvg.render().asPng();
}

// ---- Top-left rank number (unchanged design) -------------------------------

/**
 * Build the SVG markup for a single rank badge.
 * Designed to sit as a small inset badge in the top-left corner of a 2:3 poster,
 * matching the reference "Top 10" style card.
 */
function badgeSvg(rank, posterW, posterH) {
  const text = String(rank);

  // Same font size regardless of digit count, so "4" and "20" carry the same
  // visual weight, Inter's tabular figures just make "20" a bit wider, not smaller.
  const fontSize = posterW * 0.30;

  // Anchor point: small inset from the top-left corner, matching the reference image.
  const x = posterW * 0.07;
  const y = posterH * 0.234;

  return `
<svg width="${posterW}" height="${posterH}" viewBox="0 0 ${posterW} ${posterH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="glossFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e2e2e2"/>
      <stop offset="45%" stop-color="#d2d2d2"/>
      <stop offset="55%" stop-color="#b9b9b9"/>
      <stop offset="100%" stop-color="#9e9e9e"/>
    </linearGradient>
    <linearGradient id="rimLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="dropShadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="${posterW * 0.006}" stdDeviation="${posterW * 0.009}" flood-color="#000000" flood-opacity="0.65"/>
      <feDropShadow dx="0" dy="0" stdDeviation="${posterW * 0.003}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g filter="url(#dropShadow)">
    <text x="${x}" y="${y}"
          font-family="${FONT_FAMILY}"
          font-weight="${FONT_WEIGHT}"
          font-size="${fontSize}"
          fill="url(#glossFill)"
          stroke="#767676"
          stroke-width="${posterW * 0.0015}"
          stroke-linejoin="round"
          paint-order="stroke fill">${text}</text>
    <text x="${x}" y="${y}"
          font-family="${FONT_FAMILY}"
          font-weight="${FONT_WEIGHT}"
          font-size="${fontSize}"
          fill="none"
          stroke="url(#rimLight)"
          stroke-width="${posterW * 0.003}"
          opacity="0.5">${text}</text>
  </g>
</svg>`;
}

function renderBadgePng(rank, posterW, posterH) {
  return renderSvgToPng(badgeSvg(rank, posterW, posterH), posterW);
}

// ---- Bottom status pill -----------------------------------------------------

const PILL_WIDTH_RATIO = 0.476; // measured: 238px of a 500px-wide reference poster
const PILL_HEIGHT_RATIO = 0.08; // measured: 60px of a 750px-tall reference poster
const PILL_CORNER_RATIO = 0.15; // relative to pill height, rounded top corners only
const PILL_TINT = '#2b1210'; // dark maroon tint over the blurred poster crop
const PILL_TINT_OPACITY = 0.55;
const PILL_BLUR_SIGMA = 8;

function pillRect(posterW, posterH) {
  const w = Math.round(posterW * PILL_WIDTH_RATIO);
  const h = Math.round(posterH * PILL_HEIGHT_RATIO);
  const x = Math.round((posterW - w) / 2);
  const y = posterH - h; // flush with the bottom edge
  return { x, y, w, h };
}

function pillSvg(label, w, h, blurredCropBase64) {
  const r = Math.round(h * PILL_CORNER_RATIO);
  // Shrink the font a bit for longer labels ("Finale Aug 7") so they never overflow.
  const fontSize = label.length > 13 ? h * 0.27 : h * 0.34;

  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="pillClip">
      <path d="M ${r},0 H ${w - r} A ${r},${r} 0 0 1 ${w},${r} V ${h} H 0 V ${r} A ${r},${r} 0 0 1 ${r},0 Z"/>
    </clipPath>
  </defs>
  <g clip-path="url(#pillClip)">
    <image x="0" y="0" width="${w}" height="${h}" href="data:image/png;base64,${blurredCropBase64}"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="${PILL_TINT}" fill-opacity="${PILL_TINT_OPACITY}"/>
  </g>
  <text x="${w / 2}" y="${h * 0.64}"
        font-family="${FONT_FAMILY}"
        font-weight="${FONT_WEIGHT}"
        font-size="${fontSize}"
        fill="#ffffff"
        text-anchor="middle"
        letter-spacing="${w * 0.003}">${label}</text>
</svg>`;
}

/**
 * Composite the rank badge and/or the status pill onto a poster image buffer.
 * Pass rank as null/undefined to skip the rank badge, or statusLabel as
 * null/undefined/empty to skip the pill -- so callers can use either, both, or neither.
 * Returns a JPEG buffer.
 */
async function applyOverlays(posterBuffer, { rank, statusLabel } = {}) {
  const meta = await sharp(posterBuffer).metadata();
  const w = meta.width || 500;
  const h = meta.height || 750;

  const composites = [];

  if (rank) {
    composites.push({ input: renderBadgePng(rank, w, h), left: 0, top: 0 });
  }

  if (statusLabel) {
    const { x, y, w: pw, h: ph } = pillRect(w, h);
    const blurredCrop = await sharp(posterBuffer)
      .extract({ left: x, top: y, width: pw, height: ph })
      .blur(PILL_BLUR_SIGMA)
      .png()
      .toBuffer();
    const pillPng = renderSvgToPng(pillSvg(statusLabel, pw, ph, blurredCrop.toString('base64')), pw);
    composites.push({ input: pillPng, left: x, top: y });
  }

  let pipeline = sharp(posterBuffer).resize(w, h);
  if (composites.length) pipeline = pipeline.composite(composites);
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

module.exports = { applyOverlays, renderBadgePng, badgeSvg, pillSvg, pillRect };
