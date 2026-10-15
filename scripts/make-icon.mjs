// build/icon.svg dosyasından icon.png (512) ve çok boyutlu icon.ico üretir.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'));
await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(path.join(root, 'build', 'icon.png'));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), await (pngToIco.default || pngToIco)(pngs));
console.log('icon.png ve icon.ico oluşturuldu');
