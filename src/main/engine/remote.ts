import { createHash } from 'node:crypto'
import fs from 'node:fs'
import nodePath from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 远程数据层（捐赠 / 群聊 / 更新检查 / 反馈提交）。
 *
 * 设计：所有远程请求都带「本地示例回退」——即使没有后端、离线、或请求超时，
 * 界面也能正常显示占位内容。远程地址集中在 REMOTE_BASE 一处，后续接入真实
 * 后端时只需改这一个常量（或通过环境变量 GRCLEAN_REMOTE 覆盖）。
 *
 * 约定：远程 JSON 的字段名见下方类型；若后端格式不同，在这里做适配即可，
 * 渲染层不感知后端细节。
 */

/** 远程根地址（结尾带 /）。可用环境变量覆盖，便于本地联调 / 切换后端。 */
export const REMOTE_BASE =
  process.env.GRCLEAN_REMOTE ?? 'https://gr.graent.cn/grclean/'

/**
 * 官方站点根地址（结尾带 /）：捐赠记录、完整性校验接口等走这里（与路由同源）。
 * 收款码等图片已改走静态目录 STATIC_BASE，不再经由此处。
 * 可用环境变量 GRCLEAN_SITE 覆盖（本地联调用）。
 */
export const SITE_BASE =
  process.env.GRCLEAN_SITE ?? 'https://gr.graent.cn/grclean/'

/**
 * 静态资源根地址（结尾带 /）：收款码图片等直接走静态目录，不经过 ThinkPHP 路由。
 * 可用环境变量 GRCLEAN_STATIC 覆盖（本地联调用）。
 */
export const STATIC_BASE =
  process.env.GRCLEAN_STATIC ?? 'https://gr.graent.cn/static/gr-clean/'

/** 单次远程请求超时（毫秒）。 */
const REMOTE_TIMEOUT = 8000

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一条捐赠记录。
 * 远程 donate.json 约定（三种形状都支持：数组 / {donations:[…]} / {list:[…]}）：
 * ```json
 * [
 *   { "name": "热心用户 A", "amount": 20, "date": "2026-09-12", "message": "支持国产清理工具！", "method": "微信" }
 * ]
 * ```
 * 字段：name=昵称、amount=金额（元）、date=日期（YYYY-MM-DD）、message=留言、method=支付方式。
 * 只有 name/amount/date 是必需的，缺失字段界面显示占位符。
 */
export interface DonationItem {
  name: string
  amount: number
  date: string
  message?: string
  /** 支付方式（微信 / 支付宝 …） */
  method?: string
}

/** 一个社群 / 群聊入口。 */
export interface GroupInfo {
  /** qq / wechat / telegram / discord / other */
  type: string
  name: string
  /** 入群链接（可选，移动端可直接点开） */
  link?: string
  /** 群二维码图片地址（可选；QQ / 微信类群悬停展示，缺省由前端用占位图） */
  qr?: string
  note?: string
  /**
   * 是否在界面隐藏该项（true = 不显示，但数据/代码保留）。
   * 用于临时下线某个群（如微信群尚未准备好），需要时把这里改回 false 即可恢复。
   */
  hidden?: boolean
}

/** 一条公开反馈（已反馈列表用，方便移动端 / 桌面端查看）。 */
export interface FeedbackItem {
  /** 提交者昵称（可选，匿名留空） */
  name?: string
  content: string
  date: string
  /** 作者回复（可选） */
  reply?: string
}

/** 社区信息：捐赠列表 + 群聊列表 + 公开反馈列表 + 收款码配置。 */
export interface Community {
  donations: DonationItem[]
  groups: GroupInfo[]
  feedbacks: FeedbackItem[]
  /** 收款码配置（仅含图片地址与哈希，图片本身由 fetchDonateQr 校验后下载） */
  qrs: DonateQrConfig[]
}

/**
 * 收款码配置（远程下发）。
 *
 * 安全设计：图片**不内置在安装包里**（asar 可被解包替换后二次分发），也**不由渲染层直接加载**
 * （会绕过 CSP 并泄露 UA/IP）。改为远程下发「地址 + SHA-256」，由主进程下载后校验哈希，
 * 不匹配就拒绝显示——即使服务器或 CDN 被入侵换了图，也只会出现占位而不是骗子的收款码。
 */
export interface DonateQrConfig {
  /** alipay / wechat / mp（mp = 微信公众号） */
  platform: string
  /** 图片地址，必须为 https */
  url: string
  /** 图片内容的 SHA-256（小写十六进制） */
  sha256: string
  /** 收款方昵称，展示给用户核对（对抗"换码"最有效的一招） */
  payee?: string
  /** 收款账号（建议脱敏），同样用于用户核对 */
  account?: string
}

/**
 * 官方图片内置配置：远程 community.json 的 qrs 可覆盖（换图时无需发新版，
 * 更新远程的 url + sha256 即可）；取不到远程配置时用它。
 *
 * ⚠️ 换图后必须同步这里的 sha256，否则哈希校验不通过，界面只会显示占位。
 */
const QR_DEFAULTS: Record<string, { url: string; sha256: string }> = {
  wechat: {
    url: `${STATIC_BASE}wx.jpg`,
    sha256: '3ce1b62613eeb1aa3484e383ad2156d2b1c348ab6166c751a3110b8bea7512b8',
  },
  alipay: {
    url: `${STATIC_BASE}zfb.jpg`,
    sha256: '8933ffebaf2803991b1a614c94aeed86f7c979d17728bc8d50d8c8af174c17c1',
  },
  // 微信公众号「极志猿」二维码（关于页用）
  mp: {
    url: `${STATIC_BASE}gzh.jpg`,
    sha256: '4eb7e2bf4e12ecf8a6ca976aa7fb8b29540fcbf1fe4302cd989b184438b67d56',
  },
  // QQ 用户交流群二维码（反馈页用）
  // ⚠️ 图片内容更新后必须重新计算 sha256（当前为 2026-10 换过的 PNG 版）
  qqgroup: {
    url: `${STATIC_BASE}qq.jpg`,
    sha256: '195ad3807dc62d5806d0385a9415166801bdcc24398286bbce1032ff22c944d1',
  },
}

/** 收款码获取结果（message 为英文错误码，界面按 i18n 映射）。 */
export interface DonateQrResult {
  ok: boolean
  platform: string
  /** base64 data URL，ok=true 时有值 */
  dataUrl?: string
  payee?: string
  account?: string
  /** ok=false 时的错误码：NOT_CONFIGURED / REMOTE_UNAVAILABLE / INSECURE_URL / DOWNLOAD_FAILED / TOO_LARGE / BAD_TYPE / HASH_MISMATCH */
  message: string
}

/** 更新信息：当前版本、最新版本、是否有更新、下载地址、更新说明。 */
export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
  url: string
  notes: string[]
  /** 数据来源：remote=远程拉取成功 / sample=使用本地示例 */
  source: 'remote' | 'sample'
  checkedAt: number
}

/** 反馈提交结果。 */
export interface FeedbackResult {
  ok: boolean
  /** demo=true 表示演示环境（无后端），仅本地记录成功 */
  demo: boolean
  message: string
}

// ---------------------------------------------------------------------------
// 本地示例数据（远程不可用时的回退）
// ---------------------------------------------------------------------------

const SAMPLE_DONATIONS: DonationItem[] = [
  { name: '热心用户 A', amount: 20, date: '2026-09-12', message: '支持国产清理工具！', method: '微信' },
  { name: '匿名', amount: 50, date: '2026-08-30', method: '支付宝' },
  { name: 'B 同学', amount: 10, date: '2026-08-15', message: '希望加入更多功能～', method: '微信' },
  { name: 'C 老师', amount: 100, date: '2026-07-21', message: '很好用，已推荐给同事', method: '支付宝' },
]

const SAMPLE_GROUPS: GroupInfo[] = [
  {
    type: 'qq',
    name: 'GrClean 用户交流群',
    note: 'QQ群号1125900812，或者鼠标悬停查看二维码扫码进群',
  },
  // 微信群暂时下线：数据保留，界面用 hidden 隐藏；开放时把 hidden 改成 false 即可
  {
    type: 'wechat',
    name: 'GrClean 微信群',
    note: '鼠标悬停查看群二维码，扫码加入',
    hidden: true,
  },
]

const SAMPLE_FEEDBACKS: FeedbackItem[] = [
  { name: '小李', content: '希望增加微信缓存的深度清理', date: '2026-09-20', reply: '已在规划中，感谢建议！' },
  { content: '整体很清爽，比某卫士好用', date: '2026-09-05' },
  { name: 'Ada', content: '能不能出个便携版？', date: '2026-08-18' },
]

// ---------------------------------------------------------------------------
// 网络请求工具
// ---------------------------------------------------------------------------

/** 带超时的 JSON GET。失败（网络/超时/非 2xx）抛出，由调用方回退到示例。 */
async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REMOTE_TIMEOUT)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      // 服务端返回非 2xx（如 404/500）。主进程日志一律 ASCII；渲染层 DevTools 看不到主进程请求
      console.error('[remote] GET', url, '-> HTTP', res.status)
      throw new Error(`HTTP ${res.status}`)
    }
    return (await res.json()) as T
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('HTTP '))) {
      console.error('[remote] GET failed:', url, '-', String(e))
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 带超时的二进制 GET（收款码图片下载）。失败抛错。 */
async function getBinary(url: string): Promise<{ buf: Buffer; mime: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REMOTE_TIMEOUT)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    return { buf: Buffer.from(await res.arrayBuffer()), mime }
  } finally {
    clearTimeout(timer)
  }
}

/** 带超时的 JSON POST。失败抛错。（导出备用：接入真实反馈后端时在 submitFeedback 中启用） */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REMOTE_TIMEOUT)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // 服务端返回非 2xx（如 404/500）。读响应体便于排查；主进程日志一律 ASCII
      const text = await res.text().catch(() => '')
      console.error('[remote] POST', url, '-> HTTP', res.status, (text || '').slice(0, 200))
      throw new Error(`HTTP ${res.status}`)
    }
    return (await res.json()) as T
  } catch (e) {
    // 网络层错误（DNS / TLS / 超时 / 连接被拒）主进程侧也要留痕：渲染层 DevTools 看不到主进程请求
    if (!(e instanceof Error && e.message.startsWith('HTTP '))) {
      console.error('[remote] POST failed:', url, '-', String(e))
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 业务函数（均带示例回退）
// ---------------------------------------------------------------------------

/** 版本比较：a > b 返回正数（语义化版本，按点分数字逐段比较）。 */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** 检查更新：拉取远程版本 JSON，与当前版本比较。远程不可用时回退到示例（无更新）。 */
export async function getUpdateInfo(current: string): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    current,
    latest: current,
    hasUpdate: false,
    url: REMOTE_BASE,
    notes: [],
    source: 'sample',
    checkedAt: Date.now(),
  }
  try {
    const remote = await getJson<{
      latest?: string
      url?: string
      notes?: string[]
    }>(`${REMOTE_BASE}update`)
    const latest = remote.latest ?? current
    return {
      ...base,
      latest,
      url: remote.url ?? REMOTE_BASE,
      notes: remote.notes ?? [],
      hasUpdate: cmpVersion(latest, current) > 0,
      source: 'remote',
    }
  } catch {
    return base
  }
}

/**
 * 拉取捐赠记录（官方站点 donate.json）。
 * 兼容三种形状：数组 / {donations:[…]} / {list:[…]}；远程不可用则回退示例数据。
 */
export async function getDonations(): Promise<DonationItem[]> {
  try {
    const j = await getJson<
      DonationItem[] | { donations?: DonationItem[]; list?: DonationItem[] }
    >(`${SITE_BASE}donate`)
    const arr = Array.isArray(j) ? j : (j?.donations ?? j?.list ?? [])
    const list = arr.filter((d): d is DonationItem => !!d && typeof d === 'object')
    return list.length ? list : SAMPLE_DONATIONS
  } catch {
    return SAMPLE_DONATIONS
  }
}

/** 远程 community.json 的形状（群聊 / 公开反馈 / 图片覆盖配置）。 */
interface CommunityRemote {
  groups?: GroupInfo[]
  feedbacks?: FeedbackItem[]
  qrs?: DonateQrConfig[]
}

/**
 * 群二维码 platform 键：群聊二维码复用收款码那条「主进程下载 + SHA-256 校验」通道，
 * 避免渲染层直接加载外部图片（绕过 CSP / 泄露 IP，且无法防换码）。
 */
const GROUP_QR_PLATFORM: Record<string, string> = {
  qq: 'qqgroup',
}

/**
 * 给群聊项补齐二维码图片。
 * 已有 qr（远程直给的 data URL）的不覆盖；校验不通过的保持无 qr，界面显示占位。
 */
async function resolveGroupQrs(groups: GroupInfo[]): Promise<GroupInfo[]> {
  return Promise.all(
    groups.map(async (g) => {
      if (g.qr) return g
      const platform = GROUP_QR_PLATFORM[g.type]
      if (!platform) return g
      const r = await fetchDonateQr(platform)
      return r.ok && r.dataUrl ? { ...g, qr: r.dataUrl } : g
    }),
  )
}

/** 获取社区信息（捐赠列表 + 群聊 + 公开反馈 + 收款码配置）。远程不可用时回退到示例。 */
export async function getCommunity(): Promise<Community> {
  let remote: CommunityRemote | null = null
  try {
    remote = await getJson<CommunityRemote>(`${REMOTE_BASE}community`)
  } catch {
    remote = null
  }
  return {
    // 捐赠记录以官方 donate.json 为准（它是唯一数据源）
    donations: await getDonations(),
    groups: await resolveGroupQrs(remote?.groups ?? SAMPLE_GROUPS),
    feedbacks: remote?.feedbacks ?? SAMPLE_FEEDBACKS,
    qrs: remote?.qrs ?? [],
  }
}

/** 收款码图片大小上限（2 MB），防止被塞入超大内容。 */
const QR_MAX_BYTES = 2 * 1024 * 1024
/** 允许的收款码图片类型（不接受 svg，避免任何可执行内容）。 */
const QR_MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * 按文件头嗅探真实图片类型。
 * 站点有时会把 PNG 存成 .jpg 后缀并返回 `image/jpeg`，只信 Content-Type 会让 data URL 的
 * MIME 与实际内容不符；这里以文件头为准，嗅不出来才回落到 header。
 */
function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return undefined
}
/** 下载成功的收款码进程内缓存（避免每次进页面重复请求）。 */
const qrCache = new Map<string, DonateQrResult>()

/**
 * 拉取指定平台的收款码：远程配置 → HTTPS 下载 → SHA-256 校验 → 返回 base64 data URL。
 * 任一环节不通过都返回 ok=false + 错误码，界面显示占位，绝不显示未经验证的图片。
 */
export async function fetchDonateQr(platform: string): Promise<DonateQrResult> {
  const hit = qrCache.get(platform)
  if (hit?.ok) return hit
  const fail = (message: string): DonateQrResult => ({ ok: false, platform, message })

  // 1) 取配置：优先远程 community（可被远程覆盖，换图免发版）；内置官方地址 + 哈希作为兜底
  let remoteCfg: DonateQrConfig | undefined
  try {
    const remote = await getJson<{ qrs?: DonateQrConfig[] }>(`${REMOTE_BASE}community`)
    remoteCfg = (remote.qrs ?? []).find((q) => q.platform === platform)
  } catch {
    /* 远程未部署 / 不可用：回落到内置配置 */
  }
  const builtin = QR_DEFAULTS[platform]
    ? { platform, ...QR_DEFAULTS[platform] }
    : undefined

  // 候选顺序：远程配置在前（可被覆盖），内置在后（防御远程配置过期 / URL 失效导致 404）
  const candidates: DonateQrConfig[] = []
  if (remoteCfg) candidates.push(remoteCfg)
  if (
    builtin &&
    !candidates.some((c) => c.url === builtin.url && c.sha256 === builtin.sha256)
  ) {
    candidates.push(builtin)
  }
  if (!candidates.length) return fail('NOT_CONFIGURED')

  // 2) 逐个尝试：下载 → 校验大小/类型/哈希，任一通过即返回
  let lastErr = 'DOWNLOAD_FAILED'
  for (const cfg of candidates) {
    if (!cfg.url || !cfg.sha256) continue
    // 只接受 https：明文 http 链路可被中间人直接换图
    if (!/^https:\/\//i.test(cfg.url)) {
      lastErr = 'INSECURE_URL'
      continue
    }
    try {
      const { buf, mime } = await getBinary(cfg.url)
      if (buf.length > QR_MAX_BYTES) {
        lastErr = 'TOO_LARGE'
        continue
      }
      // 以后缀/Content-Type 之外的真实文件头为准（qq.jpg 实际就是 PNG）
      const real = sniffImageMime(buf) ?? mime
      if (!QR_MIME_OK.has(real)) {
        lastErr = 'BAD_TYPE'
        continue
      }
      const hash = createHash('sha256').update(buf).digest('hex')
      if (hash !== cfg.sha256.trim().toLowerCase()) {
        // 主进程日志一律 ASCII：Windows 控制台 GBK 会把中文打乱码
        console.warn('[remote] donate qr sha256 mismatch, rejected:', platform, cfg.url)
        lastErr = 'HASH_MISMATCH'
        continue
      }
      const ok: DonateQrResult = {
        ok: true,
        platform,
        dataUrl: `data:${real};base64,${buf.toString('base64')}`,
        payee: cfg.payee,
        account: cfg.account,
        message: '',
      }
      qrCache.set(platform, ok)
      return ok
    } catch {
      // 远程配置地址失效（如 404）时，回落到内置官方地址再试，不直接判失败
      if (cfg === remoteCfg && builtin) {
        console.warn('[remote] donate qr download failed, fallback to builtin:', platform, cfg.url)
      }
      lastErr = 'DOWNLOAD_FAILED'
    }
  }
  return fail(lastErr)
}

// ---------------------------------------------------------------------------
// 程序完整性校验（本机哈希 → 官方 verify.php 比对）
// ---------------------------------------------------------------------------

/** 被校验的本机程序文件。 */
export interface IntegrityFileResult {
  /** 文件名（app.asar 或主程序名） */
  name: string
  /** 本机文件字节数 */
  size: number
  /** 本机计算出的 SHA-256（送服务端比对的就是它） */
  local: string
  /** true=一致 / false=不一致 / null=服务端未给出结论 */
  match: boolean | null
}

/** 完整性校验结果。code 为英文结果码，界面按 i18n 映射展示。 */
export interface IntegrityResult {
  /**
   * OK / MISMATCH / NOT_CONFIGURED / REMOTE_UNAVAILABLE / DEV_MODE / NO_TARGET / HASH_FAILED
   * - OK：与官方发布值一致
   * - MISMATCH：与官方发布值不一致（可能被篡改或下载损坏）
   * - NOT_CONFIGURED：服务端返回 -1（参数缺失 / 该版本未收录官方校验值）
   * - REMOTE_UNAVAILABLE：请求失败、超时、非 2xx 或返回未知业务码（失败原因见 detail）
   * - DEV_MODE：本机没有官方发布包可比（开发模式）
   * - NO_TARGET：已打包但找不到程序本体文件
   * - HASH_FAILED：找到文件但读取/计算哈希失败
   */
  code: string
  /** 本机版本号（送服务端的 v 参数） */
  version: string
  /** 服务端返回的 msg（如「正确」「已被篡改」），直接展示 */
  msg: string
  files: IntegrityFileResult[]
  checkedAt: number
  /** 诊断明细（ASCII），异常时展示，便于定位本机环境；正常时也可为空 */
  detail?: string
}

/**
 * 服务端校验返回：
 * - `{ "code": 0, "msg": "正确" }` 一致
 * - `{ "code": 1, "msg": "已被篡改" }` 不一致
 * - `{ "code": -1, "msg": "参数缺失" | "未收录该版本哈希" }` 官方侧暂无该版本的校验值
 */
interface VerifyResponse {
  code?: number | string
  msg?: string
}

/**
 * 判断路径是否位于系统临时目录下 —— 便携版（portable.exe）会把整个程序解压到
 * `%TEMP%\<随机名>` 再运行，据此识别当前是不是便携形态。
 *
 * 注意 Windows 下 `%TEMP%` 可能以 8.3 短名给出（如 `C:\Users\ADMINI~1\AppData\Local\Temp`），
 * 无法直接字符串前缀比较，所以先 realpath 归一化，失败再用 `\Temp\` 路径段兜底。
 */
function isUnderTempDir(p: string): boolean {
  if (!p) return false
  try {
    const tmp = nodePath.resolve(tmpdir()).toLowerCase()
    if (nodePath.resolve(fs.realpathSync(p)).toLowerCase().startsWith(tmp)) return true
  } catch {
    /* 目录不存在 / 短名解析失败，走下面的兜底 */
  }
  return /(^|[\\/])temp([\\/]|$)/i.test(p)
}

/**
 * 流式计算文件 SHA-256（大文件也不会长时间阻塞主进程：每 32 个分块让出一次事件循环）。
 * 不吞掉异常：失败时带着 errno 返回，调用方据此区分「文件不在」「被占用」「权限不足」。
 */
async function sha256File(p: string): Promise<{ hash: string; size: number; error?: string }> {
  try {
    const st = await fs.promises.stat(p)
    if (!st.isFile()) return { hash: '', size: 0, error: 'NOT_FILE' }
    const h = createHash('sha256')
    const rs = fs.createReadStream(p)
    let n = 0
    for await (const chunk of rs) {
      h.update(chunk as Buffer)
      if (++n % 32 === 0) await new Promise((r) => setImmediate(r))
    }
    return { hash: h.digest('hex'), size: st.size }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    return { hash: '', size: 0, error: code ?? 'IO_ERROR' }
  }
}

/**
 * 校验本程序是否完整、未被篡改：
 * 计算本机程序文件（优先 app.asar，其次主程序 exe）的 SHA-256，
 * 请求官方 `verify?v=<版本>&h=<哈希>&f=<文件名>&size=<字节数>`，由服务端判定后返回。
 *
 * 服务端约定：`{"code": 0, "msg": "正确"}` 表示一致；`{"code": 1, "msg": "已被篡改"}` 表示不一致；
 * `{"code": -1, ...}` 表示该版本尚未收录官方校验值（参数缺失 / 未收录该版本哈希），映射为 NOT_CONFIGURED。
 * 需要联网；请求失败 / 返回非法时回退 REMOTE_UNAVAILABLE，**绝不谎称"校验通过"**。
 * 参数由调用方（IPC handler）传入，保持本文件不直接依赖 electron，便于在 Node 下单独测试。
 *
 * ⚠️ 参数名**禁止使用 `s`**：ThinkPHP 把 `?s=` 当作 PATH_INFO 路由变量（`?s=/模块/控制器/方法`
 * 的兼容机制），传 `?s=19890977` 会被解析成「访问名为 19890977 的路由」→ 直接 404。
 * 实测 URL 编码成 `%73` 也无效（框架在解码之后取值）。故体积参数命名为 `size`。
 */
export async function verifyIntegrity(opts: {
  version: string
  packaged: boolean
  resourcesPath: string
  exePath: string
}): Promise<IntegrityResult> {
  const base: IntegrityResult = {
    code: 'OK',
    version: opts.version ?? '',
    msg: '',
    files: [],
    checkedAt: Date.now(),
    detail: '',
  }
  // 便携版识别要在 diag 之前算好：便携版会把程序解压到 %TEMP%\<随机名> 再运行，
  // 校验目标的选择和诊断信息都依赖它。
  const resourcesPath = opts.resourcesPath || ''
  const portableMode = isUnderTempDir(resourcesPath)

  // 诊断明细：异常时把本机实况一并回传，避免界面只能笼统提示而无法定位。
  // 一律 ASCII —— Windows 控制台 / 部分字体下中文可能乱码。
  const diag = (extra = ''): string =>
    `packaged=${opts.packaged ? 1 : 0}` +
    `; mode=${portableMode ? 'portable' : 'installed'}` +
    `; resourcesPath=${opts.resourcesPath || '(empty)'}` +
    `; exePath=${opts.exePath || '(empty)'}` +
    (extra ? `; ${extra}` : '')

  // 1) 收集候选文件，逐个尝试，取第一个能成功算出哈希的。
  //
  // 为什么不能用单一目标：不同分发形态下可校验的实体并不一样。
  // - 安装版 / win-unpacked：resources\app.asar 是磁盘上的独立文件，是正主；
  // - **便携版（portable.exe）**：整个程序解压到 %TEMP%\<随机名> 边解压边运行，
  //   app.asar 可能还没释放完就被读到（残缺哈希会被服务端误判成"已被篡改"），
  //   而 exe 必然已完整 —— 否则程序根本起不来。
  // 因此便携版优先 exe、安装版优先 app.asar，彼此兜底；每个候选的失败原因都
  // 记进 detail（`tried=app.asar:ENOENT;GrClean.exe:OK`），出问题时一眼可判定。
  const asar = resourcesPath ? nodePath.join(resourcesPath, 'app.asar') : ''
  const haveAsar = !!asar && fs.existsSync(asar)
  const haveExe = !!opts.exePath && fs.existsSync(opts.exePath)

  const asarCandidate = { name: 'app.asar', path: asar }
  const exeCandidate = { name: nodePath.basename(opts.exePath), path: opts.exePath }

  const candidates = portableMode
    ? [exeCandidate, asarCandidate].filter((c) => (c === exeCandidate ? haveExe : haveAsar))
    : [asarCandidate, exeCandidate].filter((c) => (c === asarCandidate ? haveAsar : haveExe))

  const tried: string[] = []
  let picked: { name: string; size: number; hash: string } | null = null
  for (const c of candidates) {
    const r = await sha256File(c.path)
    if (r.hash) {
      picked = { name: c.name, size: r.size, hash: r.hash }
      tried.push(`${c.name}:OK`)
      break
    }
    tried.push(`${c.name}:${r.error ?? 'EMPTY'}`)
  }

  const triedText = `tried=${tried.length ? tried.join(',') : 'none'}`

  if (!picked) {
    if (candidates.length === 0) {
      return {
        ...base,
        code: opts.packaged ? 'NO_TARGET' : 'DEV_MODE',
        detail: diag(triedText),
      }
    }
    // 有候选但都读不动（被占用 / 权限不足）
    return { ...base, code: 'HASH_FAILED', detail: diag(triedText) }
  }

  // 2) 送服务端比对。带 f=<文件名> —— 安装版校验的是 app.asar，便携版只能是 exe，
  //    两者哈希完全不同，服务端需要知道比的是哪一个。
  //
  //    ⚠️ 体积参数名是 `size` 不是 `s` —— ThinkPHP 用 `s` 作 PATH_INFO 路由变量，
  //    传 `?s=<数字>` 会被当成访问名为该数字的路由，服务端直接 404（实测如此）。
  const target = picked
  const url =
    `${SITE_BASE}verify?v=${encodeURIComponent(base.version)}` +
    `&h=${target.hash}` +
    `&f=${encodeURIComponent(target.name)}` +
    `&size=${target.size}`
  const diagBase = `${triedText}; target=${target.name}; size=${target.size}`
  try {
    const r = await getJson<VerifyResponse>(url)
    const code = String(r?.code ?? '').trim()
    const msg = String(r?.msg ?? '').trim()
    if (code === '0') {
      return {
        ...base,
        code: 'OK',
        msg,
        files: [{ name: target.name, size: target.size, local: target.hash, match: true }],
        detail: diag(diagBase),
      }
    }
    if (code === '1') {
      return {
        ...base,
        code: 'MISMATCH',
        msg,
        files: [{ name: target.name, size: target.size, local: target.hash, match: false }],
        detail: diag(diagBase),
      }
    }
    // -1（参数缺失 / 官方尚未收录该版本哈希）等业务码：走 NOT_CONFIGURED，
    // 不要把「未收录」误报成「连不上服务器」—— 服务端 msg 已说明原因，直接透传。
    if (code === '-1') {
      return {
        ...base,
        code: 'NOT_CONFIGURED',
        msg,
        files: [{ name: target.name, size: target.size, local: target.hash, match: null }],
        detail: diag(`${diagBase}; serverCode=${code}`),
      }
    }
    // 其余未知业务码：仍归为「服务端不可用」，但把原始 code 记进 detail 便于定位
    return {
      ...base,
      code: 'REMOTE_UNAVAILABLE',
      msg,
      files: [{ name: target.name, size: target.size, local: target.hash, match: null }],
      detail: diag(`${diagBase}; serverCode=${code || '(empty)'}`),
    }
  } catch (e) {
    // 网络失败 / 超时 / 非 2xx / JSON 解析失败。把失败原因（含 HTTP 状态码）并入 detail，
    // 让界面能区分「404 接口不存在」与「网络不通 / 超时」，而不是笼统一句话。
    const reason = e instanceof Error ? e.message : String(e)
    return {
      ...base,
      files: [{ name: target.name, size: target.size, local: target.hash, match: null }],
      code: 'REMOTE_UNAVAILABLE',
      detail: diag(`${diagBase}; err=${reason}`),
    }
  }
}

/**
 * 提交反馈。POST 到后端 grclean/feedback，由服务端落库并返回 { ok, message }。
 * 失败（网络/超时/非 2xx）时回退为「提交失败」提示，绝不谎称成功。
 */
export async function submitFeedback(payload: {
  name?: string
  type?: string
  contact?: string
  content: string
}): Promise<FeedbackResult> {
  if (!payload.content || !payload.content.trim()) {
    return { ok: false, demo: false, message: '反馈内容不能为空' }
  }
  try {
    const res = await postJson<{ ok?: boolean; message?: string; id?: number }>(
      `${REMOTE_BASE}feedback`,
      payload,
    )
    return { ok: !!res?.ok, demo: false, message: res?.message || '提交成功' }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.error('[remote] submitFeedback error:', reason)
    // 把真实失败原因（HTTP 状态码 / 连接错误）透出到界面，避免一律显示"检查网络"误导排查
    return { ok: false, demo: false, message: `提交失败（${reason}），请检查网络或稍后重试` }
  }
}
