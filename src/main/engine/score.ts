/**
 * 电脑健康度评分引擎（design.md §4）。
 *
 * 综合 11 项因素，满分 100，输出等级与动态建议。纯函数、无 Node 依赖，便于单测。
 * 权重严格对齐 §4.1：剩余空间 28 / 容量 5 / 垃圾 12 / 重复 8 / 社交缓存 8 /
 * 注册表 4 / 启动项 7 / 磁盘健康 11 / 文件系统对齐 7 / 更新积压 5 / 可释放系统文件 5。
 */

const GB = 1024 ** 3

export type DiskType = 'SSD' | 'HDD' | 'Unknown'

export interface HealthSnapshot {
  /** 系统盘剩余字节 */
  systemFreeBytes: number
  /** 系统盘总字节 */
  systemTotalBytes: number
  /** 垃圾文件体积（字节） */
  junkBytes: number
  /** 重复文件可释放体积（字节） */
  dupBytes: number
  /** 社交缓存体积（字节，best-effort） */
  socialBytes: number
  /** 注册表冗余项数量 */
  registryCount: number
  /** 启动项数量 */
  startupCount: number
  diskType: DiskType
  /** SSD 是否开启 Trim；HDD / 未知为 null */
  trimEnabled: boolean | null
  /** SMART 健康；未知为 null */
  smartOk: boolean | null
  /** 4K 是否对齐；未知为 null */
  aligned: boolean | null
  /** 文件系统，如 NTFS */
  fileSystem: string
  /** 更新 / 临时文件积压（字节） */
  updateBacklogBytes: number
  /** 可释放系统文件（休眠 / 旧 Windows，字节） */
  releasableSystemBytes: number
}

export interface FactorResult {
  key: string
  label: string
  weight: number
  score: number
  max: number
  detail: string
}

export interface ScoreResult {
  score: number
  level: string
  factors: FactorResult[]
  suggestions: string[]
}

/** 等级与对应配色（对齐 §4 仪表盘图例：优秀绿 / 良好蓝 / 一般黄 / 较差橙 / 危险红）。 */
export interface LevelInfo {
  label: string
  color: string
}

export function levelOf(score: number): LevelInfo {
  if (score >= 85) return { label: '优秀', color: '#3a9d3a' }
  if (score >= 70) return { label: '良好', color: '#5a9bd4' }
  if (score >= 50) return { label: '一般', color: '#e6c200' }
  if (score >= 30) return { label: '较差', color: '#e08a2b' }
  return { label: '危险', color: '#d33333' }
}

function fmtGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

/** 越大越好：v≥fullAt 满分，v≤zeroAt 0 分，中间线性。 */
function largerBetter(v: number, fullAt: number, zeroAt: number, max: number): number {
  if (v >= fullAt) return max
  if (v <= zeroAt) return 0
  return Math.round((max * (v - zeroAt)) / (fullAt - zeroAt))
}

/** 越小越好：v≤fullAt 满分，v≥zeroAt 0 分，中间线性。 */
function smallerBetter(v: number, fullAt: number, zeroAt: number, max: number): number {
  if (v <= fullAt) return max
  if (v >= zeroAt) return 0
  return Math.round((max * (zeroAt - v)) / (zeroAt - fullAt))
}

export function computeScore(s: HealthSnapshot): ScoreResult {
  const factors: FactorResult[] = []

  // 1. 系统盘剩余空间 28（百分比与绝对值取较差者）
  const freeGB = s.systemFreeBytes / GB
  const totalGB = s.systemTotalBytes / GB
  const pct = totalGB > 0 ? (s.systemFreeBytes / s.systemTotalBytes) * 100 : 0
  const freeScore = Math.min(
    largerBetter(pct, 30, 10, 28),
    largerBetter(freeGB, 20, 5, 28),
  )
  factors.push({
    key: 'free',
    label: '系统盘剩余空间',
    weight: 28,
    score: freeScore,
    max: 28,
    detail: `剩余 ${freeGB.toFixed(1)} GB（${pct.toFixed(0)}%）`,
  })

  // 2. 系统盘总容量 5
  factors.push({
    key: 'cap',
    label: '系统盘总容量',
    weight: 5,
    score: largerBetter(totalGB, 120, 64, 5),
    max: 5,
    detail: `${totalGB.toFixed(0)} GB`,
  })

  // 3. 垃圾文件体积 12
  factors.push({
    key: 'junk',
    label: '垃圾文件体积',
    weight: 12,
    score: smallerBetter(s.junkBytes, 1 * GB, 15 * GB, 12),
    max: 12,
    detail: fmtGB(s.junkBytes),
  })

  // 4. 重复文件体积 8
  factors.push({
    key: 'dup',
    label: '重复文件体积',
    weight: 8,
    score: smallerBetter(s.dupBytes, 0.5 * GB, 10 * GB, 8),
    max: 8,
    detail: fmtGB(s.dupBytes),
  })

  // 5. 社交缓存体积 8
  factors.push({
    key: 'social',
    label: '社交缓存体积',
    weight: 8,
    score: smallerBetter(s.socialBytes, 1 * GB, 15 * GB, 8),
    max: 8,
    detail: fmtGB(s.socialBytes),
  })

  // 6. 注册表冗余项 4
  factors.push({
    key: 'reg',
    label: '注册表冗余项',
    weight: 4,
    score: smallerBetter(s.registryCount, 50, 500, 4),
    max: 4,
    detail: `${s.registryCount} 项`,
  })

  // 7. 启动项数量 7
  factors.push({
    key: 'startup',
    label: '启动项数量',
    weight: 7,
    score: smallerBetter(s.startupCount, 5, 20, 7),
    max: 7,
    detail: `${s.startupCount} 个`,
  })

  // 8. 磁盘健康（Trim / SMART）11
  let diskHealthScore = 11
  let diskHealthDetail = '正常'
  if (s.diskType === 'SSD') {
    if (s.trimEnabled === false) {
      diskHealthScore = 6
      diskHealthDetail = 'SSD 未开启 Trim'
    } else if (s.trimEnabled === true) {
      diskHealthDetail = 'SSD · Trim 已开启'
    }
  } else if (s.diskType === 'HDD') {
    diskHealthDetail = 'HDD · 建议定期碎片整理'
  }
  if (s.smartOk === false) {
    diskHealthScore = 0
    diskHealthDetail = 'SMART 告警'
  } else if (s.smartOk === true) {
    diskHealthDetail += ' · SMART 正常'
  }
  if (s.diskType === 'Unknown') {
    diskHealthScore = 9
    diskHealthDetail = '健康（详情未知）'
  }
  factors.push({
    key: 'disk',
    label: '磁盘健康（Trim/SMART）',
    weight: 11,
    score: diskHealthScore,
    max: 11,
    detail: diskHealthDetail,
  })

  // 9. 文件系统与 4K 对齐 7
  let fsScore = 5
  let fsDetail = s.fileSystem || '未知'
  if (s.fileSystem === 'NTFS') {
    if (s.aligned === true) {
      fsScore = 7
      fsDetail = 'NTFS · 已 4K 对齐'
    } else if (s.aligned === false) {
      fsScore = 4
      fsDetail = 'NTFS · 未 4K 对齐'
    } else {
      fsScore = 6
      fsDetail = 'NTFS'
    }
  } else if (s.fileSystem) {
    fsScore = 2
    fsDetail = `${s.fileSystem}（非 NTFS）`
  }
  factors.push({
    key: 'fs',
    label: '文件系统与 4K 对齐',
    weight: 7,
    score: fsScore,
    max: 7,
    detail: fsDetail,
  })

  // 10. 更新 / 临时文件积压 5
  factors.push({
    key: 'upd',
    label: '更新/临时文件积压',
    weight: 5,
    score: smallerBetter(s.updateBacklogBytes, 2 * GB, 10 * GB, 5),
    max: 5,
    detail: fmtGB(s.updateBacklogBytes),
  })

  // 11. 可释放系统文件（休眠 / 旧 Windows）5
  factors.push({
    key: 'rel',
    label: '可释放系统文件（休眠/旧Win）',
    weight: 5,
    score: smallerBetter(s.releasableSystemBytes, 1 * GB, 20 * GB, 5),
    max: 5,
    detail: fmtGB(s.releasableSystemBytes),
  })

  const score = factors.reduce((a, f) => a + f.score, 0)
  const level = levelOf(score)
  const suggestions = buildSuggestions(s, factors)
  return { score, level: level.label, factors, suggestions }
}

/** 根据低位因素生成针对性建议（§4.3 动态建议，非笼统提示）。 */
function buildSuggestions(s: HealthSnapshot, factors: FactorResult[]): string[] {
  const out: string[] = []
  const low = (key: string) => {
    const f = factors.find((x) => x.key === key)
    return !!f && f.score < f.max * 0.7
  }
  if (low('free'))
    out.push(
      `系统盘剩余空间紧张（${fmtGB(s.systemFreeBytes)}），建议清理大文件或将社交缓存迁移到非系统盘。`,
    )
  if (low('junk'))
    out.push(`垃圾文件达 ${fmtGB(s.junkBytes)}，建议执行「垃圾清理」释放空间。`)
  if (low('dup'))
    out.push(`重复文件占用 ${fmtGB(s.dupBytes)}，建议清理重复项（每组保留最新一份）。`)
  if (low('social'))
    out.push(
      `社交缓存达 ${fmtGB(s.socialBytes)}，建议清理图片/视频类（聊天记录数据库已锁死不可删）。`,
    )
  if (low('reg'))
    out.push(`注册表冗余 ${s.registryCount} 项，建议执行「注册表清理」（删除前自动备份）。`)
  if (low('startup'))
    out.push(`启动项 ${s.startupCount} 个偏多，建议禁用非必要项以加快开机。`)
  if (low('disk'))
    out.push(
      `磁盘健康异常（${s.diskType}${s.trimEnabled === false ? ' · Trim 未开启' : ''}），建议备份数据并检查 SMART。`,
    )
  if (low('upd'))
    out.push(`更新/临时文件积压 ${fmtGB(s.updateBacklogBytes)}，建议清理「Windows 更新缓存 / 传递优化」。`)
  if (low('rel'))
    out.push(
      `存在可释放系统文件 ${fmtGB(s.releasableSystemBytes)}（休眠/旧 Windows），确认无需回退后建议清理。`,
    )
  if (out.length === 0)
    out.push('各项指标健康，无需特别操作；可顺手优化社交缓存与大文件。')
  return out
}
