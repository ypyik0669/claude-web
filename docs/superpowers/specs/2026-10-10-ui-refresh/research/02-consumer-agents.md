# 02 · 消费级 / 通用型 Agent 产品 UI 调研（给 claude-web 改版用）

调研日期：2026-10-10。只读调研，没有改仓库，没有登录任何产品。

## 0. 方法与可信度标注

- **【V】= VERIFIED**：我亲自从公开页面 / 公开 CSS / 截图 / 官方文档里读到的，后面跟来源键（见 0.1）。
- **【I】= INFERRED**：从证据推出来的，或只有二手描述、没法逐条核对的。
- 公开 CSS 的读法：直接取页面 HTML → 列出 `<link rel=stylesheet>` 和入口 JS 里引用的懒加载 CSS → 在内存里统计 `font-family` / `@font-face` / `border-radius` / 颜色 / `@keyframes` / `transition`，再按选择器把规则原文读出来。脚本在 `scratchpad/research/tools/`（`cssprobe.mjs`、`siteprobe.mjs`、`sitegrep.mjs`），只发 GET，不落盘。
- 截图来自 Mobbin（低清预览，能看清布局和文案，量不准像素；凡是从截图估的尺寸都标【I】）。
- **没拿到的**（如实说）：
  - 知乎全部 403（Kimi Agent 集群实测、Kimi Work 评测两篇只拿到搜索摘要）。
  - Genspark、Perplexity、Lovable 首页被 Cloudflare 挡（403），没读到它们自己的 CSS；Perplexity / Lovable 用 Mobbin 截图 + shadcn.io 的第三方 token 拆解补，Genspark 只有评测文字。
  - DeepSeek 网页版返回 202 挑战页，没读到 CSS，只有第三方拆解。
  - Kimi 的知乎 / B 站视频里的动图没法看；Kimi 手机 App 的界面细节基本没找到。
  - 各家 `/`、`@` 菜单的长相大多只有文字描述（Kimi 的有 CSS）。
  - Mobbin 没收录 Kimi、Genspark、Flowith、豆包、千问、元宝等。

### 0.1 来源键

| 键 | 来源 |
| --- | --- |
| K-html | https://www.kimi.com/ （HTML，`<html class="light" data-font-size="default">`，`theme-color #fbfaf9`） |
| K-main | https://statics.moonshot.cn/kimi-web-seo/assets/index-CicIFS8X.css （353 KB，全局 token + 侧栏 + 工具步骤） |
| K-home | https://statics.moonshot.cn/kimi-web-seo/assets/Index-DFAHkPBT.css （202 KB，首页 / 对话页） |
| K-chat | https://statics.moonshot.cn/kimi-web-seo/assets/Chat-B5Qibn2t.css （输入框外壳、发送键） |
| K-bar | https://statics.moonshot.cn/kimi-web-seo/assets/useStickyStuck-CZS0ELkA.css （输入框工具行：模式 chip、模型菜单、@ 菜单） |
| K-side | https://statics.moonshot.cn/kimi-web-seo/assets/kimi-MlVzeWWV.css （右侧 side-console、任务 dock） |
| K-menu | https://statics.moonshot.cn/kimi-web-seo/assets/kimi-w4WvLuEo.css （菜单） |
| K-misc | 同目录下 `RunningText-B5atj1q7.css`、`kimi-98e6y0rP.css`（loading）、`Tooltip-3QXsTlMN.css`、`BubbleTabs-CyFg1k33.css`、`FileView-F0N4eoyG.css`、`kimi-BJZTp_Sw.css`（chat-input） |
| K-js | https://statics.moonshot.cn/kimi-web-seo/assets/index-CXvv4AYB.js （入口 JS，2.6 MB：图标描边、Rive / APNG 资源名、153 个懒加载 CSS 名） |
| K-code | https://www.kimi.com/code + `KimiCodeHome-CXlbFDns.css`（Kimi Code 落地页和桌面版 mock） |
| K-work | https://www.kimi.com/zh-cn/help/kimi-work/overview ；https://www.kimi.com/academy/kimi-work-getting-started ；https://www.kimi.com/zh-cn/help/kimi-work/dashboard ；https://www.kimi.ai/help/kimi-work/release-notes |
| K-codenews | https://www.kimi.com/code/docs/kimi-code/whats-new.html |
| K-agent | https://www.kimi.com/zh-cn/help/agent/agent-overview |
| K-news | https://news.qq.com/rain/a/20260604A07RSI00 ；https://ai-bot.cn/kimi-work/ ；https://aitoolanalysis.com/kimi-ai-review/ ；https://www.readaitime.com/kimi |
| M-css | https://manus.im/ （HTML + 10 个 CSS，1.2 MB） |
| M-mob | Mobbin Manus 截图：[项目页](https://mobbin.com/screens/a632d5fa-2a08-4e5d-a7db-371baf0551a1)、[任务完成](https://mobbin.com/screens/0f0a51a4-a51f-4726-9f9e-b85123e701fd)、[交付物 + 步骤](https://mobbin.com/screens/c70c43d2-4f48-465d-b20b-65e118a57dce)、[toast](https://mobbin.com/screens/db51dd55-0e37-4edd-a20c-c0308ad42760)、[iOS 的 Manus's computer](https://mobbin.com/screens/56d6772c-7cc1-4e95-9ae5-38db54257169) |
| M-rev | https://medium.com/design-bootcamp/i-asked-an-manus-ai-to-evaluate-itself-heres-what-happened-69c90a148e80 ；https://blog.naaln.com/2025/03/Manus/ ；https://www.53ai.com/news/LargeLanguageModel/2025032085240.html ；https://workos.com/blog/introducing-manus-the-general-ai-agent |
| LV-mob | Mobbin Lovable：[对话 + 预览](https://mobbin.com/screens/dba17e8e-ea03-43ae-af65-caa018e948ff)、[版本卡 + toast](https://mobbin.com/screens/045dc5db-fcf4-4992-a7e0-ccd65e0cc2df)、[启动预览](https://mobbin.com/screens/b1bb2a2b-bef4-47bf-9bf0-cda62c653e98)、[回退确认](https://mobbin.com/screens/94b4bb69-45ad-4ca0-934b-a03e1e33a880) |
| LV-tok | https://www.shadcn.io/design/lovable （第三方 token 拆解） |
| RP-css | https://replit.com/ （HTML + CSS 2.1 MB） |
| RP-mob | Mobbin Replit Agent：[构建中](https://mobbin.com/screens/20a3ac62-d3ef-4bd1-9feb-235af79faa5c)、[检查点](https://mobbin.com/screens/db12ba2a-801c-486f-a842-2fd2dd7feba1)、[追问](https://mobbin.com/screens/2eb0b11e-62dc-43fc-a715-d6b520d145e6)、[文件栏](https://mobbin.com/screens/198661e0-96d5-4073-9ba7-797ee5df334b) |
| DV-css | https://app.devin.ai/ （登录页带的 app CSS 490 KB）；https://devin.ai/ （官网） |
| DV-mob | Mobbin Devin：[Worklog](https://mobbin.com/screens/1a6ad6ee-a724-4fe4-bfb8-0fcb80f98aeb)、[Ask](https://mobbin.com/screens/879ce37f-028e-4ddd-81d7-9822505e5d0b)、[会话分析](https://mobbin.com/screens/769b3371-28a2-43ea-8d0f-f9e4ae23e274)、[Shell](https://mobbin.com/screens/f7e9f607-dc8f-49ab-b42e-26f9270fd31b) |
| PX-mob | Mobbin Perplexity：[回答 + 反馈](https://mobbin.com/screens/f1f7b09b-6fad-49fe-9eb5-032b808f6188)、[来源侧栏](https://mobbin.com/screens/c076f584-8c70-4980-8539-35340238cc32)、[Computer 任务](https://mobbin.com/screens/f8838e0b-1127-444d-80a1-e76f309c4030)、[分享](https://mobbin.com/screens/7109e92b-a64e-4a43-8305-f986f1e773a9) |
| PX-tok | https://www.shadcn.io/design/perplexity （第三方 token 拆解）；Labs：https://www.aifire.co/p/the-complete-perplexity-labs-guide-master-ai-research-fast 、https://dev.to/dr_hernani_costa/perplexity-labs-from-idea-to-app-in-one-prompt-437 |
| V0 | https://v0.app/ （CSS）；https://v0.app/docs/versions ；https://v0.app/docs/design-mode |
| BT | https://bolt.new/ （CSS）；https://www.shadcn.io/design/bolt-new ；https://support.bolt.new/building/using-bolt/rollback-backup |
| DB | https://www.doubao.com/chat/ （CSS 450 KB）；https://www.cnblogs.com/WindrunnerMax/p/19104743 ；https://www.ruanyifeng.com/blog/2025/06/doubao-ai-coding.html ；https://www.163.com/dy/article/L4QID6CU0511CPVM.html |
| QW | https://chat.qwen.ai/ （内联 CSS）；https://www.qianwen.com/ （HTML）；https://venturebeat.com/ai/qwens-new-deep-research-update-lets-you-turn-its-reports-into-webpages |
| DS | https://aiuxplayground.com/teardowns/deepseek/composer/ ；https://oh-my-design.kr/design-systems/deepseek ；https://deepseekai.guide/guides/deepseek-chat/ |
| MM | https://agent.minimax.io/ （CSS 645 KB）；https://agent.minimax.cn/docs/changelog |
| ZA | https://chat.z.ai/ （CSS 436 KB）；https://iseoai.com/z-ai/ ；https://aijet.cc/item/zai-chat-chatzai |
| CZ | https://www.coze.cn/ （space.coze.cn 跳到这里，CSS 980 KB）；https://www.woshipm.com/ai/6214504.html ；https://k.sina.com.cn/article_1667925927_636a87a70190160wg.html |
| YB | https://yuanbao.tencent.com/ （CSS 1.1 MB） |
| MT | https://metaso.cn/ （HTML + CSS） |
| FL | https://flowith.io/ （CSS 560 KB）；https://www.eesel.ai/blog/flowith-review ；https://www.therundown.ai/tools/flowith |
| LA | https://www.lovart.ai/ （CSS 366 KB）；https://www.lovart.ai/blog/02-wiki-chatcanvas-guide |
| GS | https://www.lindy.ai/blog/genspark-review ；https://www.genspark.ai/docs/ai_slides_changelog ；https://www.blogwithben.com/genspark-ai-slides-developer-chat-2026/ ；https://templytic.com/genspark-super-agent-review-calls-slides/ |

---

## 1. Kimi（kimi.com）——重点

### 1.1 「Kimi Work」到底是什么

- 【V】Kimi Work 是月之暗面 2026-06-03 随 Mac / Windows Beta 客户端发布的**本地通用 Agent**，面向知识工作者；它是 Kimi 桌面客户端里和「Chat」并列的「Work」模式，底层是 Kimi Code 的内核。（K-news、K-work）
- 【V】Work 模式左栏八个入口：**新建任务 · 看板 · 插件 · 技能 · 定时任务 · WebBridge · 项目 · 对话**；输入框 placeholder「开始工作，或创建个任务...」，旁边一个「+」；`/` 调技能（菜单里有「目标」、`plugin-builder` 和已装插件），`@` 加上下文（本地文件 / 文件夹）；可切「Agent / Agent 集群」（集群最多 300 个子 Agent）。（K-work）
- 【V】权限三档：**手动批准 / 默认 / 全自动**（默认 = 常规操作自动，改写本地文件、跑代码等敏感操作先问）。（K-work）
- 【V】近期交互更新（发布日志）：
  - 3.2.15（09-30）：**Agent 执行过程默认收起，只显示最终回复**；左栏项目可拖动排序。
  - 3.2.1（08-21）：Agent 回答时**新消息自动排队**，队列里可拖动排序 / 编辑 / 删除；全局快捷键唤出**悬浮输入胶囊**；麦克风听写。
  - 3.2.0（08-19）：浏览器标签页绑定到对话、住在**预览窗格**里；看板作为一种预览窗格类型，可并排开多个。
  - 3.2.11（09-18）：详情面板能看子 Agent 的执行过程。
  - 3.2.14（09-24）：对话里选中文字可**引用进新消息**；Office 文件有版本历史。
  - 3.2.12（09-22）：在 PPT / Excel / Word / Markdown 预览里**选中内容提精确修改**。
  - 3.2.5（09-04）：手机远程控制桌面上的 Kimi Work。
  - 退出 / 退出登录时如果还有任务在跑会先确认。
- 【V】看板 / 小组件：小组件是模型在对话里现场生成的可交互页面；看板最多 20 个小组件，可拖动、缩放；「批注」模式下点小组件里的元素建一条**位置批注**当修改意见；小组件可「固定至桌面」成独立窗口；对话里的看板卡片点一下在**右侧视窗**打开。（K-work）
- 【V】命名演变：「OK Computer」（2025-09 的 Agent 模式）这个名字到 2026 年中已经不用了，现在是 Agent / Agent 集群（Swarm）/ Claw / Kimi Work 四个面；但 CSS 里还留着 `.side-console-rail.ok-computer`、`.okc-continue-tip`、`.okc-cards-container` 这些类名。（K-news、K-side、K-home）

### 1.2 布局与外框

- 【V】整页底色 `--Bg-GroundPC: #fbfaf9`（暖白，也是 `theme-color`），**侧栏和整页同色**，没有分隔线。（K-html、K-main）
- 【V】主区域是**浮在底色上的一张白卡**：`.app.has-sidebar .main { margin:6px; background:#fff; border:1px solid var(--Fills-F2) /*5% 黑*/; border-radius:12px; overflow-y:auto }`。（K-main）
- 【V】侧栏 `.next-sidebar { width:240px; background:var(--Bg-GroundPC) }`。（K-main）
- 【V】当前线上导航（2026-10）：**新建会话（Ctrl K 键帽）· 我的 Kimi · 插件 · 定时任务 · 灵感库 · PPT · 深度研究 · 文档 · 更多**，下面一节「项目」；英文版是 New chat / My Kimi / Plugins / Scheduled / Inspiration / Slides / Deep Research / Docs / More / Projects。（K-html，https://www.kimi.com/en）
- 【I】业主截图是 K2.6 时期的（Websites / Sheets / Agent Swarm / Kimi Code / Kimi Claw 各一行）；现在这些大概收进了「更多」和模型选择（K3 / K3 集群），我没登录所以没点开「更多」核对。
- 【V】侧栏可自定义：CSS 里有 `.customize-sidebar__row`、`.customize-sidebar__row-drag-chip`、`.next-sidebar__drag-ghost`、`.next-sidebar__drag-slot`（拖动排序入口）。（K-main）
- 【V】右侧面板 `side-console`：`.side-console-rail { flex:0 1 0; max-width:var(--side-console-width) }`，打开时 `flex-basis` 过渡 `.3s ease-in-out`，左边 `.5px` 发丝线；可全屏（`side-console-full-screen`）。≤ 840px 变成**底部抽屉**：`border-radius:20px 20px 0 0`，从 `translateY(100%)` 滑上来，背后 `--MaskBg-Dark`（60% 黑）。（K-side）
- 【V】文件预览头部：`.generic-header { height:52px; padding:0 10px; font-size:16px; gap:8px }`，标题最多 180px 省略，左右各一组 4px 间距的图标按钮（业主截图里的 返回 / 下载 / 关闭 就在这一行）。（K-misc: FileView）

### 1.3 侧栏的每一种行

全部来自 K-main，【V】：

| 元素 | 规则 |
| --- | --- |
| 导航行 `.next-sidebar-nav-item` | 高 36px，圆角 10px，内容 `gap:6px; padding:0 8px`，图标 18px，字 14/20、400；hover `--Fills-F1`（3% 黑），选中 `--Fills-F2`（5% 黑），过渡 `background-color .15s, color .15s, box-shadow .15s` |
| 键盘焦点 | `box-shadow: inset 0 0 0 2px var(--Labels-Primary)`（内描边，不是外轮廓） |
| 新建会话 `.new-chat-btn` | 一张小卡：`.5px` 边 + 白底 + 圆角 12px，`min-height:40px; padding:10px 8px`，文字 500；hover 才出阴影 `0 3px 10px #0000001a` |
| 键帽 `.meta` | `min-width:20px; height:20px; border-radius:4px; background:var(--Fills-F2); color:var(--Labels-Tertiary)` |
| 历史行 `.next-sidebar-history-item` | 高 36px，圆角 12px，hover / 菜单打开时 3% 黑；「···」悬停才出 |
| 分节标题 `.next-sidebar-section__title` | 高 28px，圆角 8px，14/20，颜色 Tertiary；可折叠的悬停变 Secondary，箭头悬停才出 |
| 行尾徽标（Beta 之类）`.next-sidebar-nav-item__badge` | `background:#1783ff1a; color:#1783ff; border-radius:4px; padding:1px 4px; font:12px/18px` |
| 套餐徽标 `.membership-plan` | 高 20px，**黑底白字**（`--Labels-Primary` 底），圆角 4px，12/18 |
| 加载骨架 | `next-sidebar-history-skeleton-pulse` / `…loading-pulse` 两个 keyframes |
| Claw 区 | `.next-sidebar-claw__room`（房间行带头像）、`.next-sidebar-claw__unread-badge`（20px 高蓝色淡底数字） |

### 1.4 首页 / 空状态

- 【V】会动的字标是一个 **SVG「make3d-doodle-logo」**：四个字母各一组（`.L0`–`.L3`），每个字母有 `.q`（正面）、`.back`（背面描边）、`.ray`（连线），用 `@property --kimi-g / --kimi-i0..3 / --kimi-h0..3`（注册成 `<number>` 的自定义属性）驱动 `transform: translate() scale(1 + .063 × …)`，把平面字**挤出成 3D 涂鸦**。入场 `.661s`、各字母延迟递增（看到 `.54s`、`.61s`），缓动是一条 40 个采样点的 `linear(0, .0254, .0851, …, 1)` 弹簧曲线（不支持时退回 `cubic-bezier(.2,.8,.2,1)`）；悬停每个字母单独弹（`--kimi-h*` 过渡 `.637s`）；离场有 `-rev` 版；`prefers-reduced-motion` 下不动。宽度 `48.28%`、最大 193px，下边距 32px。（K-home）
- 【V】另有 Rive：入口 JS 引用 `kimi_avatar_web-PnsTWI-X.riv`（对话里那个**头像小团子**是 Rive 动画），CSS 有 `.rive-container`、`.rive-doodle-placeholder.is-ready / .is-entering`。（K-js、K-home）
- 【V】输入框下面的「探索灵感」入口 `.home-inspiration-entry`：胶囊（圆角 34px，`padding:8px 16px`，16/24，Tertiary 色），悬停变**金色**（`#d0ab27` 字 + `#ffcc151a` 底 + `backdrop-filter:blur(30px)`），灯泡图标从灰切到彩，右边小箭头有 `home-inspiration-chevron-pulse`；按下 `transform:scale(.96)`。（K-home）
- 【V】首页还有案例卡（`.show-case-card`、`.gallery-card`，圆角 16 / 20px 居多）、新手浮卡 `.onboarding-float-card`（`onboarding-float-card-enter`）、首页横幅 `.home-banner`（`home-banner-content-fade-in`）。（K-home）
- 【I】业主截图里的「Featured Agent cases」大圆角卡对应 `.show-case-card` / `.gallery-card`（类名和圆角分布吻合，没看到截图本身）。

### 1.5 输入框（最值得照抄的一块）

- 【V】外壳 `.chat-editor`：`max-width:768px; border-radius:24px; padding:8px; background:#fff; border:1px solid #00000021; box-shadow:0 5px 16px -4px #00000012`；hover 边框加深到 `#0000002c`；`:focus-within` 再叠一层 `0 4px 12px #00000008`。**没有彩色焦点环**。（K-chat）【业主估 28px，实际是 24px】
- 【V】编辑区 `.editor-wrapper { padding:4px 8px 10px; font-size:16px; line-height:24px }`，最高 170px 后内部滚动；`.chat-input { min-height:60px }`；placeholder 16px、Tertiary 色（45% 黑）。（K-chat、K-misc）
- 【V】底部一行 `.chat-editor-action`：左右两组，组内 `gap:8px`，`align-items:flex-end`。（K-chat）
- 【V】**模式 chip**（业主说的「Agent」胶囊）`.tool-switch`：高 36px，圆角 20px，`padding:0 10px 0 8px`，图标 18px + 文字 14px、`gap:4px`；只有图标时是 36×36 圆。打开态 `.tool-switch.open`：**文字和图标变蓝**（`--agent-accent`，默认 `#1783ff`），底色透明，hover 才出 `#1783ff1a` 的蓝色淡底、按下再深一点。`.showClose` 变体：悬停时左边图标换成 ×（点一下就关掉这个模式）。图标可以是动画（`.animation-icon-wrapper`）。（K-bar）
- 【V】其它选择器 chip `.selector-trigger`：36px 高、圆角 20px、`padding:8px`，hover 3% 黑；选中态可以是**紫色**（`#985ffb` 字 + 10% 紫底，`color-mix`）。（K-bar）
- 【V】**模型选择** `.current-model`：圆角 20px，`padding:8px 12px`，模型名 Primary 色、后面跟一个 Tertiary 色的**当前档位**（`.current-effort`，`margin-left:4px`）——就是「K2.6 Agent · 档位」这种写法；hover / 打开时 3% 黑底。菜单项 `.model-item`：圆角 10px、`padding:8px`；档位是菜单里的一行 `.effort-item`（标题在左，当前值 + 箭头在右）展开成 `.effort-option`（名字 + 一句说明）。模型行右侧还有一个 24px 宽的 `moon-phase-canvas`（**月相**小画布——【I】用月相表示模型 / 档位强弱，呼应 Moonshot）。集群有一条引导 `.model-swarm-guide`。（K-bar）
- 【V】**发送键** `.send-button-container`：`padding:4px` + 28px 图标 = 36px 圆，`border-radius:22px`；可发送 = `--Labels-Primary`（90% 黑）底、白箭头；空 = `--Fills-F3`（15% 黑）底；运行中 `.stop` = 同样的黑底 + 方块；还有 `.loading`（`loading-pure` 锥形渐变转圈）和 `.new-chat` 变体（36px 高的胶囊，带文字「新会话」，500）。过渡 `background-color .15s cubic-bezier(.4,0,.2,1)`。（K-chat、K-bar）
- 【V】附件 / 引用 chip `.part-annotation-chip`：`background:var(--Fills-F1); border-radius:12px; padding:6px 10px; font:13px/20px; gap:6px`，可带 22×22 缩略图（圆角 4px、`.5px` 边），名字 500、最长 160px，后面灰色摘要，末尾 ×。文件卡 `.file-card-container`：`min-height:56px`、3% 黑底。（K-bar、K-main）
- 【V】`@` 选文件菜单 `.file-selection-menu`：宽 200px、最高 256px、圆角 16px、`padding:8px`、阴影 `0 2px 10px 2px #0000001a`。`/` 技能 / 插件建议面板 `.function-suggestion-panel`：行圆角 12px、`padding:8px`、图标 + 名字 + 蓝色小标签。输入框里的技能 / 插件 / 目标是**内联节点**（`.skill-node`、`.plugin-node`、`.goal-node`、`.mention-node`）。（K-bar、K-main）
- 【V】输入框**上方**的三种「状态胶囊」，同一套样式：`goal-info-bar`（目标）、`outbox-queue`（排队的消息）、`swarm-status-panel`（集群状态）：`background:var(--Fills-F1); backdrop-filter:blur(30px); border-radius:12px; padding:8px 12px; width:fit-content`，hover 加深；集群面板展开后变成 `border:.5px; border-radius:20px; background:var(--Bg-Tertiary90); backdrop-filter:blur(15px)` 的大面板，里面是 `.agent-card` 网格（3% 黑底、圆角 12、20px 圆头像 + 名字 + 一句职责）。排队项 `.outbox-queue-item` 圆角 8px、可拖动（`.dragging`），序号有位移动画（`outbox-queue-item__index-move`）。（K-home）
- 【V】任务完成 / 等待类的横条 `.chat-status-bar` 和 `.task-bar`：和输入框同宽（768px），白底、`.5px` 边、**圆角 20px**、同样的阴影，高 72px，左边 16/24 的一句话、右边 32px 高的按钮。（K-chat、K-home）
- 【V】回到底部 `.to-bottom`：38px 圆，`background:var(--Bg-Primary70)`（70% 白）+ `backdrop-filter:blur(5px)` + `1px` 边 + `0 2px 10px #0000001a`，淡入 `.3s`。（K-chat）

### 1.6 Agent 干活怎么显示

- 【V】工具步骤列表 `.toolcall-flow`（业主说的「一组步骤 + 虚线连接」）：
  - 每步 `.toolcall-flow__item`：一行高 24px，步与步之间 `margin-top:12px`；左边 20px 图标，文字 16/24、Secondary 色（60% 黑），**悬停变 Primary**；
  - 连接线：`.toolcall-flow__item:not(:last-child)::after { border-left:.5px dashed var(--Separators-S1); top:24px; bottom:-12px; left:10px }`——就是那条**虚线**；
  - 行尾小箭头 16px：平时 `opacity:0; transform:translateX(-2px)`，悬停 / 键盘聚焦才滑出来（`.15s`），展开后转 90° 并常显；
  - 新步骤入场 `toolCallFlowItemIn`：`opacity 0→1; filter blur(5px)→0; translateY(8px)→0`，`.38s cubic-bezier(.23,1,.32,1)`；文字入场 `toolCallTextIn` 同款；
  - 整组可折叠成一行摘要 `.toolcall-flow__summary`（24px 高，同样的悬停变色）：折叠 / 展开用 `grid-template-rows: 0fr ↔ 1fr`，时长 `--clp-d:.48s`，展开 `cubic-bezier(.25,1,.3,1)`、收起 `cubic-bezier(.55,0,.18,1)`；摘要和正文交换时各自 `filter:blur(10px)` + `translateY(-6px)` 淡出淡入（不是硬切）；
  - 思考内容在步骤里展开：最高 268px 内部滚动，左缩进 28px，字号降到 14/22。
  （全部 K-main）
- 【V】步骤容器 `.block-container`：`border:.5px solid var(--Separators-S1); border-radius:12px; padding:8px 12px; margin-bottom:12px`（业主截图里的那个带边框的分组）；完成图标和加载图标是 **APNG**（`finish.apng`、`loading-light/dark.apng`）。（K-main）
- 【V】进行中的标记：`.step-container .title-container.loading .search-icon::before` 是一个 **8px 的蓝点**（`#1783ff`），外加 `breath` 动画（一圈向外放大到 2 倍并淡出）；完成后换成对勾。（K-main）
- 【V】「正在…」的文字用 `.running-text`：`background-image: linear-gradient(120deg, #0009 40%, #0009 50%, #0000001a 70%, #0009 90%)`，`background-size:200% 100%`，`background-clip:text`，`2.5s linear infinite` 从右扫到左——**扫光文字**。暗色是白 56% → 90% → 56%。（K-misc）
- 【V】多 Agent（集群）：
  - `.multi-agent-block` 里一列 `.task-block`（3% 黑底、圆角 8px、`padding:12px`），序号用**像素字体**（`font-family: Pixelify, sans-serif`，Pixelify Sans）；
  - 底部**任务 dock** `.tasks-dock-container`：上边一条 `.5px` 线，里面横向一排 `.task-dock-item`（**120×82px** 小卡、圆角 12、3% 黑底），运行中的卡文字带扫光（`--running-shimmer: linear-gradient(276deg, #000 25%, #bcbcbc 65%, #5a5a5a 100%)`）；
  - 悬停一张卡弹出 `.task-dock-item-popover`（宽 360、最高 240、圆角 12、三层阴影 `0 64px 80px #0000000f, 0 16.976px 17.869px #0000000a, 0 5.054px 5.32px #00000005`）：44px 圆头像 + 名字（16/24、500）+ 职责（14/20、Secondary）+ 分隔线 + 提示词 + 它自己的 todo。
  （K-main、K-side）
- 【V】二手描述：集群里每个子 Agent 是**带人名的小头像**（Matt、Sue、Max…）；Kimi Code 的集群视图是一行「2 agents running」加每章一个对勾。（知乎搜索摘要 https://zhuanlan.zhihu.com/p/2002425744446465842 、https://zhuanlan.zhihu.com/p/2067902436875014487 ，原文 403）
- 【V】Todo：`.todo-list .todo-task`（16px 字、行高 24、图标 20px、未开始的是 Tertiary 色、项间距 12px）；输入框附近的 `.todo-status-bar`（「进度 n/m ｜ 当前这条」，当前这条可点开）。（K-main、K-side）
- 【V】深度研究进度 `.done-container`：标题蓝 `#356bfd99`（hover 实色）、带进度条 `--process-bar`；进行中文案行用同一种扫光（`loading` 1.5s）。（K-main）
- 【V】对话右缘的**回合导航** `.conversation-turn-navigator`：贴右 8px、垂直居中，一列刻度（每格 32px 高，刻度 10×1.5px、25% 黑，当前 / 选中是 90% 黑），悬停刻度从右端放大（`transform .12s`），点开是回合列表。（K-home）
- 【V】交付物：
  - 代码 / 应用卡 `.code-card`：最宽 400、**高 72px**、圆角 12、3% 黑底，左边 44×44 的图标块（蓝色淡底 `#1783ff1a` + 蓝图标 + 圆角 12）；生成中背后有一层浅蓝紫渐变（`#d6f5ff → #c1ddff → #eae9ff`）在转（`rotate`）；
  - 文件卡最小高 56px；网站预览卡 `.website-preview-card`；PPT 卡 `.slide-item`；
  - 预览 / 分享 / 回放页有单独的样式文件（`Preview`、`Share`、`Replay`：`.replay-title`、`.view-result`、`.share-actions-bar`）。
  （K-main、K-side、K-js）
- 【V】首条回复没来时：`.awaiting-first-response` 右下一个 24px 的 loading；失败变成红色重试图标 `.awaiting-retry`（sticky 在输入框上方）。（K-home）
- 【V】官方说法：执行时能看到「推理和决策的逻辑链路 / 调用的工具类型和执行步骤 / 访问的网址和信息来源 / 代码生成或分析的中间过程」。（K-agent）

### 1.7 Kimi Code（桌面 / CLI / IDE）

- 【V】三个面：桌面版（2026-09-17 上线）、终端 CLI、IDE 插件（VS Code 扩展 `moonshot-ai.kimi-code`）；另有 `kimi web`（CLI 自带的网页界面）。（K-code、K-codenews）
- 【V】落地页上的**桌面版 mock**（CSS 写死的 token）：侧栏 `#fbfdff`、主区 `#fff`、选中 `#0000000a`、用户气泡 `#f3f5f8`、文字四级 `#191919 / #6b7280 / #9aa3af / #b5b5b5`、强调 `#1683ff`、边 `#ececeb`；字体 `PingFang SC, -apple-system, …`；侧栏是「新建会话 / 搜索 / 会话」，会话**按项目分组**（landing-page、kimi-code-app、api-server），每条后面跟相对时间（刚刚 / 26m / 2h / 5h / 1d / 2d）；主区顶上是面包屑「landing-page/介绍一下你自己」，回答上面一行「**工作过程**」。（K-code）
- 【V】落地页标题用 **MiSans VF**，等宽用 **Geist Mono**。（K-code）
- 【V】桌面版：权限三档「**始终询问 / 必要时询问 / 完全自动**」；界面里显示工具调用、思考和**每轮的文件改动**；右侧面板内置浏览器，能截图和**圈元素批注**。（K-codenews）
- 【V】`kimi web` 的界面更新（很像 claude-web 的同类问题）：
  - v0.22.0：新设计系统；`Cmd/Ctrl+K` 搜会话；**连续的工具调用合成可折叠的一叠**；
  - v0.42.0（TUI）：**完成的工具调用折成「标题 + 一行摘要」**，`Ctrl-O` 展开；
  - v0.37.0：侧栏三个 tab **Open / Done / Workspaces**；`@` 提及渲染成带图标的胶囊；
  - v0.34.0：失败的请求**保留错误卡片，一键恢复**；
  - v0.41.0：在消息、文件预览、**diff / 每轮改动面板**、终端里选中文字 → 作为评论或引用；
  - v0.26.0 / v0.28.0：换模型 / 档位时提示「提示缓存会失效」；
  - v2.1.0（TUI 全屏）：可点的「Jump to bottom」。
  （K-codenews）
- 【V】CLI：三种权限模式、`!` 进 shell 模式、`Ctrl-B` 把前台命令 / 子 Agent 放到后台、`/tasks` 看后台子 Agent 进度、可配置的状态栏（mode / goal / model / tasks / Git 插槽）、自定义主题。（K-codenews）

### 1.8 Kimi Claw / 定时任务 / 其它

- 【V】Kimi Claw（2026-02 上线）：托管在云端的 OpenClaw，直接在 kimi.com 的标签页里跑，40 GB 存储、5000+ 技能。（K-news）
- 【V】CSS 里的 Claw：侧栏分区带房间和未读徽标；创建弹窗 `create-kimi-claw-modal` 分三步状态（`state-choose-personality` → `state-choose-scenario` → `state-creating`），选性格 / 场景是一排图标卡（`.personality-item`、`.scenario-item`、`.is-selected`），高度变化有 `expand-height` 过渡。（`claw-bot-DAAIxrHQ.css`，K-js）
- 【V】定时任务卡 `.task-card`（标题 / 说明 / 下次运行 / 开关 / 更多菜单），有 `--page` 和 `--chat` 两种尺寸。（`TaskCard-NZZa5-oG.css`）
- 【V】设置里有「外观」页（主题卡片网格 `.appearance-theme__card`，带预览图）和**字号三档**：`<html data-font-size="small|default|large">` 只作用在 `.chat-page` 里（改的是对话区的字，不动外框）。（K-main、K-html）

### 1.9 视觉语言（token 级，全部【V】，K-main 除非另注）

**字体**
- 正文：`-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Noto Sans, Ubuntu, Cantarell, Helvetica Neue, sans-serif, Arial, PingFang SC, Source Han Sans SC, Microsoft YaHei UI, Microsoft YaHei, Noto Sans CJK SC`，`font-size:14px`，`-webkit-font-smoothing:antialiased`。
  - 中西文混排的做法：**西文系统字体在前，中文系统字体在后**——Windows 上拉丁字母走 Segoe UI、汉字落到 Microsoft YaHei UI；macOS 上是 SF + PingFang SC。应用本体**不加载**网页字体当正文。
- 等宽：**Geist Mono**（自带可变字体 woff2，100–900）→ Menlo → Consolas；代码块另有 `Fira Code, Fira Mono, Menlo…` 一组。
- **MiSans VF**（自带 TTF 可变字体，100–900）：全局 CSS 里声明了 `@font-face`，实际看到用在 Kimi Code 落地页的标题上；应用里别处有没有用没确认。
- **Pixelify Sans**：只用在集群任务的序号上（像素味的小点缀）。
- 个别小字显式写 `PingFang SC, sans-serif` + `letter-spacing:.25px`。

**字号阶梯**（CSS 变量，default 档）

| 用途 | 字号 / 行高 |
| --- | --- |
| `--ui-T1` | 18 / 26 |
| `--ui-T2`（步骤行、任务名） | 16 / 24 |
| `--ui-B1` | 15 / 22 |
| `--ui-B2`（外框、菜单、侧栏） | 14 / 20 |
| `--ui-C1`（标签、徽标） | 12 / 18 |
| `--ui-C2` | 10 / 14 |
| Markdown 正文 B1 | **16 / 26** |
| Markdown H1 / H2 / H3 | 22/36 · 20/32 · 18/28 |
| 代码块 / 行内代码 | 14/22 · 16/26 |

字重几乎只有 400 和 500（强调、选中、名字用 500）。

**颜色（亮 / 暗）**

| token | 亮 | 暗 |
| --- | --- | --- |
| `--Bg-GroundPC`（整页 + 侧栏） | `#fbfaf9` | `#181817` |
| `--Bg-Primary`（主卡） | `#fff` | `#121212` |
| `--Bg-Secondary` | `#f5f5f5` | `#1f1f1f` |
| `--Bg-Tertiary`（菜单、浮层） | `#fff` | `#292929` |
| `--Labels-Primary / Secondary / Tertiary / Quaternary` | 黑 90% / 60% / 45% / 30% | 白 84% / 56% / 42% / 26% |
| `--Fills-F1 / F2 / F3 / F4` | 黑 3% / 5% / 15% / 25% | 白 5% / 10% / 18% / 25% |
| `--Separators-S1` | 黑 13%（`#00000021`） | 白 12% |
| `--Colors-KMBlue` | `#1783ff` | `#1a88ff` |
| `--Others-KMBlue10`（蓝色淡底） | `#1783ff1a` | `#1a88ff1a` |
| 红 / 绿 / 橙 / 黄 / 紫 | `#ff3849` / `#16c456` / `#ff9500` / `#ffd230` / `#985ffb` | `#ff4756` / `#16c456` / `#ff9f0a` / `#ffd230` / `#a16bff` |
| 用户气泡 `--Others-BubbleGray_PC` | `#f5f5f5` | `#292929` |
| 提示 / toast `--MaskBg-ToastPC` | `#2b2b2b` | `#404040` |
| 代码高亮 | One Light 系（`#a626a4` / `#50a14f` / `#986801`…） | One Dark 系（`#d55fde` / `#89ca78` / `#d19a66`…） |

- 特点一：**文字和填充全是「黑 / 白 + 透明度」**，所以放在任何底色上层级都对；真正写死的颜色只有几种底色和六个功能色。
- 特点二：每个颜色 token 都有预先算好的 `-hover` / `-active` 两个兄弟（颜色变量里三分之二是这个），组件不用自己调明暗。
- 特点三：**没有品牌色主按钮**——主按钮、发送键、套餐徽标都是 90% 黑；蓝色只给「开着的模式」、链接、进行中的点、标签。

**圆角**（K-main 里的出现次数：12px×56、8px×48、50%×42、10px×36、4px×19、16px×14、6px×12、24px×5、20px×5）

| 圆角 | 用在 |
| --- | --- |
| 4px | 标签、键帽、套餐徽标、缩略图 |
| 8px | 小按钮、分段 tab、任务块、分节标题 |
| 10px | 侧栏导航行、菜单项、模型项、分段容器 |
| 12px | 主卡、卡片、历史行、新建会话、步骤容器、状态胶囊、附件 chip |
| 16px | 菜单、@ 菜单、反馈条 |
| 20px | 输入框里的 chip、状态横条、任务条、手机抽屉顶角 |
| 24px | 输入框外壳 |
| 22px / 50% | 发送键、头像、回到底部 |

**边线与阴影**
- 发丝线到处是 `.5px solid var(--Separators-S1)`（Retina 上是真 1 物理像素）；只有输入框和主卡用 1px。
- 阴影很少、很淡：输入框 `0 5px 16px -4px #00000012`；菜单 `inset 0 0 0 .5px 分隔色, 0 4px 16px 0 #0000001a`（**内描边 + 外阴影**）；大浮层三层叠加；其余平面全靠 3% / 5% 的填充区分。

**图标**
- 入口 JS 里 `stroke-width` 的统计：**1.8 出现 292 次**，2 只有 9 次、1.5 有 8 次；`stroke-linecap: round` 288 次；`viewBox` 是 `0 0 24 24`。→ 自绘的线性图标，**24 网格、描边 1.8、圆头**。（K-js）
- 渲染尺寸：侧栏 / chip 里 18px，步骤行 20px，箭头 16px。
- JS 里没有 lucide / phosphor / iconpark 的痕迹（`tabler` 字样 18 处，【I】个别图标借了 Tabler）。

**动效**
- 最常用的缓动 `cubic-bezier(.23,1,.32,1)`（easeOutQuint，K-main 里 36 次）；hover 类过渡一律 `.15s`，底色类 `.3s ease-in-out`。
- 菜单 `.kimi-menu`：`opacity` + `transform: scale(.85 → 1)`，进 `.15s cubic-bezier(0,0,.2,1)`、出 `.15s cubic-bezier(.4,0,1,1)`；圆角 16、`padding:8px`、项 `min-height:36px`、圆角 10。子菜单有**鼠标安全区**：`::before` 用 `clip-path: polygon(…)` 在触发项和子面板之间画一块看不见的梯形，斜着移过去不会关。（K-menu）
- Loading 三种：`core-spiral-loading`（14px，5 个点透明度 .149 ↔ .451 错峰 1s，像螺旋）；`loading-pure`（锥形渐变转圈 1s）；整页用一张 40px 的 APNG。（K-misc）
- 提示 `.kimi-tooltip`：深底 `#2b2b2b`、白字 14/20、圆角 8、`padding:8px 12px`、最宽 240px、10×4 的小三角。（K-misc）
- 分段 tab `.bubble-tabs`：容器 `#f5f5f5`、圆角 10、`padding:2px`；项圆角 8、`padding:4px 12px`；选中白底。（K-misc）
- 所有动画都有 `@media (prefers-reduced-motion: reduce)` 的关闭分支。

### 1.10 手机

- 【V】网页：≤ 840px 右侧面板变底部抽屉（见 1.2）；`.app { min-width:375px }`；有 `.mobile` / `.not-mobile` 两套；`--MaskBg-ToastIOS / ToastAndroid` 说明同一套 token 给原生壳用。（K-main、K-side）
- 【V】App：Agent 入口在「对话框上方的模型切换按钮」里选 K3 / K3 集群；进度在手机、电脑、网页三端同步。（K-agent，应用商店简介）
- 没找到 App 的界面截图或设计拆解。

---

## 2. Manus

**布局与外框**
- 【V】三栏：左侧任务栏、中间对话、右侧「Manus's Computer」（Agent 的浏览器 / 终端 / 编辑器实况，下面挂实时更新的任务清单），右栏可折叠。（M-rev）
- 【V】截图里的侧栏（浅灰）：**New task · Search · Library** → Projects（+）→ All tasks（筛选图标）；每个任务前面一个**按任务类型的单色小图标**（图表、购物车、组织图…），收藏的行尾一颗黄星；底部一排四个小图标。顶栏左边是版本下拉「Manus 1.6 Lite ⌄」，右边 Collaborate / Share / ···。（M-mob）
- 【V】项目页：居中一个文件夹图标 + 项目名 + 「Created by … · Updated …」，下面输入框，再下面三张等宽小卡 **Instructions / Files / Skills**（各带 + 或铅笔），再下面 Tasks 列表（图标 + 标题 + 右侧相对时间，悬停出 ···）。页脚一行灰字「Your tasks stay private unless shared」。（M-mob）

**输入框**
- 【V】白底、大圆角、很淡的阴影；placeholder 在上，下面一行：左 **+ · 连接器 · 技能** 三个图标，右 表情 / 麦克风 / **圆形发送键（空的时候是浅灰）**。输入框**下面贴一条**「Connect your tools to Manus」+ 一排品牌小图标 + ×（和输入框连成一体的浅色条）。（M-mob）
- 【I】圆角约 20–24px（按截图估）；CSS 里 `22px`、`28px`、`32px` 的圆角都出现过。（M-css）

**Agent 干活怎么显示**
- 【V】对话流里：步骤是「● **Deliver the final presentation to the user** ⌃」这样的一行标题（可折叠），下面一段灰字是这一步的小结；然后是带品牌字标的助手正文。（M-mob）
- 【V】**输入框上方停着一条进度胶囊**：左边是「电脑」画面的**缩略图**，中间「✓ Deliver summary to user」，右边「3 / 3 ⌃」；点开是完整计划。（M-mob）
- 【V】手机上的「Manus's computer」是一张全屏卡：顶上 × · 标题 · 视图切换；中间画面卡（顶上一行文件路径）；下面「Manus is using **Media viewer**」+ 一行灰字说在干什么；一条**进度滑块**；⏮ ·「▶ Jump to live」胶囊 · ⏭；最底下一条「✓ 当前计划步骤」。（M-mob）
- 【V】交付物：一张带标题栏（文件图标 + 标题 + ···）的**内嵌预览卡**（文档 / 幻灯片首页直接画在对话里）；完成后一行绿色「✓ Task completed」，右边「How was this result? ☆☆☆☆☆」；再下面「Suggested follow-ups」三行（图标 + 一句话 + →）。（M-mob）
- 【V】回放：可分享的带时间线的回放链接（`replay=1`），能倒回去看每一步。（M-rev）
- 【V】反馈提示：顶部居中一枚深色小胶囊「✓ Submitted successfully!」。（M-mob）

**动效**（M-css）
- 【V】`status-shimmer`（4s linear，`background-position 200% → -200%`）配 `--background-thinking: linear-gradient(90deg, 文字色 0%, #d9d8d8 50%, 文字色 100%)`——「思考中」是**扫光文字**；`breathe`（透明度 0 ↔ .05 的呼吸底）；`bounce-dot`（三点上跳 5px）；`scale-button`（悬停 1 → 1.1 → 1）；`tipIn`（提示从下 8px、`scale(.92)` 弹出）；`text-fade-in`（上移 50px 淡入）；`progress-fill`。
- 【V】最常用缓动 `cubic-bezier(.4,0,.2,1)`（41 次）；另有 `cubic-bezier(.32,.72,0,1)`（iOS 抽屉曲线）。
- 【V】有一整组 `--activity-indicator-*` token（卡片底 `#ffffffe6`、运行蓝 `#0081f2`、成功绿 `#25ba3b`、警告 `#efa201`、错误 `#fb494f`）——【I】是桌面 / 系统级的「活动指示器」小卡。

**视觉语言**（M-css，【V】）
- 字体：正文 `-apple-system, BlinkMacSystemFont, Segoe UI Variable Display, Segoe UI, Helvetica, Arial, sans-serif`（纯系统栈）；**衬线点缀** `.font-serif`：西文 **Libre Baskerville**，中文按 `:lang()` 换 **Noto Serif SC / TC / JP**（韩文退回无衬线）。字标本身是衬线小写「manus」。
- 颜色：页面 `#f8f8f7`（`theme-color`）、白 `#fff`、文字 `#1a1a1a / #4d4d4d / #737373 / #a6a6a6`、墨色 `#34322d`；边 `#0000000f`（6%）；填充用**暖黑透明度** `#37352f0a / 0f / 14`（和 Notion 一个路数）；蓝 `#0081f2`；黑按钮 `#1a1a19`；成功 / 警告 / 错误 / 已合并 `#25ba3b / #efa201 / #fb494f / #8269cb`。暗色：页面 `#1a1a1a`、菜单 `#242424`、文字 `#e6e6e6`、蓝 `#1a93fe`。
- 圆角：胶囊（9999 / 100px）很多；12 / 16 / 24 / 32px。
- 图标：细线性单色图标（截图）；描边粗细没量到。

---

## 3. Genspark

- 没读到 CSS（Cloudflare 403），Mobbin 没收录；以下全是评测文字。
- 【V】左栏是一列专用 Agent（Super Agent、AI Slides、AI Sheets、AI Docs、AI Developer、AI Designer）；首页是这些入口的集合。（GS）
- 【V】「思考 / 计划」视图里能回看它搜了什么、做了哪些假设、产出了什么，评测把它叫审计记录。（GS: templytic）
- 【V】Slides 工作区（2026-07 更新）：画布上同时摆着**整份结构、正在生成的那一页、还没生成的页**（占位写「Waiting for generation」）；左栏是大纲和备注；收尾给三个快捷动作（导出 PPTX / 补演讲备注 / 转配音视频）。2026-08 起有画布内编辑器和 History 版本快照，手动改动和 AI 改动记在同一条线上。（GS）
- 【V】AI Developer：右边实时网站预览，左边代码和改动列表。（GS: blogwithben）

## 4. Flowith（Canvas / Neo）

- 【V】核心是**无限画布**：每次输入 / 生成都是一个节点，从任意节点分叉，能把几个分支的结果并排比较；顶栏六个模式 Chat / Image / Video / Slides / Website / Neo Agent。（FL）
- 【V】Neo 的计划是一份会变的「Recipe」，进行中的任务节点一直留在画布上，可以点进去检查它的搜索、选的模型、引用，再放它继续。（FL: therundown）
- 【V】字体：**ABC Oracle**（300 / 400 / 500 / 700，自带 woff2），后备 `Helvetica Neue, Arial, PingFang SC, Microsoft YaHei`；另有手写体 Caveat、Splash，展示体 Anton、EB Garamond、Racing Sans One（节点 / 卡片里的装饰字）。（FL css）
- 【V】颜色：灰阶 `#2d3139 / #5a6272 / #8d95a5 / #c6cad2 / #e2e4e8 / #f1f2f4`，紫 `#5837fb`（32 次）和浅紫 `#ab9bfd`；`theme-color` 亮 `#eee` / 暗 `#000`。【I】紫是品牌色。
- 【V】动效名：`theme-ripple-reveal`（**切主题时的水波纹揭开**）、`meteor`、`shimmer-border`（边框流光）、`edge-flash-once` / `edge-fade-out`（连线闪一下）、`slideInFromRight/Left/Top/Bottom`。（FL css）

## 5. Lovart

- 【V】ChatCanvas：画布是主角、对话在右侧；在画布上按 **C** 给图片任意位置钉评论（像 Figma 评论，但对象是 AI）；Agent 先出计划、给四个设计方向再生成。（LA 及其评测）
- 【V】字体：界面 **GT Standard**（400 / 500 / 600）+ `Noto Sans SC / TC / JP`；等宽 GT Standard Mono；展示体 **Feature Deck / Feature Display**（衬线）；另有 Poppins、Barlow Condensed、Inter。标题分两套变量 `--font-title-latin` / `--font-title-cjk`（**中西文标题各用各的字体**）。（LA css）
- 【V】颜色：墨色 `#100f09`、灰 `#86909c / #c1c5cc / #f2f3f5 / #f7f8fa`、蓝 `#3b82f6 / #147dff`、紫 `#8b5cf6`。圆角 8 / 10 / 12 / 16 / 24 / 36px。（LA css）
- 【V】动效名：`agent-chat-skeleton-sweep`（对话骨架扫光）、`dock-rise-fade` / `dock-sink-fade`（底部工具坞升起 / 沉下）。（LA css）

---

## 6. 豆包（Doubao）

- 【V】三区：侧栏 / 对话区 / 输入框；`Ctrl+K` 新对话；`/` 或 `@` 在输入框里召唤智能体。（DB 评测）
- 【V】输入框里的**技能标签是编辑器里的一个内嵌节点**：选了「音乐生成」之类的技能后，标签留在输入框里、不能直接删，多行文字排在它**下面**（不是左边留一块空）。（DB: cnblogs 拆解）
- 【V】AI 编程：左对话、右边先流式出代码、生成完切成渲染预览；右侧工具条是 **版本历史 · 编辑 · 代码 / 预览切换 · 下载 · 分享**；编辑模式下可选元素用蓝色虚线框标出。（DB: 阮一峰）
- 【V】PC 客户端「工作任务」模式新增**侧边工作台**（2026-08）：对话和产物（报告 / 表格 / PPT）同屏，实时显示任务进度和 Agent 执行过程，边看产物边在对话里提修改。（DB: 163）
- 【V】token：品牌蓝 `--s-color-brand-primary-default: #0057ff`（暗 `#547cff`），hover `#004ad9`；品牌色透明度三档 6% / 10% / 15%；输入框圆角 `--input-guidance-input-container-radius: 20px`；**阴影带品牌色**（`--s-shadow-lv1-brand: 0 2px 3px rgba(0,102,255,.05), 0 0 1px rgba(0,102,255,.15)` 一直到 lv5）。（DB css）
- 【V】字体：纯系统栈 `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, 'Noto Sans', …`（**没有显式中文字体**，交给系统）；等宽 `ui-monospace, SFMono-Regular, Menlo…`。（DB css）
- 【V】动效名：`drawer-enter`、`dock-opacity-enter/exit`、`asr-dot-pulse`（语音识别的点）、`sug-switch-fade-in`（建议切换）、`caret-blink`；缓动 `cubic-bezier(.4,0,.2,1)` 为主，有一条回弹 `cubic-bezier(.34,1.56,.64,1)`。（DB css）

## 7. Qwen Chat / 千问

- 【V】chat.qwen.ai：字体 `system-ui, ui-sans-serif, -apple-system, BlinkMacSystemFont, Inter, NotoSansHans, sans-serif`；暗底 `#171717`、亮底 `#fff`；灰 `#2c2c36 / #8f91a8 / #afb1c4 / #fafafc`（偏蓝的冷灰）。（QW）
- 【V】千问（qianwen.com，原通义）：预加载 **Plus Jakarta Sans**（Medium / SemiBold / Bold）；内联样式里有 `#0011ff` 和 `#eceaff`（【I】品牌蓝紫）。（QW）
- 【V】模式：Chat / Web Dev / Full Stack / Slides / Deep Research；Deep Research 的成品在**右侧窗格**，右上角「Create」可以把报告变成网页或播客。（QW）
- 没找到输入框和侧栏的像素级资料。

## 8. DeepSeek

- 【V】输入框两层控制：输入条上方一个 **Instant / Expert** 切换，卡片里 **DeepThink / Search** 两个 chip；思考内容在回复上方一个可折叠块里。拆解批评：档位和思考开关分在两处、chip 的解释只有悬停才有（触屏看不到）、打开后没有「会更慢 / 更贵」的提示。（DS）
- 【V】（第三方拆解）品牌蓝 `#4d6bfe`、字体 **DM Sans**、圆角 8px；主按钮是暖近黑 `#1a1615`；页面 `#f9f8f8`、文字 `#1e232c`、placeholder `#8691a1`。（DS: oh-my-design）
- 没读到它自己的 CSS。

## 9. MiniMax Agent（含桌面端 Mavis）

- 【V】字体变量 `--mcode-font-family-ui` 的后备：`"HarmonyOS Sans", "Segoe UI", "SF Pro Display", -apple-system, …, "HarmonyOS Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft Yahei UI"`；另有自带的 **Source Serif**（正体 + 斜体）。Markdown：正文 14px、H1 21px、H2 17.5px、H3 15.75px、代码 12–13px（**整体偏小偏密**，更像 IDE）。（MM css）
- 【V】圆角两档变量：`--mavis-radius-surface: 12px`（面板、卡片）、`--mavis-radius-control: 8px`（控件）。（MM css）
- 【V】动效名：`attention-ring`（**琥珀色**外发光 `rgba(217,119,6,.15)` 0 → 3px 呼吸——等你处理）、`timeline-pulse`、`thinking-pulse`、`thinking-expand / collapse`、`border-pulse`、`fadeInChar`（**逐字淡入 + 1px 模糊**）、`sd-blurIn`、`canvasNodeTitleSweep`、`mavis-dot-a/b/c`、`slide-in-right`。（MM css）
- 【V】更新日志里的交互细节（MM changelog）：
  - 侧栏：历史默认按项目分组、**状态点替代文件夹图标**；会话列表明确显示「运行中」和「等待权限确认」；置顶 + 拖动排序。
  - 「回到底部」按钮**单击跳到上一条提问，双击直达顶部**。
  - 反思记录改成卡片，不占对话流；模型选择器旁边一个独立的 **Thinking 开关**。
  - 文件预览面板：diff 对比 + 一键提交；**悬停改动行弹出 diff 预览**；生成 / 引用的文件点一下定位到文件、目录或对应代码行。
  - 权限精简成两档「智能授权 / 始终授权」；权限卡片上显示**审查理由**；一次文件夹授权覆盖读 / 写 / 编辑 / 搜索。
  - 内置浏览器：Agent 操作时显示**可见光标和移动轨迹**；发布 / 发送 / 提交这类对外操作执行前再确认一次。
  - 输入框：富文本 + `@` 引用文件；Agent 工作时可继续追加消息；「运行位置」选择器替代原来的 Worktree 开关。
  - CLI：`Alt+Enter` 入队、`Enter` 是 steer 当前回合；输入框上方有任务面板。
  - 手机远程：看进度、发指令、**审批权限**。
- 【V】Mavis（2026-05）：Worker / Verifier / Leader 三种角色；侧栏里每个 Agent 一个对话，能看它们之间的往来。（MM 相关报道）

## 10. Z.ai / 智谱清言（AutoGLM）

- 【V】字体：`--font-sans: Geist, "PingFang SC", -apple-system, …, "Microsoft YaHei"`（**Geist 在前、PingFang SC 紧跟**）；等宽 GeistMono；衬线 `--font-serif: "Crimson Text", "Noto Serif SC", Georgia`，另自带 **Iowan Old Style BT**。`theme-color #F4F6F8`。（ZA css）
- 【V】颜色：墨 `#0d0d0d`（88 次）、灰 `#333 / #4e4e4e / #676767 / #9b9b9b / #cdcdcd / #ececec`，蓝 `#0881f0`，浅蓝底 `#f0f7fe`。（ZA css）
- 【V】动效名：`placeholderZEntrance`（首页的 Z 标：`scale 1.3 + blur(8px)` → 清晰归位）、`placeholderInputEntrance` / `SubtitleEntrance` / `FeatureEntrance`（首页元素**依次入场**）、`shimmer-text-move`、`thinking-pulse`、`artifactSlideUpFade`（产物卡上滑 24px 淡入）、`sidebarItemFadeIn`、`gradientBreathing`、`ppt-editor-left-in / center-in / right-in / toolbar-in`（PPT 编辑器四块分别滑入）、`terminal-loading`（等宽字的终端式加载块）。缓动里有一条回弹 `cubic-bezier(.54,1.5,.38,1.11)`。toast 用 sonner。（ZA css）
- 【V】首页问句「What can I build for you?」，下面快捷入口 Magic Design / Full-Stack / Write Code；Full-Stack 给模型一个带终端的沙箱。（ZA 评测）
- 【V】AutoGLM 沉思：入口在智谱清言桌面端左侧导航 / 智能体中心；执行时以 Chrome 为可见工作区，最后出报告。（https://ai-bot.cn/autoglm-research/ ）

## 11. 扣子空间（Coze Space）

- 【V】space.coze.cn 现在跳到 coze.cn（「AI 办公助手一站式平台」）。（CZ）
- 【V】两个区域：任务管理 + 对话框下任务；输入区左下角切**探索模式 / 规划模式**——规划模式先出步骤拆解，用户确认或修改后才分步执行，中途能暂停。（CZ 评测，2025 年内测期）
- 【V】字体：`--font-sans: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", …`（**中文字体排最前**，和 Kimi 相反）；等宽 **Geist Mono**；衬线 `Noto Serif, Noto Serif CJK SC, Source Han Serif CN, Songti SC…`；数字用 DIN Alternate / OPPOSans Bold。（CZ css）
- 【V】颜色：Tailwind **stone** 暖灰（`#fafaf9`×48、`#f5f5f4`、`#e7e5e4`、`#78716c`、`#1c1917`、`#0c0a09`）+ 一个暖棕 `#a8856a`（22 次）+ 靛蓝 `#5147ff / #412bff / #6366f1`。（CZ css）
- 【V】动效名：`glint` / `glint-light`（高光扫过）、`message-fade-in-up`、`panelSlideLeftIn/Out`、`panelSlideRightIn/Out`、`lineLoading`、`subscription-card-breathing`；最常用缓动是很「重」的 `cubic-bezier(.87,0,.13,1)`（8 次）和 `cubic-bezier(.16,1,.3,1)`。（CZ css）

## 12. 秘塔 AI 搜索

- 【V】三档模式 简洁 / 深入 / 研究；研究里有「先想后搜」（先列研究步骤再搜）；答案附**大纲、脑图、对比表**；搜索范围 全网 / 文库 / 学术 / 图片 / 播客。（https://cloud.tencent.com.cn/developer/news/2190140 等）
- 【V】`theme-color` 亮 `#fafafa` / 暗 `#151515`；字体 Roboto（MUI 默认）+ Noto Sans SC；灰阶是 Untitled UI 那套（`#667085 / #98a2b3 / #eaecf0`），蓝 `#007aff`。（MT）
- 没找到步骤展示的像素级资料。

## 13. 元宝（腾讯）

- 【V】基于 TDesign：品牌蓝 `#0052d9`（198 次），圆角以 3px / 6px / 8px 为主（偏方）。（YB css）
- 【V】字体：界面 `-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Roboto, …, Microsoft YaHei UI`（PingFang SC 排第四）；**自带一套衬线西文字体「YB Serif UI」**（400 / 500 / 600 + 斜体，另有「YB Serif UI for Landing」）：`body.yb-en-font-serif` 时 Markdown 正文的 `--yb-en-font` 设成它——**回答里的英文和数字走衬线，中文仍走系统黑体**。Markdown `16px / 1.75`。（YB css）
- 【V】动效名：`a-deepthink-box-flash`（深度思考框闪动）、`a-text-flash-hyc`（文字闪光）、`sweepLight`、`code-block-generating-dot`、`yb-skeleton-shimmer-loading`、`leapFrog`、`a-file-parsing`。（YB css）
- 【V】（二手、低可信）输入框里「深度思考」「深度搜索」两个可叠加的开关；深度搜索的来源是可点的索引。

---

## 14. Perplexity（含 Comet、Labs）

- 【V】截图里的布局：暖沙色底；左栏 **New · Computer · Spaces · Artifacts · Customize · History**（图标 + 文字，当前项浅底），底部账号行；回答页顶上一排 tab **Answer · Links · Images · Videos**（当前项下划线），右上 ··· 和黑色「Share」胶囊。（PX-mob）
- 【V】Agent 步骤：回答上方几行「🔍 Searching for … ›」「⑂ Running tasks in parallel ›」（图标 + 一句话 + 小箭头，点开看详情）；右侧两张窄卡「**Sources 10 ›**」「**Usage 33s ›**」。来源面板是右侧滑出的一栏（标题「1 source」+ ×）。（PX-mob）
- 【V】输入框：白卡、「Ask a follow-up」/「Type a command…」，下面左边 **+** 和一个**带下拉的模式 chip**（Computer ⌄ / Search ⌄ / Learn step by step ⌄），右边 Model ⌄ / 麦克风 / 圆形发送键；运行中发送键换成**黑色方块**。（PX-mob）
- 【V】反馈：点赞后弹一张小卡「What did you like about this response? (optional)」+ 六个胶囊（Up to date / Accurate / Helpful / Followed instructions / Good sources / Other…）。（PX-mob）
- 【V】回答正文是**衬线体**（截图里标题和正文都是衬线，界面是无衬线）。（PX-mob）
- 【V】Labs：结果分 tab——Tasks（子任务时间线，实时）/ Assets（图表、图片、CSV 逐个下载）/ App（可交互的小应用）/ Sources / Code；一次要跑 10 分钟以上。（PX-tok: aifire、dev.to）
- 【V】（第三方拆解）字体 **pplxSans**（自有字体，400 / 500），主色青 `#016a71`，画布 `#fdfbfa`，墨 `#27251e`；胶囊 9999px（21 处）、容器 12px、输入 8px、筛选 chip 6px；侧栏 256px。（PX-tok）
- 【V】Comet：Chromium 浏览器 + 助手侧栏；助手的动作可见、随时可接管。（https://www.perplexity.ai/changelog/what-we-shipped-november-22nd ）没找到侧栏的视觉细节。

## 15. Devin

- 【V】截图里的布局（亮色）：左栏 **Sessions · Ask · Automations · Review · Wiki**，下面 Recent 会话列表——每行标题下一行**绿色状态「PR is ready · ⑂ 2」**，未读是右侧蓝点；中间对话；右边工作区。（DV-mob）
- 【V】右侧工作区的 tab：**Worklog · Changes · PR #5 · Desktop · test-report.md · Shell · +**；Shell 里每个 shell 一个子 tab，下面一张「Search Command History」表（命令 / 状态点 / Duration / Start）。面板底部一条**蓝色时间线进度条** + ← → + 「● Live」。（DV-mob）
- 【V】对话里的进度行：「💡 Thought for 9s」「› Worked for 4m 1s **+394 −94**」（可折叠，行尾直接带增删行数）、「7/7 Test the app end-to-end」、「Stopped working」、「**Devin went to sleep**」。（DV-mob）
- 【V】成果卡：PR 卡（标题 + 仓库#号 + `+393 −94` + 「Review with Devin」+ 黑色「Analyze」）；测试卡（录屏缩略图 + 「CRUD Todo List Testing ● 8 passed ✓ All passed」）；文件卡（图标 + 名字 + 2.3 KB）。（DV-mob）
- 【V】输入框：「Ask Devin to build features, fix bugs, or work on your code」，左 + 和「Default」模式，右麦克风 + **黑色胶囊发送键带下拉**。（DV-mob）
- 【V】字体：应用 `var(--font-ui, Inter)` + **Devin Mono**（自有等宽，400–700）；官网是 **NB International Pro** + STK Bureau Serif + Geist Mono + IBM Plex Mono。应用 `theme-color #141414`（默认暗色）。（DV-css）
- 【V】动效（DV-css）：
  - 一整套**人设动画**：`devin-persona-thinking_1/2`、`generating_1/2/3`、`sleep`、`wake` 各有十几层 keyframes；`ds-bot-character-eyes`（小机器人的眼睛左右看、眨眼）——**状态不同，吉祥物的动作不同**；
  - `.live-work-shimmer`：`linear-gradient(100deg, currentColor 30%, 25% 透明度的 currentColor 50%, currentColor 70%)`，`background-clip:text`，`2s linear infinite`（用 `currentColor`，所以任何颜色的字都能扫光）；
  - `ds-session-working-dot`（会话在跑的小点：亮 → 灭，占 69% 时间是灭的）、`ds-session-lead-ring-in`（新带头会话的一圈入场，`.32s cubic-bezier(.16,1,.3,1)`，延迟 80ms）、`ds-artifact-card-attention-pulse`（成果卡等你看的时候边缘 1.5s 呼吸）、`ds-shine-sweep`（120° 遮罩扫光）。

## 16. Replit Agent

- 【V】截图里的布局：左列对话（顶上一张「**Active task** · 任务名」卡）；中间预览（带地址栏）；最右可开 Library / Files。顶部 tab Design / Build · Tools / Preview / +。（RP-mob）
- 【V】对话流的节奏：一段说明文字 → 一行**小工具图标 + 「N actions」**（把连续的工具调用压成一行图标条，点开看）→ 下一段文字…；子 Agent 在跑时这一行写「Design agent working…」。（RP-mob）
- 【V】收尾三行：「✓ Marked task #1 complete」「◷ **Worked for 24 minutes**」「◎ **Checkpoint made 1 hour ago**」；检查点卡：标题 + 时间 + 三个小按钮 **Rollback here · Changes · View preview**；回退后一张灰卡「↺ Rolled back to '…' · Finished · 2 minutes ago」。（RP-mob）
- 【V】用户消息是浅蓝气泡；滚离底部时出「↓ Scroll to latest」小胶囊；预览没好时中间一行衬线大字「Replit Agent is building…」。（RP-mob）
- 【V】字体：**Replit Diatype**（自有可变字体，200–1000）+ Replit Diatype Mono；橙 `#ff3c00`、蓝 `#4c7dff`、暖白 `#faf6f1`。（RP-css）
- 【V】动效（RP-css）：`RollingCaption`（状态文字像**骰子一样绕 X 轴翻 90°** 换下一句：`translateZ(-h/2) rotateX(…)`）、`AgentWorkingSpinner`（`steps(80)` 的**逐帧条带**动画，1.28s）、`animated-ellipsis-bounce`（省略号跳）、`ConversationGlyph working-spin`（会话图标在转）。

## 17. Lovable / v0 / Bolt（对话 + 实时预览）

**Lovable**
- 【V】布局：左边**窄对话列**（按截图估约占 30%），右边大预览；顶栏：项目名 ⌄ · 历史 · 面板开关 ·「Preview」蓝色胶囊 tab + 一排图标 tab（云 / 设计 / 代码 / 分析 / +）· 地址栏胶囊 · Share · GitHub · 蓝色 Publish。整页奶油色底。（LV-mob）
- 【V】对话流：用户消息是右对齐的米色圆角气泡；「💡 **Thought for 22s**」；「📄 **6 tools used** … Show all」「1 edit made … Show all」；每次改动收成一张**版本卡**：标题（Add dark mode toggle）+ 「Previewing latest version」/「Preview this version」+ ›，卡下挂一个「</> Code」小 chip 和书签；当前预览的那张是**蓝色描边 + 淡蓝底**。消息下一排小图标（撤销 / 赞 / 踩 / 复制 / ···）。（LV-mob）
- 【V】回退：点旧版本 → 预览顶上一条「Viewing: **Add dark mode toggle**」+「← Back to latest」+ 蓝色「Restore this version」；对话里同时出一张确认卡「Revert to this version? …」+ Cancel / 黑色 Revert；完成后右下角 toast「✓ Reverted to message」。（LV-mob）
- 【V】输入框：「Ask Lovable…」，下面 + · 「Visual edits」· 右边「Chat」开关（开着是蓝色胶囊）· 语音 · 圆形发送键（运行中是黑圆里一个方块）；上方一排建议 chip（Add mobile menu / Add contact form）。启动预览时底部一枚「Starting live preview…」胶囊。（LV-mob）
- 【V】（第三方拆解）字体 **Camera Plain Variable**（400 / 480 / 600）；奶油 `#f7f4ed`、近白 `#fcfbf8`、炭黑 `#1c1c1c`、边 `#eceae4`；圆角 4 / 6 / 8 / 12 / 16 / 9999；深色按钮是三层内阴影；原则「borders define boundaries, not shadows」。（LV-tok）

**v0**
- 【V】字体 **Geist Sans / Geist Mono**（自带可变字体）；圆角以 12px 和 6px 为主。（V0 css）
- 【V】每条生成消息上有 检查 / diff / 恢复；恢复不是破坏性的——被恢复的代码**追加成最新一版**；选旧版本时顶栏只剩 Restore 和「Back to Latest」。Design mode：预览工具条里的 Design tab，悬停高亮、点选元素、改样式后 Apply 落成一个普通版本。（V0 docs）

**Bolt**
- 【V】字体 Inter + **Inter Display**（600 / 700，标题）+ **Silkscreen**（像素体点缀）；`theme-color #111114`；主色 `#1488fc`、亮蓝 `#2ba6ff`；面板 `#1e1e21 / #2c2c30`（不用纯黑）。（BT）
- 【V】动效名：`textShimmer`、`shimmerIcon`、`shimmerImageDiagonal`、`followUpPromptEnter`（追问建议入场）、`loadingBar`、`forge-celebration-lockup-in / greet-in / sweep`（**完成时的庆祝动画**）、`button-enable`。（BT css）
- 【V】版本：每条提示自动存一版；顶栏时钟图标进版本列表（可搜索、可改名、可加书签）；对话里旧版本上有眼睛图标 → 先预览、右上「Restore this version」再确认；恢复不花 token。（BT 帮助）

---

## 18. 共同模式

1. **底色 + 浮卡，而不是三栏分割线。** Kimi（`#fbfaf9` 底 + 6px 边距的白卡）、Manus（`#f8f8f7`）、Perplexity（暖沙）、Lovable（奶油 `#f7f4ed`）、扣子（stone `#fafaf9`）都是「侧栏和页面同色、主区一张圆角卡」。分隔靠底色差和 6% 左右的发丝线，不靠 1px 实线网格。【V】
2. **暖中性色。** 几乎没有人用纯 `#fafafa` 冷灰：Kimi `#fbfaf9`、Manus `#f8f8f7` + 暖黑透明度 `#37352f`、Lovable `#f7f4ed`、Perplexity `#fdfbfa`、扣子 stone、Replit `#faf6f1`。【V】
3. **主按钮是墨色，品牌色只做点缀。** Kimi 发送键 90% 黑、Manus `#1a1a19`、Lovable 炭黑、DeepSeek `#1a1615`、Devin / Perplexity 黑胶囊。蓝 / 青只给「开着的模式」、链接、进行中。【V】
4. **输入框 = 大圆角白卡 + 一行圆形 / 胶囊控件。** 圆角 20–24px（Kimi 24、豆包 20、Manus ~22）；左边 `+` 和模式 chip，右边模型 + 圆形发送键；发送键三态（空 = 浅灰、可发 = 黑底白箭头、运行 = 黑底方块）。Perplexity、Lovable、Kimi、Manus 一致。【V】
5. **模式 / 技能是输入框里的东西**：Kimi 的蓝字 chip（悬停变 ×）、豆包的不可删内嵌节点、Perplexity 的下拉 chip、DeepSeek 的两个 chip。【V】
6. **执行过程默认收起，只留一行摘要 + 最终回答。** Kimi Work 3.2.15 明说「默认收起」；Lovable「6 tools used · Show all」；Replit「N actions」图标条；Devin「Worked for 4m 1s +394 −94」；Kimi Code「标题 + 一行摘要」。【V】
7. **时长是一等信息**：Thought for 22s / Worked for 24 minutes / Usage 33s。【V】
8. **输入框上方停一条「现在在干什么」**：Manus（缩略图 + 当前步 + 3/3）、Kimi（目标 / 队列 / 集群三种胶囊）、MiniMax CLI（任务面板）。【V】
9. **右侧是「产物 / 电脑」面板，带 tab 和时间线**：Manus's computer（滑块 + Jump to live）、Devin（Worklog / Changes / Shell + Live）、Kimi side-console、豆包侧边工作台、Perplexity Labs（Tasks / Assets / App）。手机上一律变底部抽屉 / 全屏卡。【V】
10. **改动收成「版本 / 检查点卡」**，卡上直接有 预览 / 回退：Lovable、Replit、v0、Bolt。【V】
11. **「活着」的信号是扫光文字**（Kimi 2.5s、Manus 4s、Devin 2s、Z.ai、Bolt 都有 `shimmer` 文字），不是转圈。配一个呼吸的小点。【V】
12. **新内容入场 = 淡入 + 上移 6–8px + 轻微模糊**（Kimi `blur(5px)`、MiniMax `fadeInChar blur(1px)`、Z.ai `blur(8px)`），时长 .3–.4s，缓动 easeOutQuint 一类。【V】
13. **有性格的字标 / 吉祥物**：Kimi 的 3D 涂鸦字标 + Rive 团子、Devin 的人设动画（会睡觉）、Z.ai 的 Z 入场、Replit 的翻转字幕、Bolt 的完成庆祝。【V】
14. **字体**：
    - 中文产品的界面正文几乎都是**系统字体栈**，差别只在顺序：Kimi / 元宝 / 豆包把西文系统字体放前面；扣子把 PingFang SC 放最前；Z.ai 是 Geist + PingFang SC。
    - 自带的字体只用在三处：**等宽**（Geist Mono：Kimi、扣子、Z.ai、v0）、**衬线点缀**（Manus 的 Libre Baskerville + Noto Serif SC、元宝的 YB Serif UI、Z.ai 的 Iowan、扣子的 Noto Serif、Perplexity 的回答正文）、**品牌展示**（MiSans VF、Plus Jakarta Sans、ABC Oracle、GT Standard）。
    - 海外产品更爱自有无衬线：pplxSans、Camera Plain、Replit Diatype、Devin Mono、Geist。
    【V】
15. **图标**：自绘线性、24 网格、描边 1.5–1.8、圆头，渲染在 16–20px。Kimi 实测 1.8。【V】
16. **圆角是一把梯子**：4（标签）→ 8（控件）→ 10–12（行、卡）→ 16（菜单）→ 20–24（输入框、状态条）→ 胶囊。同一屏里层级越高越圆。【V】
17. **等你处理的状态有专门的视觉**：MiniMax 琥珀色 `attention-ring` + 会话列表「等待权限确认」、Devin 成果卡呼吸、Kimi 侧栏未读徽标。【V】

---

## 19. 值得偷的 15 个点子（按对 claude-web 的预期收益排序）

每条：是什么 → 具体怎么表现 → 来源。claude-web 现状参考仓库 CLAUDE.md（三栏、回合折叠、RunCard、权限停靠卡、右侧四个固定标签都已经有，缺的主要是「形」和「动」）。

### 1. 主区域做成浮在暖色底上的圆角卡，去掉栏间分割线
- 是什么：侧栏和窗口同一个底色，中栏（以及右侧面板）各是一张白卡。这是「方、硬」变「软」收益最大的一步。
- 怎么表现：`body` 和侧栏 `#fbfaf9`；主卡 `margin:6px; background:#fff; border:1px solid 黑5%; border-radius:12px`；侧栏宽 240px、没有右边线；暗色是 `#181817` 底 + `#121212` 卡。右侧面板开关时用 `flex-basis .3s ease-in-out`。
- 来源：K-main（`.app.has-sidebar .main`、`.next-sidebar`）、K-side（`.side-console-rail`）；同类：M-css（`#f8f8f7`）、LV-tok。

### 2. 输入框：24px 圆角白卡 + 36px 圆形 / 胶囊控件 + 三态圆形发送键
- 是什么：把现在的输入框换成 Kimi 这套比例。
- 怎么表现：外壳 `max-width:768px; border-radius:24px; padding:8px; border:1px solid 黑13%; box-shadow:0 5px 16px -4px 黑7%`，hover / focus-within 只加深边框（不出彩色环）；编辑区 16/24，最高 170px；底行左右两组、组内间距 8px；chip 高 36px、圆角 20px、图标 18px、`padding:0 10px 0 8px`；发送键 36px 圆：空 = 黑 15%，可发 = 黑 90% + 白箭头，运行 = 同样黑底 + 方块，`.15s` 过渡。
- 来源：K-chat（`.chat-editor`、`.send-button-container`）、K-bar（`.tool-switch`）；截图佐证 M-mob、PX-mob、LV-mob。

### 3. 颜色改成「墨色透明度」四级 + 四级填充 + 发丝线
- 是什么：文字、图标、hover、选中、分隔全部用黑 / 白的固定透明度，底色只留三四个实色。
- 怎么表现：文字 90 / 60 / 45 / 30%；填充 3 / 5 / 15 / 25%（hover = 3%，选中 = 5%，禁用按钮 = 15%）；分隔 13% 且画 `.5px`；每个 token 配 hover / active。暗色：文字 84 / 56 / 42 / 26%，填充 5 / 10 / 18 / 25%，分隔 12%。蓝 `#1783ff` 只给开着的模式、进行中、标签（淡底 = 同色 10%）。
- 来源：K-main（`:root` 252 个变量、`:root.dark` 204 个）；Manus 的暖黑版本 `#37352f0a/0f/14`（M-css）。
- 注意：claude-web 已经用 `color-mix(--fg N%)` 派生，改的主要是**档位数值**和 `.5px`。Kimi 的档位**过不了 claude-web 现有的对比度单测**（我按 WCAG 公式算的，【I】）：白底上 90% 黑 ≈ 17:1、60% 黑（`#666`）≈ 5.7:1、45% 黑（`#8c8c8c`）≈ 3.4:1、30% 黑（`#b3b3b3`）≈ 2.1:1。也就是 Kimi 的 Tertiary 只够 3:1（placeholder、时间戳这类），Quaternary 只能给禁用 / 装饰；照搬时把「次要正文」留在 60% 那一档，别降到 45%。

### 4. 工具步骤：无框的 24px 行 + 虚线连接 + 悬停才出的箭头 + 带模糊的入场
- 是什么：现在的时间线换成 Kimi 的「轻」版本。
- 怎么表现：每步一行高 24px、步距 12px；20px 图标 + 16/24 的 60% 黑文字，悬停变 90% 黑；步与步之间 `.5px dashed` 竖线（`left:10px; top:24px; bottom:-12px`）；行尾 16px 箭头平时 `opacity:0; translateX(-2px)`，悬停滑入，展开后转 90° 常显；新步骤 `opacity 0→1 + blur(5px)→0 + translateY(8px)→0`，`.38s cubic-bezier(.23,1,.32,1)`；整组外面一圈 `.5px` 边 + 圆角 12 + `padding:8px 12px`；展开的思考内容最高 268px 内滚。
- 来源：K-main（`.toolcall-flow__item`、`toolCallFlowItemIn`、`.block-container`）。

### 5. 折叠 / 展开用 `grid-template-rows` + 摘要与正文「模糊交换」
- 是什么：回合折叠（「已处理 27 秒 · …」）现在是硬切，换成有过程的。
- 怎么表现：容器 `display:grid; grid-template-rows:0fr ↔ 1fr`，时长 .48s，展开 `cubic-bezier(.25,1,.3,1)`、收起 `cubic-bezier(.55,0,.18,1)`；摘要行消失时 `opacity→0 + blur(10px) + translateY(-6px)`（.15s），正文晚 .3s 才淡入；`prefers-reduced-motion` 下全关。子内容 `min-height:0; overflow:hidden`。
- 来源：K-main（`.toolcall-flow__summary-clp`、`.toolcall-flow__summary-in`、`--clp-*`）。

### 6. 「正在…」用扫光文字 + 呼吸蓝点，替代转圈
- 是什么：RunCard、步骤行、侧栏行尾的运行态统一成一种信号。
- 怎么表现：文字 `background-image: linear-gradient(120deg, 黑60% 40%, 黑60% 50%, 黑10% 70%, 黑60% 90%); background-size:200% 100%; background-clip:text; color:transparent; animation: 2.5s linear infinite`（`background-position 100% → -100%`）；Devin 的写法用 `currentColor`，任何颜色都能套。进行中的点：8px 蓝点 + 一圈放大到 2 倍淡出。
- 来源：K-misc（`RunningText`）、K-main（`breath`）、DV-css（`.live-work-shimmer`）、M-css（`status-shimmer`）。

### 7. 输入框上方的状态胶囊做成一套：当前步骤（n/m）· 目标 · 排队
- 是什么：把 RunCard / 目标细条 / 排队消息统一成同一种可展开的小胶囊，贴在输入框上沿。
- 怎么表现：`width:fit-content; background:黑3%; backdrop-filter:blur(30px); border-radius:12px; padding:8px 12px`，hover 加深；Manus 版本是「缩略图 · ✓ 当前步骤 · 3/3 ⌃」，点开是完整计划；Kimi 的排队胶囊点开后每条可**拖动排序 / 编辑 / 删除**；集群 / 多子代理的胶囊展开成 20px 圆角的大面板，里面是子代理小卡（头像 + 名字 + 一句职责）。
- 来源：K-home（`.goal-info-bar`、`.outbox-queue`、`.swarm-status-panel`、`.agent-card`）、K-work 3.2.1、M-mob。

### 8. 模式 chip：开着 = 蓝字不加底，悬停才出淡底，悬停时图标变 ×
- 是什么：权限模式 / 深度编排 / 能力开关这类「开着的东西」的统一画法。
- 怎么表现：关着是普通墨色 chip；开着文字和图标变 `#1783ff`、底仍透明，hover 出同色 10% 淡底；带 `showClose` 的 chip 悬停时左边图标换成 ×，一下点掉。模型 chip 写成「模型名 + 灰色档位」（`K2.6 · 档位`），档位在模型菜单里是一行（左标题、右当前值 + 箭头）。
- 来源：K-bar（`.tool-switch.open`、`.showClose`、`.current-model .current-effort`、`.effort-item`）。

### 9. 菜单的一套参数 + 子菜单「安全三角」
- 是什么：所有锚定菜单（`+`、模型、权限、会话 ···）统一手感。
- 怎么表现：面板圆角 16、`padding:8px`、`box-shadow: inset 0 0 0 .5px 分隔色, 0 4px 16px 黑10%`；项 `min-height:36px`、圆角 10、hover 黑 3%；开合 `opacity + scale(.85→1)` .15s（进 `cubic-bezier(0,0,.2,1)`、出 `cubic-bezier(.4,0,1,1)`）；有二级菜单时，在触发项和子面板之间用 `clip-path: polygon()` 画一块透明梯形，鼠标斜着移过去不关。
- 来源：K-menu（`.kimi-menu`、`.kimi-menu-positioner::before`）。

### 10. 侧栏行的精确规格 + 「新对话」做成小卡 + 键帽
- 是什么：侧栏从「列表」变成「一排圆角按钮」。
- 怎么表现：导航行高 36、圆角 10、图标 18、间距 6、左右内边距 8、字 14/20；hover 黑 3%、选中黑 5%、过渡 .15s；「新对话」是带 `.5px` 边的白色小卡（圆角 12、最小高 40），hover 才出阴影 `0 3px 10px 黑10%`，行尾键帽（20px 高、圆角 4、黑 5% 底、45% 黑字）；分节标题 28px 高、灰字、箭头悬停才出；行尾标签用蓝色淡底 4px 圆角小块。会话行下面可以加一行状态小字（Devin「PR is ready · ⑂ 2」）或用状态点（MiniMax）。
- 来源：K-main（`.next-sidebar-nav-item`、`.sidebar-new-chat`、`.next-sidebar-section__title`、`…__badge`）、DV-mob、MM changelog。

### 11. 每轮改动收成「版本卡」，卡上直接预览 / 回退，并给明确的确认和 toast
- 是什么：claude-web 的「改动文件卡」升级成 Lovable / Replit 的检查点卡。
- 怎么表现：卡 = 一句改动标题 + 「正在预览最新版」/「预览这一版」+ ›，当前看的那张蓝描边淡蓝底；卡下小 chip「</> 代码」；点旧版 → 右侧面板顶上出「正在查看：xxx · ← 回到最新 · 恢复这一版」，对话里同时出确认卡（取消 / 黑色「回退」）；完成后右下 toast。Replit 版本是三个小按钮「回退到这里 · 改动 · 预览」+ 「Worked for 24 minutes」「Checkpoint made 1 hour ago」两行。Devin 把增删行数直接写在「Worked for 4m 1s +394 −94」行尾。
- 来源：LV-mob、RP-mob、DV-mob、V0 docs、BT 帮助。

### 12. 连续工具调用压成「图标条 + N 步」
- 是什么：折叠态不写一长串「读了 2 个文件 · 搜索 2 次…」，而是一排小图标 + 计数，点开才是列表。
- 怎么表现：一段说明文字后跟一行 4–6 个 14px 工具图标（终端 / 文件 / 搜索…，超出的用 ···）+ 「6 actions」；Lovable 写成「6 tools used … Show all」。和第 4、5 条配合：点开就是虚线步骤列表。
- 来源：RP-mob、LV-mob、K-codenews（v0.22.0「连续的工具调用合成可折叠的一叠」、v0.42.0「标题 + 一行摘要」）。

### 13. 有状态的品牌标记（空闲 / 思考 / 生成 / 完成 / 睡着）
- 是什么：欢迎页和运行态各有一个会动的小东西，补「性格」。
- 怎么表现：三种可选做法——（a）Kimi：SVG 字标每个字母用 `@property` 数值做 3D 挤出，入场 .66s 弹簧（`linear()` 采样曲线）、逐字错开 70ms、悬停单字弹；（b）Devin：一个小角色按状态换动画（thinking / generating / sleep / wake），空闲久了显示「went to sleep」；（c）Z.ai：标记 `scale(1.3) + blur(8px)` → 归位，随后副标题、输入框、功能入口**依次**入场。头像可以用 Rive（Kimi 的团子）。
- 来源：K-home（`make3d-doodle-logo`、`@property --kimi-*`）、K-js（`kimi_avatar_web.riv`）、DV-css（`devin-persona-*`、`ds-bot-character-eyes`）、ZA css（`placeholderZEntrance` 等）。

### 14. 右侧面板头部 52px 一行 + 时间线「回到实时」
- 是什么：文件 / 预览 / 步骤视图统一一个头，步骤视图加可拖的时间线。
- 怎么表现：头部高 52、左右内边距 10、标题 16/24 最长 180px 省略、两侧图标按钮组间距 4（返回 / 下载 / 全屏 / 关闭）；面板底部一条进度条 + ← → +「● Live」，离开最新位置时出「▶ Jump to live」胶囊；Manus 在画面上方写「正在使用 **某工具**」+ 一行在干什么。
- 来源：K-misc（`FileView .generic-header`）、M-mob（iOS Manus's computer）、DV-mob（Worklog / Shell 底栏）。

### 15. 一批小而密的细节（单个都小，合起来就是「打磨」）
- **回合导航刻度**：对话右缘一列 10×1.5px 的刻度，当前回合加深，悬停放大，点开是回合列表。（K-home `.conversation-turn-navigator`）
- **回到底部**：38px 半透明圆 + `backdrop-filter:blur(5px)`；MiniMax 的手势——单击到上一条提问、双击到顶。（K-chat、MM changelog）
- **等你确认的琥珀呼吸环**：`box-shadow 0 0 0 0 → 0 0 0 3px rgba(217,119,6,.08)`，侧栏会话行同步写「等待权限确认」。（MM css、MM changelog）
- **按下缩一点**：chip / 胶囊 `:active { transform: scale(.96) }`。（K-home）
- **深色提示条**：`#2b2b2b` 底、白字 14/20、圆角 8、带 10×4 小三角。（K-misc）
- **字号三档只作用在对话区**：`<html data-font-size>` 改 `.chat-page` 里的变量，外框不变。（K-main）
- **衬线只给一句话**：欢迎语用衬线（西文 Libre Baskerville、中文 Noto Serif SC，按 `:lang()` 切），其余全是系统无衬线；或者像元宝那样只让回答里的英文数字走衬线。（M-css、YB css）
- **等宽换 Geist Mono**（自带可变字体，一份 woff2）。（K-main、CZ css、ZA css）
- **状态文字翻转**：RunCard 里换一句状态时绕 X 轴翻 90°。（RP-css `RollingCaption`）
- **切主题水波纹**。（FL css `theme-ripple-reveal`）
- **完成时的一次性庆祝**（长任务 / 目标完成）。（BT css `forge-celebration-*`）
- **选中文字 → 引用 / 批注**：对话、文件预览、diff 里选中一段，浮出「引用」。（K-work 3.2.14、K-codenews v0.41.0）
- **换模型时提醒缓存失效**（claude-web 已有 toast，可以挪到菜单项旁）。（K-codenews v0.26.0）

---

## 20. 给后续实现的几个提醒

- Kimi 的 `.5px` 发丝线在 Windows 100% 缩放下会被取整成 1px 或 0px（不同浏览器不同）；Electron / Chromium 会画成 1 物理像素的浅线，一般可用，但对比度单测要按 1px 算。【I】
- Kimi 的 `backdrop-filter: blur(30px)` 用在很小的胶囊上，开销可接受；别用在整块面板上。【I】
- `grid-template-rows` 过渡和 `linear()` 缓动需要较新的 Chromium（Electron 44 没问题），Safari 16.4+。【I】
- 业主看到的截图是 K2.6 时期的界面；本文读的是 2026-10-10 线上的 K3 版本，导航项已经变了，但 token 和组件规格是同一套（类名里的 `next-sidebar` 说明侧栏是新写的一版）。【V】K-html / K-main
