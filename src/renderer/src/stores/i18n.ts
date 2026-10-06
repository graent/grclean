import { reactive, ref, watch } from 'vue'
import { settings, DEFAULT_LOCALE } from './settings'
import {
  listLocales,
  getLocaleMessages,
  getI18nDir,
  type LocaleMeta,
} from '../api/electron'

/**
 * 轻量多语言：语言包是 `%LOCALAPPDATA%/GrClean/i18n/*.json`，
 * 运行时可随时增删文件，设置页点「刷新语言列表」即热更新。
 *
 * 查找链：当前语言 → 回退语言（zh-CN）→ key 本身。
 */

/** 可用语言包摘要（设置页下拉用）。 */
export const locales = ref<LocaleMeta[]>([])

/** 语言包目录（展示 + 打开）。 */
export const i18nDir = ref('')

/** 当前语言词条（响应式：增删 key 会触发界面重渲染）。 */
export const dict = reactive<Record<string, string>>({})

/** 回退语言词条（不参与渲染，仅查表用）。 */
let fallbackDict: Record<string, string> = {}

/** 读取语言包列表（每次重新读盘 → 支持热增减）。 */
export async function loadLocales(): Promise<LocaleMeta[]> {
  try {
    locales.value = await listLocales()
  } catch {
    locales.value = []
  }
  try {
    i18nDir.value = await getI18nDir()
  } catch {
    i18nDir.value = ''
  }
  return locales.value
}

function replace(target: Record<string, string>, next: Record<string, string>): void {
  for (const k of Object.keys(target)) delete target[k]
  for (const [k, v] of Object.entries(next)) target[k] = v
}

/** 切换语言：加载词条并落盘到 settings（自动持久化）。 */
export async function setLocale(code: string): Promise<void> {
  const list = locales.value.length ? locales.value : await loadLocales()
  const exists = list.some((l) => l.code === code)
  const target = exists ? code : DEFAULT_LOCALE

  // 回退包只加载一次（内容稳定）
  if (!Object.keys(fallbackDict).length) {
    try {
      fallbackDict = await getLocaleMessages(DEFAULT_LOCALE)
    } catch {
      fallbackDict = {}
    }
  }

  let next: Record<string, string> = {}
  try {
    next = await getLocaleMessages(target)
  } catch {
    next = {}
  }
  replace(dict, next)

  if (settings.locale !== target) settings.locale = target
  if (!exists && code !== DEFAULT_LOCALE) {
    console.warn(`[GrClean] 语言包 ${code} 不存在，已回退到 ${DEFAULT_LOCALE}`)
  }
}

/** 翻译：`t('nav.home')`；支持 `{n}` 占位：`t('rules.ageDays', { n: 30 })`。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dict[key] ?? fallbackDict[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}

/** 应用启动初始化：读列表 → 载入当前语言。 */
export async function initI18n(): Promise<void> {
  await loadLocales()
  await setLocale(settings.locale)
}

// 语言切换即时生效（Settings 页直接改 settings.locale 即可）
watch(
  () => settings.locale,
  (code) => {
    void setLocale(code)
  },
)
