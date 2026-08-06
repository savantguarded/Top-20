// lib/badge.js
// Builds a glossy, Netflix-Top10-style rank number and composites it onto a poster.
// Rendering pipeline: SVG (gradient fill + drop shadow + bevel) -> resvg-js rasterizer
// (custom Inter Bold font loaded from disk, no system fonts needed) -> sharp composite.

const path = require('path');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'Inter-Bold.ttf');
const FONT_FAMILY = 'Inter';
const FONT_WEIGHT = '700';

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

  // Anchor point: small inset from the top-left corner, matching the reference image
  // (the number sits just inside the poster, not bled off the edge). Same anchor for
  // every rank so digit count doesn't shift the badge's position. y is nudged down
  // from the previous smaller size to keep the same top margin now that the glyph is bigger.
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
          stroke-linejoin="round"
          opacity="0.5">${text}</text>
  </g>
</svg>`;
}

/**
 * Render the rank badge to a PNG buffer sized to the poster dimensions.
 */
function renderBadgePng(rank, posterW, posterH) {
  const svg = badgeSvg(rank, posterW, posterH);
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
    fitTo: { mode: 'width', value: posterW },
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

/**
 * Composite a rank badge onto a poster image buffer. Returns a JPEG buffer.
 */
async function applyRankBadge(posterBuffer, rank) {
  const base = sharp(posterBuffer).jpeg({ quality: 90 });
  const meta = await sharp(posterBuffer).metadata();
  const w = meta.width || 500;
  const h = meta.height || 750;

  const badgePng = renderBadgePng(rank, w, h);

  return sharp(posterBuffer)
    .resize(w, h)
    .composite([{ input: badgePng, left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

module.exports = { applyRankBadge, renderBadgePng, badgeSvg };
