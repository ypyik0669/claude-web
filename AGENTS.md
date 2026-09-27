# AGENTS.md

本仓库的项目说明、架构和踩坑记录都在 [CLAUDE.md](CLAUDE.md)。开始任何改动前先完整读一遍它。

最常用的命令：

```
npm install
npm run typecheck      # server + web + desktop
npm test               # vitest（server + web）
npm run build:all
npm run e2e            # 用临时 HOME 起 server，跑不花 token 的 WebSocket 端到端检查
```
