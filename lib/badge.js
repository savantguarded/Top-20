// lib/badge.js
// Composites overlays onto a poster (2:3) or landscape (16:9) image, in this order:
//   1. corner vignette (optional) and clearlogo + scrim (optional), baked into the base
//   2. "liquid glass" status pill: blurred crop of the base behind a short label
//      (bottom-flush on portrait, top-flush on landscape)
//   3. glossy rank number in the top-left ('tl') or top-right ('tr') corner
//   4. landscape only: streaming-service logo tile in the bottom-right corner (optional)
// SVG -> resvg (bundled Inter, no system fonts) -> sharp.
//
// Sizing basis is the frame's short side (width on portrait, height on landscape), so the
// badge and vignette keep the same visual weight on both shapes.

const path = require('path');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'Inter-Bold.ttf');
const FONT_FAMILY = 'Inter';
const FONT_WEIGHT = '700';
const RESVG_FONT = { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY };

function renderSvgToPng(svg, width) {
  return new Resvg(svg, { font: RESVG_FONT, fitTo: { mode: 'width', value: width } }).render().asPng();
}

function measureTextWidth(label, fontSize, letterSpacing) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="${fontSize}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${fontSize}" letter-spacing="${letterSpacing}">${label}</text></svg>`;
  return new Resvg(svg, { font: RESVG_FONT }).getBBox().width;
}

function gradientStops(stops) {
  return stops.map(([o, a]) => `<stop offset="${o * 100}%" stop-color="#000000" stop-opacity="${a}"/>`).join('');
}

const basisOf = (w, h, shape) => (shape === 'landscape' ? h : w);

// ---- Rank badge ---------------------------------------------------------------

const BADGE_FONT_RATIO = 0.30;
const BADGE_INSET_RATIO = 0.07;

function badgeSvg(rank, w, h, corner, shape) {
  const basis = basisOf(w, h, shape);
  const fontSize = basis * BADGE_FONT_RATIO;
  const inset = basis * BADGE_INSET_RATIO;
  const x = corner === 'tr' ? w - inset : inset;
  const y = shape === 'landscape' ? basis * 0.30 : h * 0.234;
  const anchor = corner === 'tr' ? 'end' : 'start';
  const text = (fill, extra) => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${fontSize}" ${fill} ${extra}>${rank}</text>`;
  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="glossFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e2e2e2"/><stop offset="45%" stop-color="#d2d2d2"/>
      <stop offset="55%" stop-color="#b9b9b9"/><stop offset="100%" stop-color="#9e9e9e"/>
    </linearGradient>
    <linearGradient id="rimLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="dropShadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="${basis * 0.006}" stdDeviation="${basis * 0.009}" flood-color="#000000" flood-opacity="0.65"/>
      <feDropShadow dx="0" dy="0" stdDeviation="${basis * 0.003}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g filter="url(#dropShadow)">
    ${text('fill="url(#glossFill)"', `stroke="#767676" stroke-width="${basis * 0.0015}" stroke-linejoin="round" paint-order="stroke fill"`)}
    ${text('fill="none"', `stroke="url(#rimLight)" stroke-width="${basis * 0.003}" opacity="0.5"`)}
  </g>
</svg>`;
}

/** How far the badge reaches in from its edge, plus a gap (keeps the landscape pill clear). */
function badgeClearance(rank, basis) {
  if (!rank) return 0;
  return basis * BADGE_INSET_RATIO + measureTextWidth(String(rank), basis * BADGE_FONT_RATIO, 0) + basis * 0.04;
}

// ---- Corner vignette (under the rank badge) --------------------------------------

const VIGNETTE_RX_RATIO = 0.95;
const VIGNETTE_RY_RATIO = 0.72;
const VIGNETTE_STOPS = [[0, 0.7], [0.3, 0.5], [0.65, 0.18], [1, 0]];

function vignetteSvg(w, h, corner, shape) {
  const basis = basisOf(w, h, shape);
  const cx = corner === 'tr' ? w : 0;
  const rx = basis * VIGNETTE_RX_RATIO;
  const ry = basis * VIGNETTE_RY_RATIO;
  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="vig" gradientUnits="userSpaceOnUse" cx="${cx}" cy="0" r="${rx}"
      gradientTransform="translate(${cx} 0) scale(1 ${ry / rx}) translate(${-cx} 0)">${gradientStops(VIGNETTE_STOPS)}</radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#vig)"/>
</svg>`;
}

// ---- Status pill ----------------------------------------------------------------

const PILL_HEIGHT_RATIO = 0.08; // of poster height; measured from the reference design
const PILL_HEIGHT_RATIO_LANDSCAPE = PILL_HEIGHT_RATIO * 1.75; // landscape cards render smaller
const PILL_CORNER_RATIO = 0.15; // of pill height
const PILL_FONT_RATIO = 0.6; // of pill height
const PILL_LETTER_SPACING_RATIO = -0.03; // of font size
const PILL_PADDING_X_RATIO = 0.45; // of pill height, each side
const PILL_MAX_WIDTH_RATIO = 0.85; // of image width
const PILL_BASELINE_RATIO = 0.66;
const PILL_BLUR_SIGMA = 14;

/** Pill box sized to its label. Landscape: top-flush, text shrinks if it would reach the badge. */
function pillRect(label, w, h, shape, rank) {
  const top = shape === 'landscape';
  const ph = Math.round(h * (top ? PILL_HEIGHT_RATIO_LANDSCAPE : PILL_HEIGHT_RATIO));
  let fontSize = h * (top ? PILL_HEIGHT_RATIO_LANDSCAPE : PILL_HEIGHT_RATIO) * PILL_FONT_RATIO;
  let padX = ph * PILL_PADDING_X_RATIO;
  let ink = measureTextWidth(label, fontSize, fontSize * PILL_LETTER_SPACING_RATIO);

  let maxW = w * PILL_MAX_WIDTH_RATIO;
  if (top) {
    maxW = Math.min(maxW, w - 2 * badgeClearance(rank, h));
    const raw = ink + padX * 2;
    if (raw > maxW && maxW > 0) {
      const scale = maxW / raw;
      fontSize *= scale;
      padX *= scale;
      ink = measureTextWidth(label, fontSize, fontSize * PILL_LETTER_SPACING_RATIO);
    }
  }
  const pw = Math.round(Math.min(ink + padX * 2, Math.max(maxW, 1)));
  return {
    x: Math.round((w - pw) / 2),
    y: top ? 0 : h - ph,
    w: pw,
    h: ph,
    fontSize,
    letterSpacing: fontSize * PILL_LETTER_SPACING_RATIO,
    edge: top ? 'top' : 'bottom',
  };
}

/** Rounded only on the exposed edge; square where it meets the frame. */
function pillPath(w, h, edge) {
  const r = Math.round(h * PILL_CORNER_RATIO);
  if (edge === 'top') return `M 0,0 H ${w} V ${h - r} A ${r},${r} 0 0 1 ${w - r},${h} H ${r} A ${r},${r} 0 0 1 0,${h - r} Z`;
  return `M ${r},0 H ${w - r} A ${r},${r} 0 0 1 ${w},${r} V ${h} H 0 V ${r} A ${r},${r} 0 0 1 ${r},0 Z`;
}

function pillSvg(label, rect, blurredCropBase64) {
  const { w, h, fontSize, letterSpacing, edge } = rect;
  const d = pillPath(w, h, edge);
  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="pillClip"><path d="${d}"/></clipPath>
    <linearGradient id="glassSheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="55%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="pillTextShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${h * 0.02}" stdDeviation="${h * 0.035}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g clip-path="url(#pillClip)">
    <image width="${w}" height="${h}" href="data:image/png;base64,${blurredCropBase64}"/>
    <rect width="${w}" height="${h}" fill="#000000" fill-opacity="0.15"/>
    <rect width="${w}" height="${h}" fill="url(#glassSheen)"/>
  </g>
  <path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1"/>
  <text x="${w / 2}" y="${h * PILL_BASELINE_RATIO}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}"
        font-size="${fontSize}" fill="#ffffff" text-anchor="middle" letter-spacing="${letterSpacing}"
        filter="url(#pillTextShadow)">${label}</text>
</svg>`;
}

// ---- Clearlogo + scrim ----------------------------------------------------------
// Landscape: bottom-left, same box as Nuvio's own overlay (62% x 34% of the card), fitted and
// vertically centred, soft radial scrim from the bottom-left corner.
// Portrait: centred just above the status pill's slot, soft linear scrim from the bottom, so
// the logo sits in the same place on every card whether or not it has a pill.

const LOGO_LAYOUT = {
  landscape: (w, h) => {
    const padX = w * 0.04;
    const padB = h * 0.055;
    return { boxW: w * 0.62 - padX * 2, boxH: h * 0.34 - padB, left: padX, bottom: h - padB, align: 'start' };
  },
  portrait: (w, h) => ({
    boxW: w * 0.78,
    boxH: h * 0.17,
    left: w * 0.11,
    bottom: h * (1 - PILL_HEIGHT_RATIO - 0.03),
    align: 'center',
  }),
};

function logoScrim(w, h, shape) {
  if (shape === 'landscape') {
    const rx = w * 0.85;
    const ry = h * 0.6;
    return `<radialGradient id="scrim" gradientUnits="userSpaceOnUse" cx="0" cy="${h}" r="${rx}"
      gradientTransform="translate(0 ${h}) scale(1 ${ry / rx}) translate(0 ${-h})">${gradientStops([[0, 0.45], [0.4, 0.25], [0.75, 0.07], [1, 0]])}</radialGradient>`;
  }
  return `<linearGradient id="scrim" x1="0" y1="1" x2="0" y2="0">${gradientStops([[0, 0.6], [0.25, 0.4], [0.5, 0], [1, 0]])}</linearGradient>`;
}

async function logoSvg(logoBuffer, w, h, shape) {
  const box = LOGO_LAYOUT[shape](w, h);
  const { data, info } = await sharp(logoBuffer, { density: 300 })
    .resize(Math.max(1, Math.round(box.boxW)), Math.max(1, Math.round(box.boxH)), { fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true });
  const x = Math.round(box.align === 'center' ? box.left + (box.boxW - info.width) / 2 : box.left);
  const y = Math.round(box.bottom - box.boxH + (box.boxH - info.height) / 2);
  const basis = basisOf(w, h, shape);
  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${logoScrim(w, h, shape)}
    <filter id="logoShadow" x="-10%" y="-20%" width="120%" height="140%">
      <feDropShadow dx="0" dy="${basis * 0.004}" stdDeviation="${basis * 0.008}" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#scrim)"/>
  <image x="${x}" y="${y}" width="${info.width}" height="${info.height}" filter="url(#logoShadow)" href="data:image/png;base64,${data.toString('base64')}"/>
</svg>`;
}

// ---- Streaming-service tile (landscape, bottom right) ------------------------------
// Rounded-square app icon on the same bottom baseline as the clearlogo box.

const PROVIDER_SIZE_RATIO = 0.15; // of card height
const PROVIDER_RADIUS_RATIO = 0.22; // of tile size, app-icon rounding

async function providerTile(providerBuffer, w, h) {
  const size = Math.round(h * PROVIDER_SIZE_RATIO);
  const pad = Math.round(h * 0.055);
  const r = Math.round(size * PROVIDER_RADIUS_RATIO);
  const icon = await sharp(providerBuffer).resize(size, size, { fit: 'cover' }).png().toBuffer();
  const x = w - pad - size;
  const y = h - pad - size;
  const svg = `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="tile"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" ry="${r}"/></clipPath>
    <filter id="tileShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${h * 0.004}" stdDeviation="${h * 0.01}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#000000" filter="url(#tileShadow)"/>
  <image x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#tile)" href="data:image/png;base64,${icon.toString('base64')}"/>
  <rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${r}" ry="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1"/>
</svg>`;
  return renderSvgToPng(svg, w);
}

// ---- Compose -------------------------------------------------------------------

/**
 * Returns a JPEG. `rank`, `statusLabel`, `logo` and `providerLogo` (image buffers) are each
 * optional; `vignette` adds the corner falloff under the badge. `providerLogo` is landscape only.
 */
async function applyOverlays(imageBuffer, { rank, statusLabel, corner = 'tl', shape = 'portrait', logo = null, providerLogo = null, vignette = false } = {}) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width || (shape === 'landscape' ? 1280 : 500);
  const h = meta.height || (shape === 'landscape' ? 720 : 750);

  const underlays = [];
  if (vignette && rank) underlays.push(renderSvgToPng(vignetteSvg(w, h, corner, shape), w));
  if (logo) {
    try {
      underlays.push(renderSvgToPng(await logoSvg(logo, w, h, shape), w));
    } catch {
      // undecodable logo: render without it
    }
  }
  let base = imageBuffer;
  if (underlays.length) {
    base = await sharp(imageBuffer).resize(w, h)
      .composite(underlays.map((input) => ({ input, left: 0, top: 0 })))
      .png()
      .toBuffer();
  }

  const overlays = [];
  if (statusLabel) {
    const rect = pillRect(statusLabel, w, h, shape, rank);
    const crop = await sharp(base).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).blur(PILL_BLUR_SIGMA).png().toBuffer();
    overlays.push({ input: renderSvgToPng(pillSvg(statusLabel, rect, crop.toString('base64')), rect.w), left: rect.x, top: rect.y });
  }
  if (rank) overlays.push({ input: renderSvgToPng(badgeSvg(rank, w, h, corner, shape), w), left: 0, top: 0 });
  if (providerLogo && shape === 'landscape') {
    try {
      overlays.push({ input: await providerTile(providerLogo, w, h), left: 0, top: 0 });
    } catch {
      // undecodable provider logo: render without it
    }
  }

  let pipeline = sharp(base).resize(w, h);
  if (overlays.length) pipeline = pipeline.composite(overlays);
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

module.exports = { applyOverlays };
