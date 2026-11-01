# 官网（2026-10-22）

`site/`：Astro 静态站，发布在 https://psycioxyxs.my/ （GitHub Pages 自定义域名，DNS 在 Cloudflare）。设计：`docs/superpowers/specs/2026-10-21-website-design.md`；
调研：`reports/Claude Web 官网设计参考调研.md`。9 月的单页旧宣传页（`site/index.html` / `page.html` / `build.mjs`）已被替换，git 历史里有。

## 跑起来

- `npm run dev --prefix site`（http://localhost:4321/）、`npm run build --prefix site`（构建 + 首次加载预算检查）、`npm run preview --prefix site`、`npm test --prefix site`。
- `npm run data --prefix site`：从 GitHub API 刷新 `site/src/data/site-data.json`（最新版本、安装包、星标）。CI 每次构建前也会跑；API 不通时用仓库里那份。
- `site/` 是独立包（自己的 lockfile 和 node_modules，`npm run site:install`），不是根 workspace：Astro 要 `cookie@2`，根目录里 express 带的是 `cookie@0.7`，放进 workspace 会解析错、构建失败，还会顺带升级产品的 vite / zod。
- 新 clone 下来先 `npm run site:install`（官网有自己的 node_modules），再跑根目录的 `npm run typecheck` / `npm test`——这两个现在也查官网；CI 里是 `npm ci --prefix site`。
- **别用 `npm install --prefix site`**（2026-10-25）：在仓库根这么跑，npm 会往 `site/package.json` 里加 `"claude-web": "file:.."`，并建一个 JUNCTION `site/node_modules/claude-web` → 仓库根；之后谁递归删 `site/node_modules`，就会顺着它把整个仓库删掉（之前 server / web / desktop 整个没了，多半就是它）。`site:install` 现在是 `cd site && npm install --no-save`：在 site 里装，不加根这个依赖，`site/package.json` / `site/package-lock.json` 不动（npm 10 不带 `--no-save` 会把锁文件里的 `libc` 字段删掉）。装完可以 `cmd /c "dir /AL /S /B site\node_modules"` 确认没有链接（应该是 File Not Found）。已经有那个 junction 的 checkout：先 `cmd /c rmdir site\node_modules\claude-web`（不带 /s，只删链接），再 `git checkout -- site/package.json site/package-lock.json`。`npm ci --prefix site` 不写 package.json，CI 照旧。
- 没有 `site/package-lock.json` 时（重新生成锁文件），进 `site/` 用 `npx -y npm@11 install`（别在根用 `--prefix site`，见上一条）：npm 10.9.4 全新安装 vitest 4.1.x 会在 npm 内部崩溃（`reading 'edgesOut'`）；有锁文件后 npm 10 正常。
- Astro 精确锁 7.4.1：7.4.2 要 Node ≥ 22.23.4，本机是 22.22.1。升级前先看 `npm view astro@<v> engines`。

## 文案

- 所有字都在 `site/src/copy.ts` 的 `tr('中文')` 里，英文在 `site/src/i18n/en.ts`（`EN_SITE`）。`scripts/i18n/scan.mjs` 的 `AREAS` 有 `site/src`，
  所以 `web/src/i18n/coverage.test.ts` 和 `node scripts/i18n/extract.mjs --check` 都管到官网；和产品同一句中文的，英文必须一样。
- `.astro` 只写结构，不写中文（`site/src/i18n/text.test.ts` 会拦）。语言名「中文 / English」在 `i18n/languages.ts`（覆盖测试的白名单里）。
- 两种语言在同一个进程里构建，所以官网不用核心的 `t()` / `setLocale`，每页用 `makeTr(locale)`（底下是 `tIn`）。
- 「详细说明」链到 README：`readmeLink(locale, '3. ')` 按英文标题开头找，中文 README 按同一位置取标题，锚点按 GitHub 的规则现算。两份 README 的标题顺序必须一致。

## 更新内容

- 更新内容页直接渲染 CHANGELOG。`changelogBody` 把代码以外像标签的 `<…>`（`<kbd>` 除外）转义掉，所以 CHANGELOG 里写 `<relay host>` 这种占位符会原样显示；有一条测试拿真的两份 CHANGELOG 跑。

## 语言和系统

- 英文在 `/`，中文在 `/zh/`。英文首页里内联了一小段脚本（`i18n/paths.ts` 的 `langRedirect` 直接序列化进页面）：浏览器是中文就跳 `/zh/`；
  带 `?lang=` 的不跳（切到英文的链接都带 `?lang=en`）。不用 localStorage。`langRedirect` 不能引用函数体外的任何东西。
- 只有从站外进来的才跳：`langRedirect(loc, navLang, referrer, base)` 里 `document.referrer` 是本站的就不跳；跳的时候保留 `#锚点`。选了英文不会跨访问记住（没有 referrer 的下一次访问照样跳），这是有意的（不用 localStorage）。
- `client/main.ts` 给 `<html>` 设 `data-os`，CSS 只显示自己系统的下载按钮（`data-os`），下载页把自己的系统排最前（`data-os-block`）。
  快捷键 D / R / C / G 找 `[data-key-action]`，同名多个时优先 `data-key-os` 等于自己系统的。按住不放的重复按键（`repeat`）不算；
  系统是 `other`（Linux / ChromeOS / 手机，没有对应安装包）时 D 去下载页（页头「下载」链接的 `data-key-action="download-page"`），不会点到 Windows 的 exe。

## 发布

- `.github/workflows/site.yml`：push main（站点、README、CHANGELOG、i18n 相关路径）或发 release 时构建并发布。
- 发 release 时不在 tag 上构建：`github-pages` 环境只允许 main 部署，所以 release 那次只跑 `redispatch`，用 `gh workflow run site.yml --ref main` 在 main 上重跑一次，下一次运行里官网就是新版本和新安装包。
- Pages 设置（已设好）：来源 GitHub Actions，自定义域名 `psycioxyxs.my`；Actions 发布不读 CNAME 文件，域名只在 Pages 设置里。
- DNS（Cloudflare，zone `psycioxyxs.my`，备注「GitHub Pages - Claude Web site」，已建好）：根域名 4 条 A（185.199.108.153 / 109.153 / 110.153 / 111.153）、
  4 条 AAAA（2606:50c0:8000::153 … 8003::153），`www` CNAME → `ypyik0669.github.io`；全部「仅 DNS」（灰云），否则 GitHub 签不出 HTTPS 证书。
- HTTPS 已强制（2026-10-22 证书签好，覆盖 `psycioxyxs.my` 和 `www`；查证书：`gh api repos/ypyik0669/claude-web/pages -q .https_certificate.state` 是 `approved`）。
- `concurrency` 是 `cancel-in-progress: false`（和 GitHub 的 Pages 模板一样）：正在发布的那次不会被打断；但同一组里 GitHub 最多只留一个排队的运行，
  更新的排队运行会顶掉还没开始的旧的（旧的显示为已取消）——不丢东西，因为每次都从 main 的最新提交构建。
- PR 上的 CI（`ci.yml`）在 `build:all` 之后跑 `npm run build:site`（Astro 构建 + 1.5 MB 预算检查，不联网），官网构建坏了合并前就能看到。
- 首页首次加载 ≤ 1.5 MB、场景 JS gzip ≤ 400 KB（`site/scripts/budget.ts`，构建时检查，超了构建失败）。
- 分享图 `site/public/og/{en,zh}.png` 由 `npm run poster --prefix site` 从海报裁出来，底部叠产品名。

## 首屏网吧（第二份计划，2026-10-22）

- 场景就是产品的网吧引擎：`site/engine.config.mjs` 给 astro 和 vitest 配别名（`@cafe/*` → `web/src/features/cafe/*`、`@characters`、`@shared`、`@/i18n` → `site/src/hero/engine-i18n.ts`），
  另有一个小插件把 `server/src/characters/core` 里的 `../../i18n/index.js` 改指到同一个垫片（不然服务端 110 KB 英文表会进包）。
  官网只经 `site/src/hero/engine.ts` 拿引擎；不引 `Cafe.tsx` / `state.ts`（zustand、WS），`AGENT_NIGHT` 抄在 `hero/palette.ts`。
- 产品的 `render()` 拆成了 `drawRoom / drawItems(pick) / darken / drawGlows / drawLight / labels`，`render()` 还是同一串调用；
  `web/src/features/cafe/render.test.ts` 用记录调用的假 Canvas 算哈希快照，画面一变就红。改产品网吧的画法时要有意识地 `-u` 更新快照。
- 引擎画的字（招牌、门口牌、小票、网管喊话）按页面 `<html lang>` 出中英；英文是 `site/scripts/engine-en.ts` 从产品两份英文表抽出来的
  `hero/engine-en.generated.ts`（`prebuild` / `pretest` 自动重生成，测试查是否最新、是否缺英文）。产品新加了引擎里的字，官网构建会因缺英文失败——先给产品补英文。
- 分层：L0 房间、L1 后面的东西、L2 前台一带（`hero/layers.ts` 的 `isFront`）、L3 只有光；L1/L2 用 multiply 压暗后要用 `destination-in` 把透明区还原。
  视差系数 0.4 / 0.7 / 1.0 / 0.55，最多 12 个原生像素；触屏关。
- 演示日 `hero/demo.ts`：60 s 循环、固定种子、按 50 ms 定步走（帧长不影响结果），`jumpTo(phase)` 给章节用。引擎没有「举手」状态，「需要你」是 DOM 权限卡；
  docs 去吃泡面靠种子（`DEMO_SEED`），改了 sim 的随机顺序要重找种子（`demo.test.ts` 会红）。
- 三档（`hero/tier.ts`）：T0 桌面鼠标 + 多于 4 核 + 真 WebGL2 → 加后处理（`hero/post.ts`）；T1 其它和手机；T2（减少动画、无 Canvas、爬虫）只有海报。
  标签页隐藏或舞台滚出视口时 rAF 停。
  T0 在真 Chrome 里验过（2026-10-23，Chrome 155 有界面 + 核显 D3D11，CDP 驱动 `npm run preview`）：后处理画面正、不黑不发白，逐章镜头和卡片都对、控制台无错。
- 首屏镜头（`hero/chapters.ts`）：桌面 `HERO_LOOK` 拉远一点、往右推，让门口牌和前台网管的气泡在文案栏（`.hero-copy`，600 px，`HERO_COPY_PX`）右边，
  1280 宽起都成立（`chapters.test.ts` 按 1280 / 1366 / 1440 / 1920 量）；手机（< 720）还用 `HERO_LOOK_PHONE` 看房间中间。保底：每帧把 `.hero-copy` 的框从标签层抹掉
  （`Scene.ts` 的 `clearKeepout`，右边和上边 32 px 渐隐），海报模式也算。产品的 `bubble()` 超过 28 个字符就截断，网管喊话的英文要短于这个（2026-10-23 改短了四句）。
- 章节卡片层 `.scene-overlays` 在 DOM 里排在 `#features` 后面（Tab 从章节进卡片按钮），不在 `#hero-scene` 里：它是贴底的 sticky
  （`bottom: 0; height: 100svh; margin-top: -100svh`），和贴顶的场景在任何滚动位置都是同一个框；`overlays.ts` 从 `[data-overlays]` 找卡片。
- 首屏海报：`npm run build --prefix site && npm run poster --prefix site`（Electron 打开 `?poster=1`，场景停在第 20 s），同时重做分享图。场景接管时显示器一台台亮，不淡入。
  界面、招牌或演示日改了就重拍。要先跑过一次 `npm run fonts --prefix site`（分享图的字用它的缓存）。
- 像素标题字：Fusion Pixel Font 12px（OFL，许可在 `site/public/fonts/OFL.txt`），按标题用到的字子集化；改了大标题 / 章节标题 / 安装标题要 `npm run fonts --prefix site`（`fonts.test.ts` 会拦）。
  只在 12 的倍数字号下清楚。
- 预算（`site/scripts/budget.ts`）：首页首屏 ≤ 1.5 MB，算 HTML 引用的、CSS `url()` 的字体、首屏脚本静态 import 的；场景（`import()` 进来的）另算，gzip 后 ≤ 400 KB。
- 冒烟：`npm run build --prefix site && env -u ELECTRON_RUN_AS_NODE node site/scripts/smoke.cjs`，逐章滚动、控制台有 error 就失败，截图在临时目录。
- 彩蛋：↑↑↓↓←→←→BA 打开调试面板（速度、种子、fps）；S 开关声音（WebAudio 合成，没有音频文件）。

## 主题放映厅（2026-10-22）

- 代码在 `site/src/showcase/`：`Showcase.astro`（构建时把配色、按钮的过程动画帧、文案写进页面）、`player.ts`（进视口前一屏才 `import()`）。主题数据直接读产品的 `web/src/themes/builtin/*/theme.json`，经别名 `@themes`（`server/src/themes/core`）/ `@web-themes`（`web/src/themes`），只用 `parsePack` / `paletteCss` / `animFor` / `frameHtml` / ticker 的 `play`。
- 配色：按钮用自己主题的变量（产品名 `--bg --accent …`），整段用当前主题的 `--sc-*`（`site/src/styles/showcase.css` 里 `@property` 注册，切换 400 ms 过渡）。对比度：`showcase/themes.test.ts` 用产品的 `contrastProblems` 和这一段实际用到的几对颜色。
- 同一秒切换：切换前先暂停旧录像，新录像 seek 到那一秒、`seeked` 后两个一起播；每次派发 `showcase:switched`（冒烟测试读它）。
  新录像加载失败：旧的也收起，露出新主题的海报；webm 失败先换 mp4 再试一次（冒烟里有一段让 garden 的录像 404）。
- 暂停（WCAG 2.2.2）：标题栏的「暂停」开关（`aria-pressed`，Tab 能到），焦点在放映厅里按空格或 K 也行。悬停只预读录像的 metadata，选中才 `auto`；
  手机和 Save-Data 不预取其它海报。
- 录像不进仓库：`site/media.json`（110 个文件的 sha256 / 字节数）+ pre-release `site-media`。构建时 `site/scripts/fetch-media.ts` 下载进 `dist/themes/`（缓存 `site/.media-cache/`）：哈希不对构建失败，下不到只警告（显示海报 / 占位）。`SITE_MEDIA=off` 跳过（PR 的 CI），`SITE_MEDIA_DIR=.media-local` 用本地的。每个文件下不到会再试两次（2 s、4 s）；`SITE_MEDIA_STRICT=1`（只在 `site.yml` 的发布构建里设）下不到也构建失败。HTML 里不能直接引 `/themes/…`（会算进首页 1.5 MB 预算）。
- 重录：`env -u ELECTRON_RUN_AS_NODE -u CLAUDE_WEB_DIST -u CLAUDE_CODE_ENTRYPOINT node scripts/record-themes.cjs [--lang] [--only]` → `node scripts/upload-site-media.cjs --dir site/.media-local`（改公开 release，先问用户）→ 提交 `site/media.json`。界面或主题改了就该重录。录制脚本**不碰 `web/dist`**：前端构建到临时目录、服务端从源码跑（开发中的 Claude Web 用着 `web/dist`，重建会把它弄坏）。一段先把原始像素写盘（约 6 GB，录完删），磁盘要留够；机器忙时帧率会掉到 24 以下，别同时跑别的重活。
- 录制剧本在 `scripts/lib/demo.cjs` 的 `scriptFor`：带 `tools` 的请求才按剧本走（标题之类的旁路请求不算），第几步 = 那句话之后的 `tool_result` 数。（历史：以前「描述一个新的」那段要指定官方运行内核，因为 ccb 把 MCP 工具包在 `ExecuteExtraTool` 里、界面不显示主题草稿卡片；现在只有官方二进制。）
- 录像要公开，右侧「连接器」只能有应用自己的（`web` / `sessions` / `preview`），不能有「连不上」（2026-10-23）。临时 HOME 下冒出来过三个不是用户机器上的：我们引擎（ccb，已删）内置的 `weixin` 插件、ccb 写死的 `mcp-chrome`、记忆服务器（从源码跑时是 `node --import tsx …/mcp.ts`，在示例项目目录里找不到 tsx，连不上）。处理：meta 设 `memory.mcp: false`（前两个随 ccb 没了；当时的 `enabledPlugins` / `--runtime` 绕法已不需要）。`demo.startServer` 还会去掉外壳带来的 `CLAUDE*` 等变量，并把 `APPDATA` / `LOCALAPPDATA` 指进临时 HOME。
- 录制前有两道闸：先用 `session.info` 读连接器（不在白名单、`failed` / `needs-auth` / 还在连都中止），再在 Electron 里读 `document.body.innerText` 和 store 里的连接器，看有没有本机的 home 路径 / 用户名；最后一帧再查一次。
- 坑（产品，没修）：官方运行内核在 `system/init` 里把 stdio 服务器报成 `pending`，`SessionRunner` 只在 `toggleMcp` 时重新问 `mcpServerStatus()`，所以面板整段对话都显示「连接中」。录制闸对还在 pending 的连接器调一次 `session.toggleMcp(enabled: true)` 刷新；「描述一个新的」那段录像里新开的对话仍会显示 `web` 「连接中」。
- 替身录像：`node scripts/make-standin-clips.cjs`（主题底色 + 测试图 + 文字），给还没真录像时构建和冒烟用。冒烟：`env -u ELECTRON_RUN_AS_NODE node scripts/site-showcase-smoke.cjs`（要先带录像构建）。
- ffmpeg：本机 8.1 没有 `libsvtav1`，webm 用 VP9（`libvpx-vp9`；`libaom-av1` 太慢，22 段要 1.5–2 小时，没用）。`media.json` 的 `webmCodecs` 记实际编码，播放器拿它问 `canPlayType`，不行就放 mp4。
  VP9 crf 46、x264 crf 30（38 / 26 时 12 s 的段 1.5–1.9 MB，大头是会动的背景和每 15 帧一个关键帧）。
- 坑：录像的 master 是 JPEG 拼的，**全范围 BT.601**。只写 `format=yuv420p` 会把「全范围」标记带进 webm：ffmpeg 解得开，Chromium 的硬件解码器在第二个关键帧（0.5 s）报 `PIPELINE_ERROR_DECODE`，放映厅只剩海报（本机 RTX 3050 + 核显，`--disable-accelerated-video-decode` 下又正常）。`encodeClip` 现在 `scale=…:out_range=tv:out_color_matrix=bt709` 并打 bt709 / tv 标记；替身录像（lavfi 源本来就是 tv）测不出这个。
- Electron 离屏窗口里视频放得很慢（14 s 才走 1.8 s），冒烟只要求过 1.5 s，别拿它量播放速度。
