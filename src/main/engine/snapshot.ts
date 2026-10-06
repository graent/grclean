/**
 * 磁盘空间变化分析（design.md §5.3「磁盘空间变化分析」）。
 *
 * 思路：把「各盘已用空间 + 系统盘顶层目录体积」存成快照，
 * 之后任意两次快照对比即可回答「这段时间到底是谁吃掉了我的空间」。
 *
 * 设计要点：
 * - 快照存于 `%LOCALAPPDATA%\GrClean\snapshots\*.json`，纯本地、不上传；
 * - 只记录**体积数字与相对路径**，不记录文件内容，隐私风险低；
 * - 目录层只钻取系统盘顶层（深度 1），一次快照通常在数秒内完成；
 * - 对比结果给出「各盘增减」+「膨胀目录 Top」+「新增目录」，按增量降序。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runPs, parseJsonArray } from './ps'
import { analyzeDirectory } from './treemap'

/** 快照中单个目录的体积记录。 */
export interface SnapshotDir {
  path: string
  bytes: number
}

/** 快照中单个卷的记录。 */
export interface SnapshotVolume {
  letter: string
  totalBytes: number
  freeBytes: number
}

/** 一次完整快照。 */
export interface Snapshot {
  /** 快照 id（文件名去掉扩展名，形如 2026-10-01T041900） */
  id: string
  ts: number
  /** ISO 时间，界面直接展示 */
  time: string
  volumes: SnapshotVolume[]
  dirs: SnapshotDir[]
}

/** 单个卷的对比结果。 */
export interface VolumeDiff {
  letter: string
  usedBefore: number
  usedAfter: number
  /** 正数=占用增加 */
  delta: number
}

/** 单个目录的对比结果。 */
export interface DirDiff {
  path: string
  before: number
  after: number
  delta: number
  /** true=本次快照中新增的目录 */
  isNew: boolean
}

/** 两次快照的完整对比结果。 */
export interface SnapshotDiff {
  base: Snapshot
  target: Snapshot
  volumes: VolumeDiff[]
  dirs: DirDiff[]
  /** 总增量（系统盘顶层目录口径） */
  totalDelta: number
  /** 相隔天数 */
  days: number
}

/** 快照存放目录（独立于清理规则，永远不会被清理逻辑触及）。 */
function snapshotDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'GrClean', 'snapshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 采集所有卷的容量信息。 */
async function collectVolumes(): Promise<SnapshotVolume[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($v in (Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' })) {
  $out += [ordered]@{
    letter = [string]$v.DriveLetter
    totalBytes = [int64]$v.Size
    freeBytes  = [int64]$v.SizeRemaining
  }
}
ConvertTo-Json -Compress $out
`
  try {
    const arr = parseJsonArray(await runPs(ps))
    return arr
      .filter((v: any) => !!v.letter)
      .map((v: any) => ({
        letter: String(v.letter).toUpperCase(),
        totalBytes: Number(v.totalBytes) || 0,
        freeBytes: Number(v.freeBytes) || 0,
      }))
  } catch {
    return []
  }
}

/**
 * 创建一次快照。
 * @param sysRoot 需要钻取的盘根目录（默认系统盘）
 * @param isCancelled 取消回调
 */
export async function takeSnapshot(
  sysRoot?: string,
  isCancelled: () => boolean = () => false,
): Promise<Snapshot> {
  const volumes = await collectVolumes()
  const root = sysRoot || (process.env.SystemDrive || 'C:').replace(/:$/, '') + ':\\'
  let dirs: SnapshotDir[] = []
  try {
    const tree = await analyzeDirectory(root, 1, isCancelled)
    dirs = tree.children.map((c) => ({ path: c.path, bytes: c.size }))
  } catch {
    dirs = []
  }
  const now = new Date()
  const id = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const snap: Snapshot = {
    id,
    ts: now.getTime(),
    time: now.toLocaleString('zh-CN', { hour12: false }),
    volumes,
    dirs: dirs.sort((a, b) => b.bytes - a.bytes),
  }
  try {
    fs.writeFileSync(path.join(snapshotDir(), `${id}.json`), JSON.stringify(snap), 'utf8')
  } catch {
    /* 写入失败不阻断 */
  }
  return snap
}

/** 列出全部快照（按时间倒序，最新在前）。 */
export function listSnapshots(): Snapshot[] {
  try {
    const files = fs.readdirSync(snapshotDir()).filter((f) => f.endsWith('.json'))
    const list: Snapshot[] = []
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(snapshotDir(), f), 'utf8'))
        if (s && typeof s.ts === 'number') list.push(s as Snapshot)
      } catch {
        // 损坏的快照忽略
      }
    }
    return list.sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}

/** 删除一条快照。 */
export function deleteSnapshot(id: string): boolean {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '')
  if (!safe) return false
  try {
    fs.unlinkSync(path.join(snapshotDir(), `${safe}.json`))
    return true
  } catch {
    return false
  }
}

/** 对比两次快照（baseId 为较早的一次，targetId 为较晚的一次）。 */
export function diffSnapshots(baseId: string, targetId: string): SnapshotDiff | null {
  const all = listSnapshots()
  const base = all.find((s) => s.id === baseId)
  const target = all.find((s) => s.id === targetId)
  if (!base || !target) return null

  const volumes: VolumeDiff[] = []
  const letters = new Set([
    ...base.volumes.map((v) => v.letter),
    ...target.volumes.map((v) => v.letter),
  ])
  for (const L of letters) {
    const b = base.volumes.find((v) => v.letter === L)
    const t = target.volumes.find((v) => v.letter === L)
    if (!b || !t) continue
    const usedBefore = b.totalBytes - b.freeBytes
    const usedAfter = t.totalBytes - t.freeBytes
    volumes.push({ letter: L, usedBefore, usedAfter, delta: usedAfter - usedBefore })
  }
  volumes.sort((a, b) => b.delta - a.delta)

  const beforeMap = new Map(base.dirs.map((d) => [d.path, d.bytes]))
  const afterMap = new Map(target.dirs.map((d) => [d.path, d.bytes]))
  const dirs: DirDiff[] = []
  for (const [p, after] of afterMap) {
    const before = beforeMap.get(p)
    dirs.push({
      path: p,
      before: before ?? 0,
      after,
      delta: after - (before ?? 0),
      isNew: before === undefined,
    })
  }
  dirs.sort((a, b) => b.delta - a.delta)

  const days = Math.max(0, Math.round((target.ts - base.ts) / 86400000))
  return {
    base,
    target,
    volumes,
    dirs,
    totalDelta: dirs.reduce((s, d) => s + d.delta, 0),
    days,
  }
}
