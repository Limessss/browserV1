/**
 * 去除 logo/icon PNG 的黑色背景，转为透明通道。
 * 用法: node scripts/fix-logo-transparency.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const targets = [
  path.join(root, 'frontend', 'src', 'resources', 'images', 'logo.png'),
  path.join(root, 'build', 'icon.png'),
]

async function removeBlackBackground(inputPath) {
  if (!fs.existsSync(inputPath)) {
    console.warn('跳过（文件不存在）:', inputPath)
    return
  }

  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const threshold = 30
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (r <= threshold && g <= threshold && b <= threshold) {
      data[i + 3] = 0
    }
  }

  const tmpPath = inputPath + '.tmp.png'
  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toFile(tmpPath)

  fs.renameSync(tmpPath, inputPath)
  console.log('已修复:', inputPath, `(${info.width}x${info.height})`)
}

for (const target of targets) {
  await removeBlackBackground(target)
}
