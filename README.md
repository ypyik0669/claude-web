# Claude Web

Claude Code CLI 的可视化工作台：对话、工具调用、权限审批、文件 / Git / 编辑器、多窗格布局，外加 Codex / Gemini 等其它 CLI agent。
一个本地 Node 服务驱动 Claude Code（`@anthropic-ai/claude-agent-sdk`），前端通过 WebSocket 实时渲染；也可以打包成桌面应用（Windows / macOS）。

## 安装桌面版

从 [Releases](../../releases) 下载：

| 平台 | 文件 |
| --- | --- |
| Windows | `ClaudeWeb-<ver>-win-x64.exe`（安装版）或 `ClaudeWeb-<ver>-portable.exe` |
| macOS Apple Silicon | `ClaudeWeb-<ver>-mac-arm64.dmg` |
| macOS Intel | `ClaudeWeb-<ver>-mac-x64.dmg` |

**macOS 首次打开**：安装包没有 Apple 签名，第一次需要在「应用程序」里对 Claude Web **右键 → 打开**；
如果提示「已损坏」，在终端执行一次：

```bash
xattr -cr "/Applications/Claude Web.app"
```

使用前需要本机已登录 Claude Code（`claude login`，登录态放在 `~/.claude`），或在 设置 → 供应商 里配置 API 档案。

## 从源码运行

需要 Node.js 22+。

```bash
npm install
npm run build
npm start            # http://127.0.0.1:3090
```

开发：`npm run dev`（server 热重载 + Vite :5173）。

## 检查

```bash
npm run typecheck    # server + web + desktop
npm test             # 单元测试
npm run build:all
npm run e2e          # 端到端（临时 HOME，mock agent，不花 token）
```

## 打包

```bash
npm run build:desktop        # Windows（在 Windows 上）
npm run build:desktop:mac    # macOS（只能在 macOS 上）
```

推送 `v*` tag 时 GitHub Actions（`.github/workflows/release.yml`）会同时构建 Windows、macOS arm64 与 x64，并发布到 Releases。

开发文档见 [CLAUDE.md](CLAUDE.md)。
