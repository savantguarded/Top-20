// lib/badge.js
// Two overlays composited onto a poster:
//  1. A glossy rank number inset in the top-left corner (unchanged from before).
//  2. A bottom-flush "liquid glass" status pill -- a blurred/tinted crop of the poster
//     itself behind a short status label ("Just Added", "Now on Blu-ray", "New Episode",
//     etc.) -- modeled on toptoday.llamayu.com's bottom overlay. Pill height (8% of poster
//     height, flush with the bottom edge, rounded top corners only) was measured by
//     pixel-diffing a tagged vs. untagged render of the same poster from that service, not
//     guessed. Pill width is dynamic -- it hugs each label's own rendered text width, so
//     short and long labels get correctly proportioned chips instead of all sharing one
//     fixed-width bar.
// Rendering pipeline for both: SVG (gradients / blurred image embed / text) -> resvg-js
// rasterizer (bundled Inter font, no system fonts needed) -> sharp composite.
//
// A per-title streaming-provider logo chip (top-right corner) was tried and pulled back
// out -- it collided with Nuvio's own top-right "watched" checkmark overlay and made cards
// feel cramped. If this comes back, revisit placement (bottom-left corner or merged into
// the status pill were the leading alternatives) rather than reusing the top-right spot.

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

const PILL_HEIGHT_RATIO = 0.08; // measured: 60px of a 750px-tall reference poster
const PILL_CORNER_RATIO = 0.15; // relative to pill height, rounded top corners only

// A "liquid glass" look: blur whatever poster is behind the pill, lay a neutral, very
// see-through dark wash over it for text contrast (not tinted toward any one color, so it
// reads well against a light poster, a dark poster, or anything in between), then add a
// soft top-to-bottom light sheen and a faint white edge stroke so the pill still reads as
// a distinct glass panel even at high transparency, rather than dissolving into the art.
const PILL_TINT = '#000000';
const PILL_TINT_OPACITY = 0.15;
const PILL_BLUR_SIGMA = 14;
const PILL_SHEEN_OPACITY = 0.16; // top highlight, fades to nothing by mid-pill
const PILL_BORDER_OPACITY = 0.25; // thin white edge stroke

// Text sizing: every pill uses the SAME font size and letter-spacing, so the row of tags
// looks consistent regardless of label. Rather than a fixed-width bar that every label has
// to be squeezed or padded to fit, the pill itself is sized to the label: width = the
// rendered text's ink width (measured directly via resvg, not estimated) plus fixed padding
// on each side. Short labels ("Premiere") get a narrow chip, long ones ("Now Streaming") get
// a wider one -- both centered and flush with the bottom edge. That also means letter-spacing
// no longer has to be squeezed tight to avoid overflowing a fixed box, so it can sit at a more
// natural, slightly-open tracking instead of the very tight value a fixed-width pill needed.
const PILL_FONT_HEIGHT_RATIO = 0.6; // fixed font size, relative to pill height
const PILL_LETTER_SPACING_RATIO = -0.03; // relative to font-size -- slightly open, not tight
const PILL_PADDING_X_RATIO = 0.45; // horizontal padding each side, relative to pill height
const PILL_MAX_WIDTH_RATIO = 0.85; // safety cap on pill width, relative to poster width
const PILL_TEXT_BASELINE_RATIO = 0.66; // vertical centering, tuned to the reference

function pillFontSize(posterH) {
  return posterH * PILL_HEIGHT_RATIO * PILL_FONT_HEIGHT_RATIO;
}

function pillLetterSpacing(fontSize) {
  return fontSize * PILL_LETTER_SPACING_RATIO;
}

/**
 * Rendered ink width of a label at the given font size/letter-spacing, measured directly
 * via resvg's bounding box rather than estimated from character counts.
 */
function measureLabelWidth(label, fontSize, letterSpacing) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">
    <text x="0" y="${fontSize}"
          font-family="${FONT_FAMILY}"
          font-weight="${FONT_WEIGHT}"
          font-size="${fontSize}"
          letter-spacing="${letterSpacing}">${label}</text>
  </svg>`;
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  return resvg.getBBox().width;
}

/**
 * Pill geometry sized to the label itself: a fixed height (consistent with the poster's
 * other overlays) but a width that hugs the rendered text plus padding, instead of a
 * fixed-width bar every label has to fit inside.
 */
function pillRect(label, posterW, posterH) {
  const h = Math.round(posterH * PILL_HEIGHT_RATIO);
  const fontSize = pillFontSize(posterH);
  const letterSpacing = pillLetterSpacing(fontSize);
  const inkWidth = measureLabelWidth(label, fontSize, letterSpacing);
  const paddingX = h * PILL_PADDING_X_RATIO;
  const rawWidth = inkWidth + paddingX * 2;
  const w = Math.round(Math.min(rawWidth, posterW * PILL_MAX_WIDTH_RATIO));
  const x = Math.round((posterW - w) / 2);
  const y = posterH - h; // flush with the bottom edge
  return { x, y, w, h, fontSize, letterSpacing };
}

function pillSvg(label, w, h, blurredCropBase64, fontSize, letterSpacing) {
  const r = Math.round(h * PILL_CORNER_RATIO);
  const pillPath = `M ${r},0 H ${w - r} A ${r},${r} 0 0 1 ${w},${r} V ${h} H 0 V ${r} A ${r},${r} 0 0 1 ${r},0 Z`;

  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="pillClip">
      <path d="${pillPath}"/>
    </clipPath>
    <linearGradient id="glassSheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="${PILL_SHEEN_OPACITY}"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="pillTextShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${h * 0.02}" stdDeviation="${h * 0.035}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g clip-path="url(#pillClip)">
    <image x="0" y="0" width="${w}" height="${h}" href="data:image/png;base64,${blurredCropBase64}"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="${PILL_TINT}" fill-opacity="${PILL_TINT_OPACITY}"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="url(#glassSheen)"/>
  </g>
  <path d="${pillPath}" fill="none" stroke="#ffffff" stroke-opacity="${PILL_BORDER_OPACITY}" stroke-width="1"/>
  <text x="${w / 2}" y="${h * PILL_TEXT_BASELINE_RATIO}"
        font-family="${FONT_FAMILY}"
        font-weight="${FONT_WEIGHT}"
        font-size="${fontSize}"
        fill="#ffffff"
        text-anchor="middle"
        letter-spacing="${letterSpacing}"
        filter="url(#pillTextShadow)">${label}</text>
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
    const { x, y, w: pw, h: ph, fontSize, letterSpacing } = pillRect(statusLabel, w, h);
    const blurredCrop = await sharp(posterBuffer)
      .extract({ left: x, top: y, width: pw, height: ph })
      .blur(PILL_BLUR_SIGMA)
      .png()
      .toBuffer();
    const pillPng = renderSvgToPng(
      pillSvg(statusLabel, pw, ph, blurredCrop.toString('base64'), fontSize, letterSpacing),
      pw
    );
    composites.push({ input: pillPng, left: x, top: y });
  }

  let pipeline = sharp(posterBuffer).resize(w, h);
  if (composites.length) pipeline = pipeline.composite(composites);
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

module.exports = { applyOverlays, renderBadgePng, badgeSvg, pillSvg, pillRect, pillFontSize };
