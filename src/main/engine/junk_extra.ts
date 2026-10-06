import { expandEnv } from './rules'

/**
 * 风险等级：
 * - safe    安全，删除后可自动重建或本就是残留
 * - caution 需确认（可能影响需要恢复的数据）
 * - danger  不可逆，勾选前必须确认无需回退
 */
export type ExtraLevel = 'safe' | 'caution' | 'danger'

export interface ExtraJunkItem {
  id: string
  name: string
  description: string
  level: ExtraLevel
  /** 是否建议默认勾选（caution / danger 一律不默认勾选） */
  recommend: boolean
  /** glob 模式（支持 %ENV% 环境变量），扫描时展开并统一为斜杠 */
  patterns: string[]
  /** 仅清理超过该天数的文件（0 = 不限制） */
  max_age_days: number
  /** 特殊项：不走普通文件扫描/删除流程 */
  special?: string
}

/**
 * 增强清理项目录（14 项）。
 *
 * 说明：patterns 全部指向「明确的缓存/残留目录」，不含通配到系统盘根的模式；
 * 其中位于受保护前缀（C:\Windows、C:\ProgramData）下的项在删除时
 * 需要「显式勾选 + 路径落在声明的根目录内」双重校验才会放行（见 protected.ts）。
 */
export function extraJunkItems(): ExtraJunkItem[] {
  return [
    {
      id: 'downloaded_program_files',
      name: '下载的程序文件',
      description: 'ActiveX/Java 小程序残留，通常 0 字节',
      level: 'safe',
      recommend: true,
      patterns: ['%SystemRoot%\\Downloaded Program Files\\**\\*'],
      max_age_days: 0,
    },
    {
      id: 'inet_temp',
      name: 'Internet 临时文件',
      description: 'IE/早期 Edge 缓存',
      level: 'safe',
      recommend: true,
      patterns: [
        '%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache\\**\\*',
        '%LOCALAPPDATA%\\Microsoft\\Windows\\INetCookies\\**\\*',
      ],
      max_age_days: 0,
    },
    {
      id: 'windows_error_report',
      name: 'Windows 错误报告',
      description: '崩溃报告副本，几十 MB',
      level: 'safe',
      recommend: true,
      patterns: [
        '%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportQueue\\**\\*',
        '%PROGRAMDATA%\\Microsoft\\Windows\\WER\\**\\*',
      ],
      max_age_days: 0,
    },
    {
      id: 'dx_shader_cache',
      name: 'DirectX 着色器缓存',
      description: '删后自动重建，下次进游戏慢几秒',
      level: 'safe',
      recommend: true,
      patterns: ['%LOCALAPPDATA%\\D3DSCache\\**\\*'],
      max_age_days: 0,
    },
    {
      id: 'delivery_optimization',
      name: '传递优化文件',
      description: '更新 P2P 分发缓存，可达数 GB',
      level: 'safe',
      recommend: true,
      patterns: [
        '%SystemRoot%\\SoftwareDistribution\\DeliveryOptimization\\**\\*',
        '%SystemRoot%\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\**\\*',
      ],
      max_age_days: 0,
    },
    {
      id: 'temp_files',
      name: '临时文件',
      description: '系统临时目录超期文件（保留最近 3 天，避免影响正在运行的程序）',
      level: 'safe',
      recommend: true,
      patterns: ['%TEMP%\\**\\*', '%SystemRoot%\\Temp\\**\\*'],
      max_age_days: 3,
    },
    {
      id: 'thumbnails',
      name: '缩略图',
      description: '图片预览缓存，自动重建',
      level: 'safe',
      recommend: true,
      patterns: [
        '%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\thumbcache_*.db',
      ],
      max_age_days: 0,
    },
    {
      id: 'windows_old',
      name: '以前的 Windows 安装',
      description: '通常 20GB，不可逆，新系统用了一周没问题再勾',
      level: 'danger',
      recommend: false,
      patterns: ['%SystemDrive%\\Windows.old\\**\\*'],
      max_age_days: 0,
    },
    {
      id: 'windows_update_cleanup',
      name: 'Windows 更新清理',
      description: '能腾几 GB，不可逆，清完补丁卸载不了',
      level: 'danger',
      recommend: false,
      patterns: ['%SystemRoot%\\SoftwareDistribution\\Download\\**\\*'],
      max_age_days: 0,
    },
    {
      id: 'windows_upgrade_logs',
      name: 'Windows 升级日志',
      description: '升级过程日志',
      level: 'safe',
      recommend: true,
      patterns: ['%SystemRoot%\\Panther\\**\\*'],
      max_age_days: 0,
    },
    {
      id: 'memory_dump',
      name: '系统错误内存转储',
      description: '蓝屏现场，蓝屏复发时别勾',
      level: 'danger',
      recommend: false,
      patterns: ['%SystemRoot%\\Minidump\\**\\*', '%SystemRoot%\\MEMORY.DMP'],
      max_age_days: 0,
    },
    {
      id: 'temp_windows_install',
      name: '临时 Windows 安装文件',
      description: '升级残留',
      level: 'safe',
      recommend: true,
      patterns: [
        '%SystemDrive%\\$WINDOWS.~BT\\**\\*',
        '%SystemDrive%\\$WINDOWS.~WS\\**\\*',
      ],
      max_age_days: 0,
    },
    {
      id: 'user_error_report',
      name: '每用户存档的错误报告',
      description: '同错误报告',
      level: 'safe',
      recommend: true,
      patterns: [
        '%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportArchive\\**\\*',
      ],
      max_age_days: 0,
    },
    {
      id: 'recycle_bin',
      name: '回收站',
      description: '先检查有无需要恢复的文件（逐条列出，可单独删除或整组勾选）',
      level: 'caution',
      recommend: false,
      patterns: [],
      max_age_days: 0,
      special: 'recycle_bin',
    },
  ]
}

export function extraItemById(id: string): ExtraJunkItem | undefined {
  return extraJunkItems().find((i) => i.id === id)
}

/** 展开环境变量并把反斜杠统一为斜杠（fast-glob 使用斜杠作为分隔符）。 */
export function normalizePattern(p: string): string {
  return expandEnv(p).replace(/\\/g, '/')
}

/**
 * 取 glob 模式的「根目录」：截断到第一个含通配符的片段之前。
 * 例：`C:/Windows/SoftwareDistribution/Download/**`/* → `c:/windows/softwaredistribution/download`
 * 删除期用它校验候选路径确实落在该项声明的目录内，防止越权删除。
 */
export function patternRoot(pattern: string): string {
  const norm = normalizePattern(pattern).toLowerCase()
  const segs = norm.split('/')
  const kept: string[] = []
  for (const seg of segs) {
    if (seg.includes('*') || seg.includes('?')) break
    kept.push(seg)
  }
  return kept.join('/')
}

/**
 * 该项是否为「系统级」清理项（目录位于受保护前缀下）。
 * 这类项必须显式勾选，且删除时按声明的根目录逐项放行。
 */
export function isSystemExtra(item: ExtraJunkItem): boolean {
  const roots = item.patterns.map(patternRoot)
  const protectedPrefixes = ['c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/programdata']
  return roots.some((r) => protectedPrefixes.some((p) => r === p || r.startsWith(p + '/')))
}

/** 该清理项声明的所有根目录（小写、斜杠分隔），用于删除期越权校验。 */
export function extraRootPrefixes(item: ExtraJunkItem): string[] {
  return item.patterns.map(patternRoot).filter((r) => r.length > 0)
}
