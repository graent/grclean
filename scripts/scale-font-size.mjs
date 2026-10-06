/**
 * 一次性脚本：把渲染层所有 `font-size: <n>px` 改写为 `calc(<n>px * var(--fs-scale))`，
 * 让「设置 → 字体大小」能全局缩放界面文字（只缩放文字，不动 padding/宽高等布局尺寸）。
 *
 * 已包含 calc( / var( / em / rem / inherit 的声明会跳过，避免重复包裹。
 * 用法：node scripts/scale-font-size.mjs [--dry]
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'src', 'renderer', 'src')
const dry = process.argv.includes('--dry')

const RE = /font-size:\s*(\d+(?:\.\d+)?)px/gi

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|css)$/i.test(e.name)) out.push(p)
  }
  return out
}

let files = 0
let hits = 0
for (const file of walk(target)) {
  const src = fs.readFileSync(file, 'utf8')
  let changed = false
  const next = src.replace(RE, (m, num) => {
    // 同一声明行里若已出现 calc(/var( 说明已处理过，跳过
    if (/calc\(|var\(/i.test(m)) return m
    changed = true
    hits++
    return `font-size: calc(${num}px * var(--fs-scale))`
  })
  if (changed) {
    files++
    if (!dry) fs.writeFileSync(file, next, 'utf8')
    console.log(`${path.relative(root, file)}`)
  }
}
console.log(`\n改写文件 ${files} 个，声明 ${hits} 处${dry ? '（dry-run，未写入）' : ''}`)
