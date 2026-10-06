import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * 扫描记录持久化（JSON 文件，非 SQLite）。
 *
 * 与现有 `audit.jsonl` / 快照一致，全部落在 `%LOCALAPPDATA%/GrClean`，
 * 不引入额外依赖。每个模块只保留「最近一次」记录（时间 + 结果摘要）。
 * 用户再次体检 / 扫描时覆盖更新；界面在扫描按钮附近展示。
 */

/** 一条扫描记录。 */
export interface ScanRecord {
  /** 模块 key，如 junk / social / health */
  module: string
  /** 扫描完成时间戳（ms） */
  scannedAt: number
  /** 结果摘要（人类可读，如「2.3 GB · 1,204 项」） */
  summary: string
}

/** GrClean 数据目录：`%LOCALAPPDATA%/GrClean`（独立于所有清理规则，不可被触及）。 */
export function grcleanDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 扫描记录路径：`%LOCALAPPDATA%/GrClean/history.json` */
function historyPath(): string {
  return path.join(grcleanDir(), 'history.json')
}

function loadAll(): Record<string, ScanRecord> {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf8')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as Record<string, ScanRecord>) : {}
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, ScanRecord>): void {
  try {
    fs.writeFileSync(historyPath(), JSON.stringify(map, null, 2), 'utf8')
  } catch {
    /* 写入失败不阻断主流程 */
  }
}

/** 读取某模块最近一次扫描记录；无则返回 null。 */
export function getScanRecord(module: string): ScanRecord | null {
  const rec = loadAll()[module]
  return rec ?? null
}

/** 写入（覆盖）某模块的最近一次扫描记录，返回该记录。 */
export function recordScan(module: string, summary: string): ScanRecord {
  const map = loadAll()
  const rec: ScanRecord = { module, scannedAt: Date.now(), summary }
  map[module] = rec
  saveAll(map)
  return rec
}
