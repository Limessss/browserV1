/**
 * 从 build/icon.png 生成多尺寸 PNG 与 Windows 多尺寸 icon.ico。
 * 若源图带黑色底，先运行 node scripts/fix-logo-transparency.mjs
 * 用法: node scripts/generate-icons.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import toIco from 'to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'icon.png');
const outDir = path.join(root, 'build', 'icons');
const icoPath = path.join(root, 'build', 'icon.ico');

/** ICO 常用尺寸（升序，与 to-ico 约定一致） */
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(src)) {
    console.error('缺少源文件:', src);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const buffers = [];
  for (const size of sizes) {
    const buf = await sharp(src).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(outDir, `icon-${size}.png`), buf);
    buffers.push(buf);
  }

  const ico = await toIco(buffers);
  fs.writeFileSync(icoPath, ico);

  console.log('已写入:', icoPath);
  console.log('已写入:', outDir, `(${sizes.length} 个 PNG)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
