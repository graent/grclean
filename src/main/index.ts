import { app, shell, BrowserWindow, Menu } from 'electron'
import fs from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerHandlers } from './ipc/handlers'
import { runPrivacyCleanupBySchedule } from './engine/schedule'

// handlers 只需注册一次（单窗口：Windows 下关闭即退出，不会重复创建）
let handlersRegistered = false

/**
 * 开发期监听 preload 产物变化并自动刷新窗口。
 *
 * preload 脚本只在页面加载时执行一次，Vite 的 HMR 只覆盖 Vue 组件，不会更新
 * preload。因此改完 preload 若未刷新页面，渲染层拿到的是旧 api，就会报
 * `window.api.xxx is not a function`。此处自动 reload，无需手动按 Ctrl+R。
 */
function watchPreloadAndReload(win: BrowserWindow): void {
  const dir = join(__dirname, '../preload')
  let timer: NodeJS.Timeout | null = null
  try {
    fs.watch(dir, (_event, filename) => {
      // 只关心脚本产物，忽略目录自身与其他杂项
      if (filename && !/\.(js|jsc)$/.test(filename)) return
      if (timer) clearTimeout(timer)
      // 构建器写文件可能连续触发多次事件，去抖 300ms
      timer = setTimeout(() => {
        timer = null
        if (win.isDestroyed()) return
        console.log('[GrClean] preload 已更新，自动刷新窗口')
        win.webContents.reload()
      }, 300)
    })
  } catch {
    // 监听失败不影响正常使用（退化为按 Ctrl+R 手动刷新）
  }
}

/**
 * 正式打包后屏蔽刷新 / 开发者工具类快捷键，避免用户（或误触）调出检查工具。
 *
 * 三件事必须一起做，缺一件就有绕过路径：
 * 1) `Menu.setApplicationMenu(null)`：默认菜单的「View → Toggle Developer Tools」
 *    自带 accelerator，**菜单快捷键在主进程 native 层处理，`before-input-event`
 *    根本收不到**，所以必须先把菜单清掉；
 * 2) `webPreferences.devTools: false`：打包后彻底关掉 DevTools 支撑，
 *    连 `openDevTools()` 都失效，快捷键就算漏了也开不出来；
 * 3) `before-input-event` 黑名单：拦 Chromium 自己认的那些键（Ctrl+R / F5 /
 *    Ctrl+Shift+I / Ctrl+U 等）。它在按键送进渲染进程之前触发，`preventDefault()`
 *    才真的拦得住，渲染层的 keydown 拦不住这些。
 *
 * ⚠️ 只做**黑名单**，绝不能用白名单模式——否则会误伤输入框的复制粘贴
 * （本项目有反馈表单，Ctrl+C / V / X / A 必须照常可用）。
 */
function blockDebugShortcuts(win: BrowserWindow): void {
  Menu.setApplicationMenu(null)

  // 兜底：万一有别的途径（如远程调试端口）打开了，立刻关掉
  win.webContents.on('devtools-opened', () => {
    win.webContents.closeDevTools()
  })

  // 打包后页面内容禁止选中/复制（CSS 层见 main.css 的 html.no-copy），
  // 这里再堵住右键菜单这条路径：非输入区域不弹菜单，输入框保留粘贴等原生菜单。
  win.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) event.preventDefault()
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const combo = input.control || input.meta
    const k = input.key.toLowerCase()
    // 刷新 / 查看源码
    const nav = combo && (k === 'r' || k === 'u')
    // DevTools / 检查元素：Ctrl+Shift+I / J / C，以及部分平台上的 Ctrl+I
    const inspect = combo && (k === 'i' || (input.shift && (k === 'j' || k === 'c')))
    // F5 刷新 / F11 全屏（本窗口是固定尺寸工具窗，不该全屏）/ F12 开发者工具
    const fnKey = input.key === 'F5' || input.key === 'F11' || input.key === 'F12'
    if (nav || inspect || fnKey) event.preventDefault()
  })
}

function createWindow(): void {
  // Create the browser window（无边框，自定义窗口控制按钮）
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    // 设计上为固定尺寸的工具窗口：不支持最大化，仅允许最小化 / 关闭 / 手动拉伸
    minWidth: 1000,
    minHeight: 660,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    // 窗口标题兜底：页面 title 加载前生效；「未响应」时 DWM ghost 外框
    // 显示的标题也取自窗口标题（页面加载后会再被 <title>GrClean</title> 覆盖）
    title: 'GrClean',
    // 窗口 / 任务栏图标（Windows 与 Linux 均显式设置；exe 内嵌图标由打包配置负责）
    icon,
    // 预设底色：窗口创建到首帧渲染之间不再闪纯白，也能弱化卡顿时 DWM
    // 给「未响应窗口」绘制的白色 ghost 边框观感（根因是主线程阻塞，
    // 引擎已全部异步化，这里只是视觉兜底）
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 打包后关闭 DevTools 支撑：连 openDevTools() 也无效（开发期保持可用）
      devTools: is.dev,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发期快捷键：无边框窗口没有菜单栏，Ctrl+R / F5 默认无 accelerator 不会生效。
  // 而 preload 不随 Vite HMR 更新，改完 preload 必须刷新页面才能拿到新 api，
  // 因此这里显式接管刷新快捷键（F12 打开 DevTools 由 optimizer 负责）。
  if (is.dev) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      const isReload =
        (input.control && input.key.toLowerCase() === 'r') || input.key === 'F5'
      if (isReload && input.type === 'keyDown') {
        mainWindow.webContents.reload()
      }
    })
  }

  // 生产构建：屏蔽刷新 / 开发者工具相关入口（开发期全部保留，方便调试）
  if (!is.dev) blockDebugShortcuts(mainWindow)

  // 开发期自动刷新：preload 只在页面加载时执行一次，Vite HMR 不管它，
  // 所以改完 preload 必须刷新页面，否则会报 `window.api.xxx is not a function`。
  // 这里监听 preload 产物变化自动 reload，彻底消除手动刷新的遗漏。
  if (is.dev) watchPreloadAndReload(mainWindow)

  // 注册 IPC handlers（仅一次）
  if (!handlersRegistered) {
    registerHandlers(mainWindow)
    handlersRegistered = true
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  // 必须与 electron-builder.yml 的 appId 一致，否则任务栏图标 / 通知分组的归属会错乱
  electronApp.setAppUserModelId('com.graent.grclean')

  // 无界面清理模式：由 Windows 计划任务以
  // `<exe> --privacy-clean --schedule-id <id>` 启动，
  // 执行完清理后直接退出，全程不创建窗口。
  if (process.argv.includes('--privacy-clean')) {
    const i = process.argv.indexOf('--schedule-id')
    const scheduleId = i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
    try {
      await runPrivacyCleanupBySchedule(scheduleId)
    } catch (e) {
      console.error('[GrClean] 定时隐私清理执行失败:', e)
    }
    app.quit()
    return
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
