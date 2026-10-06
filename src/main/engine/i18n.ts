import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  BUILTIN_PACKS,
  FALLBACK_LOCALE,
  FORCE_UPDATE,
  type BuiltinPack,
} from './i18n-packs'

/**
 * 多语言支持：语言包即 JSON 文件，位于 `%LOCALAPPDATA%/GrClean/i18n`。
 *
 * 设计要点：
 * - 目录即真相：每次 list/get 都重新读盘，所以运行中**新增 / 修改 / 删除**包文件都能立即生效（热增减）。
 * - 首次运行播种内置包（zh-CN / en-US / zh-TW）；已存在的文件绝不覆盖，保证用户手工改的包不被还原。
 * - 解析失败的文件跳过并在控制台告警，不影响其它包。
 * - 文件名即语言代码（`en-US.json` → `en-US`），包内 `meta` 用于展示名称，缺失时退化为代码+文件名。
 */

/** 语言包目录（不存在时自动创建）。 */
export function i18nDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean', 'i18n')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 首次运行时把内置包写入目录；已存在的旧版本包做「合并升级」（仅补缺失 key，不覆盖用户改动）。 */
export function seedBuiltinPacks(): void {
  const dir = i18nDir()
  for (const [code, pack] of Object.entries(BUILTIN_PACKS)) {
    const file = path.join(dir, `${code}.json`)
    try {
      if (fs.existsSync(file)) {
        mergeUpgrade(file, code, pack)
      } else {
        // 缩进 2 空格，便于用户直接编辑扩展
        fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8')
      }
    } catch (e) {
      console.warn(`[GrClean] Failed to seed i18n pack ${file}:`, e)
    }
  }
}

/**
 * 旧版本包升级：当内置包 version 高于磁盘文件时，
 * 只把磁盘上缺失的 key 补进去（磁盘已有值不动，用户手工翻译保留），并同步 meta.version。
 */
function mergeUpgrade(file: string, code: string, builtin: BuiltinPack): void {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  let parsed: BuiltinPack
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as BuiltinPack
  } catch {
    return // 用户文件解析失败时不碰它
  }
  const diskVersion = typeof parsed.meta?.version === 'number' ? parsed.meta.version : 0
  if (diskVersion >= builtin.meta.version) return
  const messages = parsed.messages ?? {}
  let added = 0
  for (const [k, v] of Object.entries(builtin.messages)) {
    if (!(k in messages)) {
      messages[k] = v
      added++
    }
  }
  // 强制更新名单：改名类调整需要覆盖磁盘旧值（仅升级时执行一次）
  let forced = 0
  for (const [composite, v] of Object.entries(FORCE_UPDATE)) {
    const idx = composite.indexOf(':')
    if (composite.slice(0, idx) !== code) continue
    const k = composite.slice(idx + 1)
    if (messages[k] !== v) {
      messages[k] = v
      forced++
    }
  }
  parsed.meta = { ...builtin.meta, ...(parsed.meta ?? {}), version: builtin.meta.version }
  parsed.messages = messages
  try {
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8')
    console.log(
      `[GrClean] i18n pack ${code} upgraded to v${builtin.meta.version} (+${added} keys, ${forced} forced)`,
    )
  } catch (e) {
    console.warn(`[GrClean] Failed to upgrade i18n pack ${file}:`, e)
  }
}

/** 语言包摘要（设置页下拉用）。 */
export interface LocaleMeta {
  /** 语言代码，同时也是文件名（不含扩展名）。 */
  code: string
  /** 展示名称（优先 meta.name，其次 meta.nativeName，最后代码）。 */
  name: string
  /** 本族语言名称（下拉副标题用）。 */
  nativeName: string
  /** 是否为内置播种包（用户删除后重新播种才会出现）。 */
  builtin: boolean
  /** 词条数量。 */
  count: number
  /** 文件绝对路径（用于打开目录定位）。 */
  file: string
}

/** 读取目录内全部语言包摘要（每次调用都重新读盘 → 支持热增减）。 */
export function listLocales(): LocaleMeta[] {
  seedBuiltinPacks()
  const dir = i18nDir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: LocaleMeta[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(dir, entry.name)
    const code = entry.name.slice(0, -5)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    try {
      // 容忍 UTF-8 BOM
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as {
        meta?: Record<string, unknown>
        messages?: Record<string, unknown>
      }
      const messages = parsed.messages ?? {}
      const meta = parsed.meta ?? {}
      const name = str(meta.name) || str(meta.nativeName) || code
      out.push({
        code,
        name,
        nativeName: str(meta.nativeName) || name,
        builtin: Object.prototype.hasOwnProperty.call(BUILTIN_PACKS, code),
        count: Object.keys(messages).length,
        file,
      })
    } catch (e) {
      console.warn(`[GrClean] Skipped invalid i18n pack ${file}:`, e)
    }
  }
  // 基准包排最前，其余按名称排序，保证下拉顺序稳定
  out.sort((a, b) => {
    if (a.code === FALLBACK_LOCALE) return -1
    if (b.code === FALLBACK_LOCALE) return 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** 读取指定语言的词条表；不存在或解析失败返回空表（渲染层会回退）。 */
export function getMessages(code: string): Record<string, string> {
  const dir = i18nDir()
  const safe = sanitizeCode(code)
  if (!safe) return {}
  const file = path.join(dir, `${safe}.json`)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { messages?: Record<string, unknown> }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.messages ?? {})) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch (e) {
    console.warn(`[GrClean] Failed to parse i18n pack ${file}:`, e)
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v : ''
}

/** 语言代码净化：仅允许字母数字/下划线/连字符，避免路径穿越。 */
function sanitizeCode(code: string): string {
  const c = (code ?? '').trim()
  if (!c) return ''
  if (!/^[a-zA-Z0-9_-]+$/.test(c)) return ''
  // 拒绝纯点号等异常形式
  if (c === '.' || c === '..') return ''
  return c
}
