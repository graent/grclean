import fs from 'fs'
import os from 'os'
import path from 'path'

/** 内置垃圾清理规则。 */
export interface JunkRule {
  id: string
  name: string
  category: string
  description: string
  /** 待扫描根目录（绝对路径） */
  dirs: string[]
  /** 仅清理修改时间超过该天数的文件 */
  max_age_days: number
  /** 是否递归子目录 */
  recursive: boolean
}

/** 一条用户自定义规则（对应前端 UserRuleInput）。 */
export interface UserRule {
  id: string
  name: string
  category: string
  description: string
  enabled: boolean
  /** glob 模式列表，支持 `%ENV%` 环境变量与 `~` 展开 */
  paths: string[]
  /** 仅清理修改时间超过该天数的文件（0 表示不限制） */
  max_age_days: number
  /** 仅清理体积 ≥ 该值(KB) 的文件（0 表示不限制） */
  min_size_kb: number
}

/** 内置规则集合（MVP 仅覆盖用户空间，避开采系统目录需管理员权限的坑）。 */
export function builtinJunkRules(): JunkRule[] {
  const rules: JunkRule[] = []

  // 用户临时目录（%TEMP%）
  rules.push({
    id: 'user_temp',
    name: '用户临时文件',
    category: '临时文件',
    description: '清理用户临时目录中超过 7 天的文件',
    dirs: [os.tmpdir()],
    max_age_days: 7,
    recursive: true,
  })

  // 浏览器缓存（位于 %LOCALAPPDATA% 下，非受保护区域）
  const local = process.env.LOCALAPPDATA
  if (local) {
    rules.push({
      id: 'edge_cache',
      name: 'Edge 缓存',
      category: '浏览器缓存',
      description: '清理 Microsoft Edge 浏览器缓存',
      dirs: [path.join(local, 'Microsoft/Edge/User Data/Default/Cache')],
      max_age_days: 7,
      recursive: true,
    })
    rules.push({
      id: 'chrome_cache',
      name: 'Chrome 缓存',
      category: '浏览器缓存',
      description: '清理 Google Chrome 浏览器缓存',
      dirs: [path.join(local, 'Google/Chrome/User Data/Default/Cache')],
      max_age_days: 7,
      recursive: true,
    })
    rules.push({
      id: 'firefox_cache',
      name: 'Firefox 缓存',
      category: '浏览器缓存',
      description: '清理 Firefox 浏览器缓存',
      dirs: [path.join(local, 'Mozilla/Firefox/Profiles')],
      max_age_days: 7,
      recursive: true,
    })
  }

  return rules
}

/** 用户规则目录（不存在时自动创建）。 */
export function rulesDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean', 'rules')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 加载所有用户规则（容错：跳过非法 JSON、空 id、无 paths 的文件）。 */
export function loadUserRules(): UserRule[] {
  const dir = rulesDir()
  const out: UserRule[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(dir, entry.name)
    let content: string
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    try {
      const r = JSON.parse(content) as UserRule
      if (!r.id || !r.id.trim() || !r.paths || r.paths.length === 0) {
        console.warn(`[GrClean] 跳过规则 ${file}：缺少 id 或 paths`)
        continue
      }
      out.push({
        id: r.id,
        name: r.name ?? '',
        category: r.category ?? '',
        description: r.description ?? '',
        enabled: r.enabled !== false,
        paths: r.paths,
        max_age_days: r.max_age_days ?? 0,
        min_size_kb: r.min_size_kb ?? 0,
      })
    } catch (e) {
      console.warn(`[GrClean] 跳过无效规则文件 ${file}:`, e)
    }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  return out
}

/** 保存一条用户规则到 `rules/<id>.json`（pretty 格式）。 */
export function saveUserRule(rule: UserRule): string {
  if (!rule.id || !rule.id.trim()) throw new Error('规则 id 不能为空')
  if (!rule.paths || rule.paths.length === 0) throw new Error('至少需要一个 path 匹配模式')
  const dir = rulesDir()
  const file = path.join(dir, `${sanitizeFilename(rule.id)}.json`)
  fs.writeFileSync(file, JSON.stringify(rule, null, 2), 'utf8')
  return file
}

/** 删除一条用户规则（按 id 定位文件）。 */
export function deleteUserRule(id: string): void {
  const dir = rulesDir()
  const file = path.join(dir, `${sanitizeFilename(id)}.json`)
  if (fs.existsSync(file)) {
    fs.unlinkSync(file)
  } else {
    throw new Error('未找到该规则文件')
  }
}

/** 展开路径中的 `%ENV%` 环境变量与 `~`（用户主目录）。 */
export function expandEnv(s: string): string {
  let result = s
  for (const [k, v] of Object.entries(process.env)) {
    if (v) result = result.replace(new RegExp(`%${k}%`, 'g'), v)
  }
  const home = os.homedir()
  if (home) result = result.replace(/^~\//, home + '/').replace(/^~/, home)
  return result
}

/** 文件名净化：仅保留字母数字/下划线/连字符，其余替换为下划线，避免路径穿越。 */
function sanitizeFilename(name: string): string {
  return name
    .split('')
    .map((c) => (c.match(/[a-zA-Z0-9_-]/) ? c : '_'))
    .join('')
}
