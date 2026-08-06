// scripts/generate-icon.js
// One-off build step: renders the addon's logo/icon as a static PNG, using the
// same glossy Inter Black + gradient + drop-shadow look as the rank badges, so
// the addon has a consistent identity in Stremio's addon list. Run once with
// `node scripts/generate-icon.js`, the output (icon.png at the repo root) is
// committed like any other static asset. No runtime cost, nothing to maintain.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'Inter-Black.ttf');
const SIZE = 512;
const OUT_PATH = path.join(__dirname, '..', 'icon.png');

const svg = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a2c33"/>
      <stop offset="100%" stop-color="#111217"/>
    </linearGradient>
    <linearGradient id="glossFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#f3f3f3"/>
      <stop offset="55%" stop-color="#dcdcdc"/>
      <stop offset="100%" stop-color="#c9c9c9"/>
    </linearGradient>
    <filter id="dropShadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="${SIZE * 0.012}" stdDeviation="${SIZE * 0.018}" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${SIZE * 0.18}" fill="url(#bg)"/>
  <g filter="url(#dropShadow)">
    <text x="50%" y="63%"
          text-anchor="middle"
          font-family="Inter"
          font-weight="900"
          font-size="${SIZE * 0.46}"
          fill="url(#glossFill)"
          stroke="#8f8f8f"
          stroke-width="${SIZE * 0.003}"
          stroke-linejoin="round"
          paint-order="stroke fill">1</text>
  </g>
</svg>`;

const resvg = new Resvg(svg, {
  font: {
    fontFiles: [FONT_PATH],
    loadSystemFonts: false,
    defaultFontFamily: 'Inter',
  },
  fitTo: { mode: 'width', value: SIZE },
});

const png = resvg.render().asPng();

sharp(png)
  .png()
  .toFile(OUT_PATH)
  .then(() => console.log('Wrote', OUT_PATH))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
