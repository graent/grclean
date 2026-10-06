import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import {
  type CleanResult,
  type ScheduleConfig,
  type PrivacyRuleOption,
} from './model'
import { builtinJunkRules, loadUserRules } from './rules'
import { scanJunkStream } from './junk'
import { deleteCandidates } from './delete'

const execFileAsync = promisify(execFile)

/** 计划配置目录（不存在时自动创建）。 */
export function schedulesDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean', 'schedules')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 文件名/任务名净化：仅保留字母数字/下划线/连字符，避免路径穿越与命令注入。 */
function sanitize(name: string): string {
  return name
    .split('')
    .map((c) => (c.match(/[a-zA-Z0-9_-]/) ? c : '_'))
    .join('')
}

/** Windows 计划任务名（全局唯一）。 */
function taskName(id: string): string {
  return `GrCleanPrivacy_${sanitize(id)}`
}

/** 校验 "HH:MM"（24 小时制），非法返回 false。 */
function validTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
}

/** 列出全部计划（容错跳过非法 JSON）。 */
export function listSchedules(): ScheduleConfig[] {
  const dir = schedulesDir()
  const out: ScheduleConfig[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(dir, entry.name), 'utf8'),
      ) as ScheduleConfig
      if (!cfg.id) continue
      out.push({
        id: cfg.id,
        name: cfg.name ?? '',
        frequency: cfg.frequency === 'weekly' ? 'weekly' : 'daily',
        time: validTime(cfg.time) ? cfg.time : '09:00',
        rule_ids: Array.isArray(cfg.rule_ids) ? cfg.rule_ids : [],
        enabled: cfg.enabled !== false,
      })
    } catch {
      /* 跳过无效文件 */
    }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  return out
}

/** 按 id 加载计划配置。 */
export function loadSchedule(id: string): ScheduleConfig | null {
  const file = path.join(schedulesDir(), `${sanitize(id)}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ScheduleConfig
  } catch {
    return null
  }
}

function saveSchedule(cfg: ScheduleConfig): void {
  const file = path.join(schedulesDir(), `${sanitize(cfg.id)}.json`)
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8')
}

function deleteScheduleFile(id: string): void {
  const file = path.join(schedulesDir(), `${sanitize(id)}.json`)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

/**
 * 解码 Windows 控制台输出：schtasks 在中文环境下输出 GBK，直接按 UTF-8 解会乱码；
 * 先按 UTF-8 解，出现替换字符时回退到 GBK（Node 内置完整 ICU，零依赖）。
 */
function decodeConsole(buf: Buffer): string {
  const asUtf8 = buf.toString('utf8').replace(/^﻿/, '')
  if (asUtf8.includes('�')) {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return asUtf8
    }
  }
  return asUtf8
}

/**
 * 通过 `schtasks` 注册 Windows 计划任务。
 *
 * 到点时启动 `<exe> --privacy-clean --schedule-id <id>`，应用以无界面模式
 * 执行清理后自动退出（见 main/index.ts 的命令行参数处理）。
 *
 * 引号陷阱：`/tr` 的可执行文件路径含空格，必须作为**单个 token** 传给 schtasks。
 * 这里刻意**不设** `windowsVerbatimArguments`——一旦设为 true，参数会原样拼进
 * 命令行，`"C:\a b\app.exe" --flags` 会被拆成多个 token，导致 `--flags` 被当作
 * 未知开关而失败。保持 Node 默认转义时，该参数会被引号包裹为
 * `"\"C:\a b\app.exe\" --flags"`，经 CommandLineToArgvW 解析后正好还原成
 * 带引号的完整命令，即 schtasks 期望的形式。
 */
async function createWindowsTask(cfg: ScheduleConfig): Promise<void> {
  const exe = app.getPath('exe')
  const tr = `"${exe}" --privacy-clean --schedule-id ${sanitize(cfg.id)}`

  const args = ['/create', '/tn', taskName(cfg.id), '/tr', tr, '/f']
  if (cfg.frequency === 'weekly') {
    args.push('/sc', 'weekly', '/d', 'MON', '/st', cfg.time)
  } else {
    args.push('/sc', 'daily', '/st', cfg.time)
  }

  try {
    await execFileAsync('schtasks', args, {
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    })
  } catch (e) {
    // 失败时附带 schtasks 自身输出（GBK 已解码），便于定位是否为权限问题
    const err = e as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer }
    const detail = decodeConsole(
      Buffer.concat([
        Buffer.from(err.stdout ?? Buffer.alloc(0)),
        Buffer.from(err.stderr ?? Buffer.alloc(0)),
      ]),
    ).trim()
    throw new Error(
      `创建系统计划任务失败（可能需要管理员权限）${detail ? `：${detail}` : ''}`,
    )
  }
}

/** 删除 Windows 计划任务（尽最大努力，失败不影响配置清理）。 */
async function removeWindowsTask(id: string): Promise<void> {
  try {
    await execFileAsync('schtasks', ['/delete', '/tn', taskName(id), '/f'], {
      windowsHide: true,
      encoding: 'buffer',
      timeout: 30000,
    })
  } catch {
    /* 任务可能本就不存在 */
  }
}

/**
 * 新增计划：先注册系统任务，成功后再落盘配置，保证两者状态一致；
 * 配置落盘失败则回滚已注册的系统任务，避免留下孤儿任务。
 */
export async function addSchedule(cfg: ScheduleConfig): Promise<ScheduleConfig> {
  if (!cfg.id || !cfg.id.trim()) throw new Error('计划 id 不能为空')
  if (!cfg.name || !cfg.name.trim()) throw new Error('计划名称不能为空')
  if (!validTime(cfg.time)) throw new Error('时间格式应为 HH:MM（24 小时制）')

  const normalized: ScheduleConfig = {
    id: sanitize(cfg.id),
    name: cfg.name.trim(),
    frequency: cfg.frequency === 'weekly' ? 'weekly' : 'daily',
    time: cfg.time,
    rule_ids: Array.isArray(cfg.rule_ids) ? cfg.rule_ids : [],
    enabled: true,
  }

  await createWindowsTask(normalized)
  try {
    saveSchedule(normalized)
  } catch (e) {
    await removeWindowsTask(normalized.id)
    throw e
  }
  return normalized
}

/** 删除计划：删除配置文件 + 移除系统任务。 */
export async function removeSchedule(id: string): Promise<void> {
  deleteScheduleFile(id)
  await removeWindowsTask(id)
}

/** 可勾选的清理范围（内置规则 + 用户自定义规则）。 */
export function privacyRuleOptions(): PrivacyRuleOption[] {
  const opts: PrivacyRuleOption[] = builtinJunkRules().map((r) => ({
    id: r.id,
    name: r.name,
  }))
  for (const r of loadUserRules()) {
    opts.push({ id: r.id, name: r.name })
  }
  return opts
}

/**
 * 执行隐私清理（无界面）：按规则扫描 → 移入回收站 → 审计。
 *
 * 被「立即运行」按钮与系统计划任务启动时复用；复用垃圾清理的七道防线，
 * 默认仅移入回收站、绝不永久删除，受保护路径一律拦截。
 */
export async function runPrivacyCleanup(ruleIds: string[]): Promise<CleanResult> {
  const cands: import('./model').CleanCandidate[] = []
  for await (const batch of scanJunkStream({ ruleIds }, () => false)) {
    cands.push(...batch)
  }
  const map = new Map(cands.map((c) => [c.id, c]))
  return deleteCandidates(map, null, false)
}

/** 供无界面模式调用：按 schedule_id 加载配置后执行。 */
export async function runPrivacyCleanupBySchedule(
  scheduleId: string | null,
): Promise<CleanResult> {
  const cfg = scheduleId ? loadSchedule(scheduleId) : null
  return runPrivacyCleanup(cfg?.rule_ids ?? [])
}
