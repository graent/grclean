<h1 align="center">GrClean</h1>

<p align="center">An Electron application with Vue3 and TypeScript for Windows cleaning & optimization</p>

<p align="center">
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/electron" alt="electron-version">
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/electron-vite" alt="electron-vite-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/electron-builder" alt="electron-builder-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/vite" alt="vite-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/vue" alt="vue-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/typescript" alt="typescript-version" />
</p>

<p align='center'>
<img src='screenshots/overview-dark.png'/>
</p>

## Features

GrClean is a free, open-source Windows cleaning & optimization tool. It is built as a native Electron desktop client talking to a lightweight PHP backend for version/update and content delivery.

Core capabilities:

- 🧹 **Junk cleaning** — system, browser and app caches, temp files, with safe default scope rules.
- 💬 **Social-app cleaner** — WeChat / QQ / WeCom and more: clean cached images, files and temp data. Chat history is **never touched** (one of our hard promises).
- 📦 **Big-file analysis** — find the largest files on each disk to reclaim space.
- 👯 **Duplicate finder** — locate identical files by hash and remove the redundant copies.
- 🚀 **Startup manager** — review and disable unwanted startup items.
- 🗑 **Uninstall residue** — detect leftovers after software uninstallation.
- 🧩 **Registry cleaner** — cautious, rule-based registry cleanup (heuristic, never over-aggressive).
- 💿 **Installer cleanup** — remove orphaned installer/setup leftovers.
- 📜 **Log cleanup** — trim OS and app logs that grow over time.
- 💽 **Disk & driver management** — per-disk view, SMART health overview, driver inventory.
- 🩺 **Health score** — a weighted PC health rating with clear, actionable advice.
- 🔄 **Migrate / move** — relocate bulky folders to another drive.
- ⚡ **System optimize** — one-click tweaks for a snappier system.
- 🪶 **Slim** — strip optional Windows components you don't need.
- 🕑 **Scheduled tasks** — browse and manage Windows Task Scheduler entries.
- 🖱 **Context-menu manager** — add/remove right-click menu items.
- ♻ **Recycle-bin manager** — list and clean recycle-bin items.
- 🔧 **Software uninstall** — built-in uninstall with residual scan.
- 📸 **Snapshot** — save/restore system state points.
- 📋 **Rules** — customizable cleaning rules.
- 🎨 **8 themes** and a **global font-scale** setting.
- 🌐 **9 built-in languages** (zh-CN / en-US / zh-TW / ja / ko / fr / de / es / ru).

## Screenshots

Overview (Home) — health score, system info and the 11-factor scoring breakdown:

<table>
  <tr>
    <td width="50%"><img src="screenshots/overview-light.png" alt="GrClean overview — light theme"/></td>
    <td width="50%"><img src="screenshots/overview-dark.png" alt="GrClean overview — dark theme"/></td>
  </tr>
  <tr>
    <td align="center"><sub>薄荷青 · Light</sub></td>
    <td align="center"><sub>暗夜青柠 · Dark</sub></td>
  </tr>
</table>

### Themes

8 built-in themes with one-click switching (accents apply to the window chrome and controls only, default is 晴空蓝):

<p align="center">
  <img src="screenshots/theme-picker.png" width="640" alt="GrClean theme picker — 8 themes"/>
</p>

The same view in a few more themes:

<table>
  <tr>
    <td width="50%"><img src="screenshots/overview-sage.png" alt="GrClean overview — sage theme"/></td>
    <td width="50%"><img src="screenshots/overview-peach.png" alt="GrClean overview — peach theme"/></td>
  </tr>
  <tr>
    <td align="center"><sub>鼠尾草 · Sage</sub></td>
    <td align="center"><sub>蜜桃粉 · Peach</sub></td>
  </tr>
</table>

## Tech Stack

- **Electron** 28
- **Vue 3** + **TypeScript** 5
- **Vite** 5 via **electron-vite** 2 (main / preload / renderer in one project)
- **electron-builder** 24 (NSIS installer + portable build, Windows x64)
- **Lucide** icons

## Project Setup

### Install

```bash
npm install
```

> The `postinstall` script runs `electron-builder install-app-deps`. On Windows it also pulls the Electron binaries from the configured mirror (see `.npmrc`).

### Development

```bash
npm run dev
```

### Type checking

```bash
npm run typecheck
```

### Build

```bash
# Windows installer + portable (unsigned)
npm run build:win

```

Build artifacts land in `dist/` (git-ignored).

### Code signing (Windows)

`electron-builder.yml` is pre-configured with `signingHashAlgorithms: [sha256]` and a DigiCert RFC3161 timestamp server. To produce a signed build you need an OV/EV code-signing certificate; supply it via one of:

- `win.certificateSubjectName` / `win.certificateSha1` (certificate store or EV token), or
- `CSC_LINK` (+ `CSC_KEY_PASSWORD`) pointing to a `.pfx`.

Run `npm run sign:check` to verify the signing environment before building.

## Project Structure

```
src/
  main/        Electron main process (engine/, ipc/, index.ts)
    engine/    Pure TS+Node scan/clean engines (streaming generators)
    ipc/       IPC handlers (scan-*:start streams + one-shot handles)
  preload/     Preload bridge (typed window.api, safe wrappers)
  renderer/    Vue 3 UI (views/, components/, stores/, assets/)
build/         App icons + macOS entitlements
resources/     Bundled assets (e.g. windows-trash helper)
scripts/       Build/release helpers (sign check, icon gen, font scaling)
```

## Download & Links

- Official site: <https://gr.graent.cn/grclean>
- Latest releases: the GitHub **Releases** page (installer `.exe` + portable `.exe`).

## Donate

If GrClean helped you out, you can **buy the author a cup of milk tea** 🧋. Donations are completely voluntary and never affect any feature.

### Payment QR codes

<table>
  <tr>
    <td width="50%" align="center"><img src="screenshots/wx.jpg" width="220" alt="WeChat Pay QR code"/></td>
    <td width="50%" align="center"><img src="screenshots/zfb.jpg" width="220" alt="Alipay QR code"/></td>
  </tr>
  <tr>
    <td align="center"><sub>微信收款码 · WeChat Pay</sub></td>
    <td align="center"><sub>支付宝收款码 · Alipay</sub></td>
  </tr>
</table>

### Community

<table>
  <tr>
    <td width="50%" align="center"><img src="screenshots/gzh.jpg" width="220" alt="Official WeChat account QR code"/></td>
    <td width="50%" align="center"><img src="screenshots/qq.jpg" width="220" alt="QQ group QR code"/></td>
  </tr>
  <tr>
    <td align="center"><sub>微信公众号 · Official Account</sub></td>
    <td align="center"><sub>QQ 交流群 · QQ Group</sub></td>
  </tr>
</table>

## License

GrClean is free to use for **non-commercial purposes**, including but not limited to **personal use, educational use, and security research**. Copyright © Graent. All rights reserved.

The following restrictions apply — by using or obtaining this software you agree to them:

- 🚫 **No commercialization** — you may **not** use it for any commercial purpose, including but not limited to selling, reselling, bundling, or any other paid or commercial activity.
- 🚫 **No redistribution (secondary distribution prohibited)** — you may **not** re-publish, mirror, or make it available through any other channel.
- 🚫 **No removal or tampering** — you may **not** remove, obscure, or modify any copyright notice, author information, or integrity/verification information (including the embedded file-integrity checks) in the software or this repository.

For commercial licensing or any form of cooperation, please contact the author directly.

Suggestions and improvement ideas are always welcome — feel free to open an issue or reach out.

> This project is distributed without a separate `LICENSE` file; the terms above constitute the license.
