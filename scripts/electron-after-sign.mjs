/**
 * Windows：在 electron-builder 完成 sign/rcedit 后再写入 ICO，避免路径解析或工具链导致图标未生效。
 * 依赖 npm 包 `rcedit`（内置 rcedit-x64.exe，无需 winCodeSign 解压）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconIco = path.join(root, 'build', 'icon.ico');

export default async function electronAfterSign(context) {
  if (process.platform !== 'win32') {
    return;
  }
  if (context.electronPlatformName !== 'win32') {
    return;
  }
  if (!fs.existsSync(iconIco)) {
    console.warn('[afterSign] 跳过：未找到', iconIco);
    return;
  }

  const name = context.packager.appInfo.productFilename;
  const exe = path.join(context.appOutDir, `${name}.exe`);

  if (!fs.existsSync(exe)) {
    console.warn('[afterSign] 跳过：未找到', exe);
    return;
  }

  await rcedit(exe, { icon: iconIco });
  console.info('[afterSign] 已写入 exe 图标:', exe);
}
