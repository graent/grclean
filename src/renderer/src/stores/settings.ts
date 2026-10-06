import { reactive, watch } from 'vue'

/** 8 套主题（对应设计文档 §9.7），默认晴空蓝 Sky（F）。 */
export type ThemeKey =
  | 'mint' // A 薄荷青
  | 'sage' // B 鼠尾草
  | 'ink' // C 墨蓝
  | 'amber' // D 琥珀暖灰
  | 'noir' // E 暗夜青柠（深色）
  | 'sky' // F 晴空蓝（默认）
  | 'peach' // G 蜜桃粉
  | 'grape' // H 葡萄紫

/** 主题清单（设置页一键切换用）。primary/sidebar/bg/panel 用于选择器色块预览，取值对齐 design.md §9.7。 */
export const THEMES: Array<{
  key: ThemeKey
  label: string
  desc: string
  primary: string
  sidebar: string
  bg: string
  panel: string
}> = [
  { key: 'mint', label: '薄荷青', desc: '清新自然', primary: '#0F5F5C', sidebar: '#0B4A47', bg: '#FFFFFF', panel: '#F2FAF9' },
  { key: 'sage', label: '鼠尾草', desc: '温润克制', primary: '#5B7B6F', sidebar: '#3E5A50', bg: '#FBFAF7', panel: '#F4F3EE' },
  { key: 'ink', label: '墨蓝', desc: '专业可信', primary: '#1F3A5F', sidebar: '#16293F', bg: '#FFFFFF', panel: '#F4F7FB' },
  { key: 'amber', label: '琥珀暖灰', desc: '暖色稳重', primary: '#C8842B', sidebar: '#2B2B2E', bg: '#FAF7F2', panel: '#F2EDE5' },
  { key: 'noir', label: '暗夜青柠', desc: '深色护眼', primary: '#9DBF2E', sidebar: '#101216', bg: '#16181D', panel: '#1E2128' },
  { key: 'sky', label: '晴空蓝', desc: '主色点缀', primary: '#2E93E0', sidebar: '#FFFFFF', bg: '#F4F6F8', panel: '#FFFFFF' },
  { key: 'peach', label: '蜜桃粉', desc: '温柔活力', primary: '#F06D7E', sidebar: '#D84F66', bg: '#FFF6F5', panel: '#FDECEC' },
  { key: 'grape', label: '葡萄紫', desc: '甜美年轻', primary: '#8B6FD6', sidebar: '#6A4FB8', bg: '#FAF8FE', panel: '#F0EBFB' },
]

export const DEFAULT_THEME: ThemeKey = 'sky'

/**
 * 字体大小四档。
 * `scale` 是全局文字缩放系数，作用于所有 `calc(Npx * var(--fs-scale))` 声明；
 * `px` 仅用于在设置页展示等效正文字号。
 */
export type FontSizeKey = 'small' | 'normal' | 'medium' | 'large'

export const FONT_SIZES: Array<{
  key: FontSizeKey
  /** 等效正文字号（仅展示用） */
  px: number
  scale: number
}> = [
  { key: 'small', px: 13, scale: 0.9 },
  { key: 'normal', px: 14, scale: 1 },
  { key: 'medium', px: 16, scale: 1.15 },
  { key: 'large', px: 18, scale: 1.3 },
]

export const DEFAULT_FONT_SIZE: FontSizeKey = 'normal'

/** 界面语言（对应 i18n 目录下的 <code>.json 文件名）。 */
export const DEFAULT_LOCALE = 'zh-CN'

interface Settings {
  theme: ThemeKey
  /** 界面语言代码，如 zh-CN / en-US；包不存在时自动回退。 */
  locale: string
  fontSize: FontSizeKey
  /** 允许永久删除（移入回收站之外）。默认关闭，属高危选项。 */
  allowPurge: boolean
}

const KEY = 'grclean.settings'

function isTheme(v: unknown): v is ThemeKey {
  return typeof v === 'string' && THEMES.some((t) => t.key === v)
}

function isFont(v: unknown): v is FontSizeKey {
  return typeof v === 'string' && FONT_SIZES.some((f) => f.key === v)
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw)
      // 旧版可能存 'light' / 'dark'，统一迁移到 8 主题（light/dark -> sky）
      const theme: ThemeKey = isTheme(p?.theme) ? p.theme : DEFAULT_THEME
      return {
        theme,
        locale: typeof p?.locale === 'string' && p.locale ? p.locale : DEFAULT_LOCALE,
        fontSize: isFont(p?.fontSize) ? p.fontSize : DEFAULT_FONT_SIZE,
        allowPurge: !!p?.allowPurge,
      }
    }
  } catch {
    /* ignore */
  }
  return {
    theme: DEFAULT_THEME,
    locale: DEFAULT_LOCALE,
    fontSize: DEFAULT_FONT_SIZE,
    allowPurge: false,
  }
}

export const settings = reactive<Settings>(load())

export function applyTheme() {
  document.documentElement.dataset.theme = settings.theme
}

/** 写入 --fs-scale：所有界面文字按此系数缩放，即时生效。 */
export function applyFontSize() {
  const f = FONT_SIZES.find((x) => x.key === settings.fontSize) ?? FONT_SIZES[1]
  document.documentElement.dataset.font = settings.fontSize
  document.documentElement.style.setProperty('--fs-scale', String(f.scale))
}

watch(
  settings,
  (s) => {
    localStorage.setItem(KEY, JSON.stringify(s))
    applyTheme()
    applyFontSize()
  },
  { deep: true },
)

applyTheme()
applyFontSize()
