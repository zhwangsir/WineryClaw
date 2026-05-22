# WeBrain Desktop — Tauri Shell

> v2.27 (2026-05-22) — 跨平台桌面壳。本目录把 WeBrain 双脑包成桌面应用,
> macOS .app 已发布,Linux .deb/.AppImage 由 CI `desktop-linux` 工作流持续验证。
> Windows 待 owner。
>
> **当前测试**: 3 unit tests (service_manager) + 1 CI 工作流 (cargo check / clippy / fmt / test --lib)。

## 架构

```
Tauri main process (Rust)
  ├─ webview → frontend (vite dev :8587 / packaged dist)
  └─ ServiceManager 监管:
      └─ sub-brain (pnpm dev, port 3000)
          └─ 内部自动 spawn main-brain (Python venv,UDS /tmp/webrain-main.sock)
```

> **为什么不直接 Tauri spawn main-brain？** sub-brain 内部 `main-brain-spawn.ts` 已经做过
> Python 解释器探测 + venv 选择 + 失败 fallback 警告。Tauri 再 spawn 会双进程。
> ServiceManager 已经把 main-brain spawn 代码保留但用 `#[allow(dead_code)]` 注掉,
> 后续若决定走 Tauri-supervised main-brain（更紧的生命周期控制）就 uncomment。

## 前置依赖

- **Rust 1.77+**：`rustup default stable`（项目实测 1.95.0 通过）
- **Node 22+ / pnpm**：跟 webrain-integration root 共用
- **macOS**: 系统自带 WebKit,无需额外安装
- **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **Windows**: Microsoft Edge WebView2 Runtime

## 命令

```bash
# 在 desktop/ 下:
pnpm install            # 装 @tauri-apps/cli
pnpm check              # cargo check — 验证 Rust 端编译通过(不启动 webview)
pnpm dev                # cargo tauri dev — 启动开发模式(vite + webview)
pnpm build              # cargo tauri build — 打包 dmg/msi/AppImage

# 直接 cargo（绕过 tauri-cli）:
cd src-tauri && cargo check
cd src-tauri && cargo build --release
```

## 当前状态(v2.27)

- ✅ Cargo.toml + tauri.conf.json + main.rs + lib.rs + service_manager.rs
- ✅ capabilities/default.json（Tauri 2.x ACL）
- ✅ ServiceManager v0.2 — PATH 解析(Homebrew/Volta/NVM/pnpm 直装) + 日志重定向
      (`~/Library/Logs/WeBrain/` / `~/.local/state/WeBrain/`) + 端口探测 +
      health-wait + SIGTERM/SIGKILL graceful shutdown
- ✅ Single-instance lock (tauri-plugin-single-instance) — 二次启动焦点
- ✅ Popup 锚定 tray 屏幕位置(LogicalPosition)
- ✅ 主窗口启动隐藏直到 /health pass(避免 ERR_CONNECTION_REFUSED 白屏)
- ✅ CI `desktop-linux` 工作流: cargo check / fmt / clippy(-D warnings) / test --lib
- ✅ macOS .app 已 v2.25 硬化(6 个真实启动 bug 全修)
- ✅ Linux 跨平台代码就绪 (nix gated cfg(unix); dirs 跨平台路径; PATH 含 Linux 装路径)
- ⏳ 真实 `tauri build` 端到端验证 dmg/deb/AppImage(本地 sips/cargo tauri build 可跑出,CI 暂不每 PR build 节省时间)
- ⏳ macOS notarization / Windows signing(待 owner)

## 生成图标

Tauri 要求 `icons/icon.png` 至少 512×512 RGBA。临时占位:

```bash
# macOS 自带 sips:
sips -z 1024 1024 ../../frontend/public/favicon.svg --out icons/icon.png

# 或用 imagemagick:
convert -size 1024x1024 xc:'#2383e2' icons/icon.png
```

然后用 tauri CLI 自动生成 macOS .icns / Windows .ico:
```bash
pnpm tauri icon icons/icon.png
```

## 未来工作（keeper 推进）

1. **生产打包** — 真跑通 `cargo tauri build`,产出 dmg/msi/AppImage
2. **macOS notarization** — Apple Developer 账号 + xcrun notarytool
3. **自动更新** — tauri-plugin-updater
4. **托盘菜单** — tauri-plugin-systray + 双脑健康指示器
5. **打包 sub-brain 为 sidecar** — `externalBin` 把 pnpm install 后的 sub-brain 嵌入
6. **Python venv 嵌入** — 用 PyInstaller 把 main-brain 打包成单文件 binary
