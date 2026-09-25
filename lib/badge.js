// lib/badge.js
// Two overlays composited onto a poster:
//  1. A glossy rank number inset in the top-left or top-right corner (see `corner` below --
//     top-left is the original, unchanged design; top-right exists only so the /stremio/
//     manifest flavor doesn't collide with Stremio's own top-left "watched" checkmark).
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
// feel cramped. That was a separate, additional chip layered on top of everything else, not
// the rank badge itself -- unrelated to the rank badge's own top-right option below, which
// only exists for the /stremio/ flavor and is never combined with a Nuvio install. If a
// provider logo chip comes back for Nuvio, it still can't use top-right -- bottom-left or
// merged into the status pill were the leading alternatives.
//
// `shape` ('portrait' default, or 'landscape') drives two things for a wide/backdrop-style
// image instead of the standard 2:3 poster:
//   - the rank badge's sizing basis switches from posterW to posterH. Portrait's short side
//     is width, so sizing off posterW keeps the badge a small corner accent; on a 16:9 canvas
//     width is the LONG side, so sizing off it the same way would balloon the badge to a huge
//     fraction of the frame. Sizing off posterH instead keeps the same proportional "corner
//     badge" weight on both shapes.
//   - the status pill anchors to the TOP edge (flush, y=0) instead of the bottom, with the
//     rounded/square corners mirrored (square against the flush top edge, rounded on the
//     exposed bottom edge), and is 1.75x taller (PILL_HEIGHT_RATIO_TOP) since landscape cards
//     render much shorter on screen -- see pillRect()/topPillRect()/pillPath() below. Font
//     size, padding and corner radius are ratios of pill height, so they scale with it; the
//     ratios themselves, letter-spacing, colors and blur are identical between shapes. On a
//     long label beside a two-digit rank, the text shrinks just enough to clear the badge.

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

// ---- Top-left / top-right rank number ---------------------------------------

/**
 * Build the SVG markup for a single rank badge.
 * Designed to sit as a small inset badge in a top corner of a 2:3 poster, matching the
 * reference "Top 10" style card. `corner` is 'tl' (default, original design, unchanged
 * pixel-for-pixel) or 'tr' -- 'tr' mirrors the same inset off the right edge instead
 * (text-anchor flips from start to end so the digits' outer edge, not their origin point,
 * is what's held at the same 7%-of-width inset the 'tl' version uses from its edge).
 * `shape` ('portrait' default, or 'landscape') only changes the SIZING BASIS -- see the
 * file header comment above. Portrait's math (basis = posterW) is byte-identical to before.
 */
function badgeSvg(rank, posterW, posterH, corner, shape) {
  const text = String(rank);

  // Sizing basis: the short side of the frame. Portrait (2:3) is shortest on width, so this
  // is posterW, unchanged from before. Landscape (16:9) is shortest on height, so basing the
  // same ratios off posterH instead keeps the badge a small corner accent on either shape,
  // rather than ballooning on the long side of a wide canvas.
  const basis = shape === 'landscape' ? posterH : posterW;

  // Same font size regardless of digit count, so "4" and "20" carry the same
  // visual weight, Inter's tabular figures just make "20" a bit wider, not smaller.
  const fontSize = basis * 0.30;

  // Anchor point: small inset from the top corner, matching the reference image.
  const inset = basis * 0.07;
  const x = corner === 'tr' ? posterW - inset : inset;
  const y = shape === 'landscape' ? basis * 0.30 : posterH * 0.234;
  const textAnchor = corner === 'tr' ? 'end' : 'start';

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
      <feDropShadow dx="0" dy="${basis * 0.006}" stdDeviation="${basis * 0.009}" flood-color="#000000" flood-opacity="0.65"/>
      <feDropShadow dx="0" dy="0" stdDeviation="${basis * 0.003}" flood-color="#000000" flood-opacity="0.55"/>
    </filter>
  </defs>
  <g filter="url(#dropShadow)">
    <text x="${x}" y="${y}"
          text-anchor="${textAnchor}"
          font-family="${FONT_FAMILY}"
          font-weight="${FONT_WEIGHT}"
          font-size="${fontSize}"
          fill="url(#glossFill)"
          stroke="#767676"
          stroke-width="${basis * 0.0015}"
          stroke-linejoin="round"
          paint-order="stroke fill">${text}</text>
    <text x="${x}" y="${y}"
          text-anchor="${textAnchor}"
          font-family="${FONT_FAMILY}"
          font-weight="${FONT_WEIGHT}"
          font-size="${fontSize}"
          fill="none"
          stroke="url(#rimLight)"
          stroke-width="${basis * 0.003}"
          opacity="0.5">${text}</text>
  </g>
</svg>`;
}

function renderBadgePng(rank, posterW, posterH, corner, shape) {
  return renderSvgToPng(badgeSvg(rank, posterW, posterH, corner, shape), posterW);
}

// ---- Landscape corner vignette ----------------------------------------------
// Landscape only. A soft dark radial falloff anchored on the rank badge's corner, drawn UNDER
// the badge, so the silver digits read against bright backdrops (snow, sky, white sets)
// without darkening the rest of the frame. Sized off posterH like the landscape badge, so it
// scales with the canvas. Portrait posters never get it (unchanged).
const VIGNETTE_RX_RATIO = 0.95; // horizontal reach, relative to posterH
const VIGNETTE_RY_RATIO = 0.72; // vertical reach, relative to posterH
const VIGNETTE_STOPS = [
  [0, 0.7],
  [0.3, 0.5],
  [0.65, 0.18],
  [1, 0],
];

function vignetteSvg(posterW, posterH, corner) {
  const cx = corner === 'tr' ? posterW : 0;
  const rx = posterH * VIGNETTE_RX_RATIO;
  const ry = posterH * VIGNETTE_RY_RATIO;
  const stops = VIGNETTE_STOPS
    .map(([o, a]) => `<stop offset="${o * 100}%" stop-color="#000000" stop-opacity="${a}"/>`)
    .join('');
  return `
<svg width="${posterW}" height="${posterH}" viewBox="0 0 ${posterW} ${posterH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="vig" gradientUnits="userSpaceOnUse" cx="${cx}" cy="0" r="${rx}"
                    gradientTransform="translate(${cx} 0) scale(1 ${ry / rx}) translate(${-cx} 0)">
      ${stops}
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="${posterW}" height="${posterH}" fill="url(#vig)"/>
</svg>`;
}

// ---- Landscape clearlogo (bottom-left) ----------------------------------------
// Drawn by us so Nuvio never has to: once `landscapePoster` is set, Nuvio shows the card as-is
// with no logo overlay (NuvioTV ModernHomeRows.kt). Geometry copies Nuvio's own overlay: a box
// 62% of the card wide x 34% tall, anchored bottom-left, logo fitted inside and vertically
// centred, small side/bottom padding. A faint bottom-left falloff plus a drop shadow keep
// white logos readable on bright frames.
const LOGO_BOX_W_RATIO = 0.62;
const LOGO_BOX_H_RATIO = 0.34;
const LOGO_PAD_X_RATIO = 0.04; // of card width
const LOGO_PAD_B_RATIO = 0.055; // of card height
const LOGO_SCRIM_STOPS = [
  [0, 0.45],
  [0.4, 0.25],
  [0.75, 0.07],
  [1, 0],
];

async function logoLayerPng(logoBuffer, w, h) {
  const padX = w * LOGO_PAD_X_RATIO;
  const padB = h * LOGO_PAD_B_RATIO;
  const areaW = Math.max(1, Math.round(w * LOGO_BOX_W_RATIO - padX * 2));
  const areaH = Math.max(1, Math.round(h * LOGO_BOX_H_RATIO - padB));
  const { data, info } = await sharp(logoBuffer, { density: 300 })
    .resize(areaW, areaH, { fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true });
  const lx = Math.round(padX);
  const ly = Math.round(h - padB - areaH + (areaH - info.height) / 2);
  const rx = w * 0.85;
  const ry = h * 0.6;
  const stops = LOGO_SCRIM_STOPS
    .map(([o, a]) => `<stop offset="${o * 100}%" stop-color="#000000" stop-opacity="${a}"/>`)
    .join('');
  const svg = `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="scrim" gradientUnits="userSpaceOnUse" cx="0" cy="${h}" r="${rx}"
                    gradientTransform="translate(0 ${h}) scale(1 ${ry / rx}) translate(0 ${-h})">
      ${stops}
    </radialGradient>
    <filter id="logoShadow" x="-10%" y="-20%" width="120%" height="140%">
      <feDropShadow dx="0" dy="${h * 0.004}" stdDeviation="${h * 0.008}" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="${w}" height="${h}" fill="url(#scrim)"/>
  <image x="${lx}" y="${ly}" width="${info.width}" height="${info.height}" filter="url(#logoShadow)"
         href="data:image/png;base64,${data.toString('base64')}"/>
</svg>`;
  return renderSvgToPng(svg, w);
}

// ---- Bottom status pill -----------------------------------------------------

const PILL_HEIGHT_RATIO = 0.08; // measured: 60px of a 750px-tall reference poster
const PILL_CORNER_RATIO = 0.15; // relative to pill height, rounded top corners only

// Landscape (top-anchored) pill: 1.75x the portrait pill's height. Landscape cards render much
// shorter on screen than portrait ones, so the same 8%-of-height pill read as tiny there. Font
// size, padding and corner radius are all ratios of pill height, so the whole pill scales
// together. Portrait keeps PILL_HEIGHT_RATIO, untouched.
const PILL_HEIGHT_RATIO_TOP = PILL_HEIGHT_RATIO * 1.75;
// Minimum horizontal gap kept between the landscape pill and the rank badge, relative to
// poster height. The bigger pill can reach the badge on long labels ("Season Finale Sep 30")
// next to a two-digit rank, so pillRect() shrinks just the text in that case -- see below.
const PILL_BADGE_GAP_RATIO = 0.04;

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
 * `edge` is 'bottom' (default, original/unchanged -- flush with the bottom edge) or 'top'
 * (NEW, for shape='landscape' -- flush with the top edge, y=0, anchored rather than a
 * floating inset). Every other measurement (height, font size, letter-spacing, padding,
 * centering) is identical between the two -- only the y position changes.
 */
function pillRect(label, posterW, posterH, edge, badgeClearance) {
  if (edge === 'top') return topPillRect(label, posterW, posterH, badgeClearance || 0);

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

/**
 * Landscape pill: flush with the top edge (y=0), PILL_HEIGHT_RATIO_TOP tall, same font/
 * letter-spacing/padding ratios as portrait. It's centred, and the rank badge sits in a top
 * corner at the same height, so `badgeClearance` (how far the badge reaches in from its edge,
 * plus a gap) is kept clear on BOTH sides -- symmetric, so it works for the 'tl' and 'tr'
 * corners alike. If a long label wouldn't fit in that space, only the text (and its padding)
 * scales down; the pill keeps its full height so every tag still lines up.
 */
function topPillRect(label, posterW, posterH, badgeClearance) {
  const h = Math.round(posterH * PILL_HEIGHT_RATIO_TOP);
  let fontSize = posterH * PILL_HEIGHT_RATIO_TOP * PILL_FONT_HEIGHT_RATIO;
  let letterSpacing = pillLetterSpacing(fontSize);
  let inkWidth = measureLabelWidth(label, fontSize, letterSpacing);
  let paddingX = h * PILL_PADDING_X_RATIO;

  const maxW = Math.min(posterW * PILL_MAX_WIDTH_RATIO, posterW - 2 * badgeClearance);
  const rawWidth = inkWidth + paddingX * 2;
  if (rawWidth > maxW && maxW > 0) {
    const scale = maxW / rawWidth;
    fontSize *= scale;
    letterSpacing = pillLetterSpacing(fontSize);
    paddingX *= scale;
    inkWidth = measureLabelWidth(label, fontSize, letterSpacing);
  }

  const w = Math.round(Math.min(inkWidth + paddingX * 2, Math.max(maxW, 1)));
  const x = Math.round((posterW - w) / 2);
  return { x, y: 0, w, h, fontSize, letterSpacing };
}

/**
 * How far the landscape rank badge reaches in from its corner edge (inset + measured digit
 * width) plus PILL_BADGE_GAP_RATIO. Uses the same sizing as badgeSvg()'s landscape branch.
 */
function landscapeBadgeClearance(rank, posterH) {
  if (!rank) return 0;
  const basis = posterH;
  const fontSize = basis * 0.30;
  const inset = basis * 0.07;
  return inset + measureLabelWidth(String(rank), fontSize, 0) + posterH * PILL_BADGE_GAP_RATIO;
}

/**
 * The pill's rounded-rect outline. 'bottom' (default) rounds the top two corners only --
 * the pill sits flush against the poster's bottom edge, so that edge stays square (flush
 * against the frame) and the exposed top edge is rounded. 'top' is the exact mirror image:
 * flush against the poster's top edge (square there), rounded on the exposed bottom edge
 * instead. Same PILL_CORNER_RATIO radius either way, just which pair of corners it applies to.
 */
function pillPath(w, h, edge) {
  const r = Math.round(h * PILL_CORNER_RATIO);
  if (edge === 'top') {
    return `M 0,0 H ${w} V ${h - r} A ${r},${r} 0 0 1 ${w - r},${h} H ${r} A ${r},${r} 0 0 1 0,${h - r} Z`;
  }
  return `M ${r},0 H ${w - r} A ${r},${r} 0 0 1 ${w},${r} V ${h} H 0 V ${r} A ${r},${r} 0 0 1 ${r},0 Z`;
}

function pillSvg(label, w, h, blurredCropBase64, fontSize, letterSpacing, edge) {
  const d = pillPath(w, h, edge);

  return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="pillClip">
      <path d="${d}"/>
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
  <path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="${PILL_BORDER_OPACITY}" stroke-width="1"/>
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
 * `corner` ('tl' default, or 'tr') controls which top corner the rank badge sits in --
 * see badgeSvg() above. `shape` ('portrait' default, or 'landscape') is NEW -- see the file
 * header comment for what it changes (badge sizing basis, pill edge/corner-rounding). The
 * 'portrait' branch is untouched math from before this was added. Returns a JPEG buffer.
 */
async function applyOverlays(posterBuffer, { rank, statusLabel, corner = 'tl', shape = 'portrait', logo = null } = {}) {
  const meta = await sharp(posterBuffer).metadata();
  const w = meta.width || (shape === 'landscape' ? 1280 : 500);
  const h = meta.height || (shape === 'landscape' ? 720 : 750);
  const pillEdge = shape === 'landscape' ? 'top' : 'bottom';

  // Landscape: bake the corner vignette into the base first, so the glass pill's blurred crop
  // samples the darkened image and blends in, instead of showing an un-vignetted patch.
  if (shape === 'landscape' && rank) {
    posterBuffer = await sharp(posterBuffer)
      .resize(w, h)
      .composite([{ input: renderSvgToPng(vignetteSvg(w, h, corner), w), left: 0, top: 0 }])
      .png()
      .toBuffer();
  }

  const composites = [];

  // Landscape only: clearlogo bottom-left. Skipped silently if the logo can't be decoded.
  if (shape === 'landscape' && logo) {
    try {
      composites.push({ input: await logoLayerPng(logo, w, h), left: 0, top: 0 });
    } catch {
      // bad logo file: render the card without it
    }
  }

  if (rank) {
    composites.push({ input: renderBadgePng(rank, w, h, corner, shape), left: 0, top: 0 });
  }

  if (statusLabel) {
    const clearance = pillEdge === 'top' ? landscapeBadgeClearance(rank, h) : 0;
    const { x, y, w: pw, h: ph, fontSize, letterSpacing } = pillRect(statusLabel, w, h, pillEdge, clearance);
    const blurredCrop = await sharp(posterBuffer)
      .extract({ left: x, top: y, width: pw, height: ph })
      .blur(PILL_BLUR_SIGMA)
      .png()
      .toBuffer();
    const pillPng = renderSvgToPng(
      pillSvg(statusLabel, pw, ph, blurredCrop.toString('base64'), fontSize, letterSpacing, pillEdge),
      pw
    );
    composites.push({ input: pillPng, left: x, top: y });
  }

  let pipeline = sharp(posterBuffer).resize(w, h);
  if (composites.length) pipeline = pipeline.composite(composites);
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

module.exports = { applyOverlays };
