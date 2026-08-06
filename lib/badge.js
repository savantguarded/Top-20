// lib/badge.js
// Builds a glossy, Netflix-Top10-style rank number and composites it onto a poster.
// Rendering pipeline: SVG (gradient fill + drop shadow + bevel) -> resvg-js rasterizer
// (custom Anton font loaded from disk, no system fonts needed) -> sharp composite.

const path = require('path');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'Anton-Regular.ttf');

/**
 * Build the SVG markup for a single rank badge.
 * Designed to sit on the top-left corner of a 2:3 poster, bleeding slightly
 * off the top and left edges, matching the reference "Top 10" style card.
 */
function badgeSvg(rank, posterW, posterH) {
  const text = String(rank);
  const isDouble = text.length > 1;

  // Font size scales with poster width; single digits render larger than double digits
  // so a "20" doesn't look cramped next to a "4". (Sized to match the reference image:
  // roughly half the size of the first pass.)
  const fontSize = isDouble ? posterW * 0.20 : posterW * 0.26;

  // Anchor point: small inset from the top-left corner, matching the reference image
  // (the number sits just inside the poster, not bled off the edge).
  const x = posterW * (isDouble ? 0.05 : 0.08);
  const y = posterH * (isDouble ? 0.19 : 0.21);

  return `
<svg width="${posterW}" height="${posterH}" viewBox="0 0 ${posterW} ${posterH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="glossFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#f3f3f3"/>
      <stop offset="55%" stop-color="#dcdcdc"/>
      <stop offset="100%" stop-color="#c9c9c9"/>
    </linearGradient>
    <linearGradient id="rimLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="dropShadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="${posterW * 0.006}" stdDeviation="${posterW * 0.009}" flood-color="#000000" flood-opacity="0.65"/>
      <feDropShadow dx="0" dy="0" stdDeviation="${posterW * 0.003}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g filter="url(#dropShadow)">
    <text x="${x}" y="${y}"
          font-family="Anton"
          font-size="${fontSize}"
          fill="url(#glossFill)"
          stroke="#8f8f8f"
          stroke-width="${posterW * 0.0015}"
          stroke-linejoin="round"
          paint-order="stroke fill">${text}</text>
    <text x="${x}" y="${y}"
          font-family="Anton"
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
      defaultFontFamily: 'Anton',
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
