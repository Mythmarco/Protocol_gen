// Generate PWA icons by rendering the Peptides4ALL logo SVG via Puppeteer
// (Chrome handles nested clip-paths correctly, librsvg/sharp does not).
// Run: node scripts/generate-icons.mjs
import puppeteer from "puppeteer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOGO_SRC = "/Users/marco_s/Downloads/PEPTIDES (3).svg";
const logoSVG = readFileSync(LOGO_SRC, "utf8");

// Strip the outer <svg> tag to embed inside our own square viewBox
const innerSVG = logoSVG.replace(/<\?xml[^>]*\?>/, "").replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// Brand mark sits at (≈42..168, ≈14..162) in the original 375×162.75 viewBox.
// Translate so its center lands at (256,256) in a 512×512 icon canvas, scaled
// to fit ~72% of the canvas (safe area for maskable icons).
const BRAND_W = 126;
const BRAND_H = 148;
const BRAND_CX = 42 + BRAND_W / 2;   // 105
const BRAND_CY = 14 + BRAND_H / 2;   // 88
const ICON_SIZE = 512;
const SAFE_RATIO = 0.78;
const SCALE = (ICON_SIZE * SAFE_RATIO) / Math.max(BRAND_W, BRAND_H);
const TX = ICON_SIZE / 2 - BRAND_CX * SCALE;
const TY = ICON_SIZE / 2 - BRAND_CY * SCALE;

function buildIconHTML(size) {
  const radius = Math.round(size * 0.19);
  return `<!DOCTYPE html>
<html><head><style>
  html,body{margin:0;padding:0;background:transparent}
  .canvas{width:${size}px;height:${size}px;position:relative;border-radius:${radius}px;overflow:hidden;
    background:#f8f7f6;
    background-image:radial-gradient(circle at 50% 0%, rgba(242,176,86,0.22), transparent 70%);
  }
  .canvas svg{position:absolute;top:0;left:0;width:${size}px;height:${size}px}
</style></head><body>
<div class="canvas">
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
       viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" preserveAspectRatio="xMidYMid meet">
    <g transform="translate(${TX} ${TY}) scale(${SCALE})">
      ${innerSVG}
    </g>
  </svg>
</div>
</body></html>`;
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

const outDir = resolve(process.cwd(), "public/icons");
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(buildIconHTML(size), { waitUntil: "load" });
  const png = await page.screenshot({
    type: "png",
    omitBackground: false,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  const outPath = resolve(outDir, `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ ${outPath}`);
}

await browser.close();
writeFileSync(resolve(outDir, "logo-source.svg"), logoSVG);
console.log(`✓ ${resolve(outDir, "logo-source.svg")}`);
