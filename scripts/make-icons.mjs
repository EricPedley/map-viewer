import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(__dirname, '..', 'public', 'icons');
const svgPath = path.join(iconsDir, 'icon.svg');

const sizes = [180, 192, 512];

for (const size of sizes) {
  const out = path.join(iconsDir, `icon-${size}.png`);
  await sharp(svgPath).resize(size, size).png().toFile(out);
  console.log('wrote', out);
}

// Maskable icon: same art, but with extra padding so it survives circular/
// squircle masking on Android home screens.
const maskableOut = path.join(iconsDir, 'icon-512-maskable.png');
await sharp(svgPath)
  .resize(320, 320)
  .extend({ top: 96, bottom: 96, left: 96, right: 96, background: '#14161a' })
  .png()
  .toFile(maskableOut);
console.log('wrote', maskableOut);
