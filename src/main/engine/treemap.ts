/**
 * 大目录钻取分析（design.md §5.3「大目录钻取分析」）。
 *
 * 逐层下钻定位空间大户：给定根目录，广度优先聚合每个子目录的体积，
 * 产出可直接渲染成矩形树图（treemap）的树结构。
 *
 * 设计要点：
 * - **只统计不删除**，读操作，安全；
 * - 跳过符号链接 / 目录联接，避免环与重复计数（例如迁移产生的 junction）；
 * - 单目录读取失败（权限不足、被占用）静默跳过，不影响整体；
 * - 支持**取消**（`isCancelled`）与**进度回调**，扫描 C 盘这种大目录时界面不卡死；
 * - 目录数量设上限（`MAX_DIRS`），防止极端情况无限递归。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface TreeNode {
  path: string
  name: string
  /** 含子目录的总体积（字节） */
  size: number
  /** 直接子文件数 */
  fileCount: number
  /** 直接子目录数 */
  dirCount: number
  children: TreeNode[]
}

export interface AnalyzeProgress {
  dirs: number
  files: number
  bytes: number
  current: string
}

/** 单次分析最多遍历的目录数（防止超大卷无限扫描）。 */
const MAX_DIRS = 30000

/** 界面可选的起始根目录（用户目录 + 各固定盘根目录）。 */
export function defaultRoots(): Array<{ label: string; path: string }> {
  const home = os.homedir()
  const list: Array<{ label: string; path: string }> = [
    { label: '用户主目录', path: home },
    { label: '桌面', path: path.join(home, 'Desktop') },
    { label: '下载', path: path.join(home, 'Downloads') },
    { label: '文档', path: path.join(home, 'Documents') },
    { label: '图片', path: path.join(home, 'Pictures') },
    { label: '视频', path: path.join(home, 'Videos') },
    { label: '本地应用数据', path: path.join(home, 'AppData', 'Local') },
    { label: '漫游应用数据', path: path.join(home, 'AppData', 'Roaming') },
  ]
  const sysDrive = (process.env.SystemDrive || 'C:').replace(/:$/, '') + ':\\'
  list.push({ label: `系统盘 ${sysDrive}`, path: sysDrive })
  // 其它固定盘（用盘符存在性判断，跨平台安全）
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    const root = `${letter}:\\`
    if (root === sysDrive) continue
    try {
      if (fs.existsSync(root)) list.push({ label: `盘 ${root}`, path: root })
    } catch {
      // 忽略不可访问盘符（如光驱弹片）
    }
  }
  return list.filter((r) => {
    try {
      return fs.statSync(r.path).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 分析目录树体积。
 *
 * @param root 起始目录
 * @param maxDepth 下钻层数（1 = 只看一级子目录）
 * @param isCancelled 取消回调（由主进程 appState.cancel 驱动）
 * @param onProgress 进度回调（每 50 个目录回传一次）
 */
export async function analyzeDirectory(
  root: string,
  maxDepth: number,
  isCancelled: () => boolean,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<TreeNode> {
  const depth = Math.max(1, Math.min(6, Math.floor(maxDepth)))
  const rootPath = path.resolve(root)

  let dirs = 0
  let files = 0
  let bytes = 0

  async function walk(dir: string, currentDepth: number): Promise<TreeNode> {
    if (isCancelled()) return mk(dir, 0, 0, 0, [])
    if (dirs++ >= MAX_DIRS) return mk(dir, 0, 0, 0, [])
    if (dirs % 50 === 0) {
      onProgress?.({ dirs, files, bytes, current: dir })
    }

    let fileSize = 0
    let fileCount = 0
    const subDirs: string[] = []
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          subDirs.push(full)
        } else if (e.isFile()) {
          fileCount++
          try {
            const st = await fs.promises.stat(full)
            fileSize += st.size
          } catch {
            // 单文件 stat 失败忽略
          }
        }
      }
    } catch {
      return mk(dir, 0, 0, 0, [])
    }

    files += fileCount
    bytes += fileSize

    if (currentDepth >= depth) {
      return mk(dir, fileSize, fileCount, subDirs.length, [])
    }

    const children: TreeNode[] = []
    for (const sd of subDirs) {
      if (isCancelled()) break
      children.push(await walk(sd, currentDepth + 1))
    }
    const total = fileSize + children.reduce((s, c) => s + c.size, 0)
    // 体积降序，界面树图直接按顺序取前 N 即可
    children.sort((a, b) => b.size - a.size)
    return mk(dir, total, fileCount, subDirs.length, children)
  }

  return walk(rootPath, 1)
}

function mk(p: string, size: number, fileCount: number, dirCount: number, children: TreeNode[]): TreeNode {
  return {
    path: p,
    name: path.basename(p) || p,
    size,
    fileCount,
    dirCount,
    children,
  }
}
