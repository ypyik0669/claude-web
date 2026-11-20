# 人设版开场与背景（2026-11-19，界面改版方案 第 7 版 #opening）

只做了方案里的开场这一块（图标栏 / 侧栏 / 设置弹窗的改版没动）。老开场（1.6 s 的字标，2026-11-04）还在，见「桌面版」的「开场动画」；署名从「by Super」改成「by Super NB」（`OPENING_CREDIT`，两种开场和手机开屏共用）。

## 放哪一种（桌面版启动时，`desktop/src/opening-pack.ts`，纯函数 + 测试）

- 设置在 meta.json 的 `ui.opening.*`：`pack`（默认 `claude-web-chan`；`ignite` = 点火，`stars` = 星图，`ascii` = 字符雨，`cafe` = 网吧开门，见「开场 第二批」；或导入的包 id）、`when`（`always` / `daily` 默认 / `never`）、`length`（`full` 默认 / `short`）、`sound`（默认关）、`keep` + `opacity`（放完留作背景，见下）。主进程在 server 起来之前就要定，所以直接读 `<数据目录>/meta.json`（`readMetaSettings`，数据目录同 server 的 `CLAUDE_WEB_DIR` 规则）。
- `pickOpening()`：`--hidden`（开机自启）→ 老开场、不算「今天放过」；`never` → 老开场的最后一帧（`still`），不等 `openingHold`；`daily` 且 `flags.json`（userData）的 `openingDay` 是今天（本地日期）→ 老开场；其余放人设版并写 `openingDay`。包没了（删了 / 文件缺）退回点火。`main.log` 记一行 `[opening] video claude-web-chan full` / `ignite short`。
- 窗口的底色（`titleBar.bg`）按主题取开场结束时的底（`groundOf`：dark `#12110f`、light `#f7f6f2`、dracula / nord / tokyo-night / paper 各自的，system 和字符画主题跟系统），开场的黑淡出到这个颜色，应用接着淡入，不闪。

## 开场页（`desktop/src/opening.ts` 的 `fancyOpeningHtml`）

- 一页 data: URL，两种场景共用一个播放器：`kind: 'video'`（交付包 preview.html 的时间轴：片子 → 在 `logoAt` 切黑 → 黑里点亮 logo、描边、填色、高光、字标 2.25 s）和 `kind: 'ignite'`（方案的轻量版点火，简短版 2 倍速）。之后停在字标等 server（3.5 s 后出「正在启动…」），server 好了 0.7 s 把 logo 飞到左上角、黑淡成底色，然后告诉壳「放完了」。落点是应用自己 logo 的中心（缩放 1）：界面改版阶段 1 以后是侧栏左上角的 logo（应用菜单），`LOGO_TARGET` 28/34/20；Mac 的侧栏那一行先让出红绿灯（84px），`LOGO_TARGET_MAC` 99/34/20，主进程按 `logoTarget(process.platform)` 给；试放一次直接量屏幕上那个 logo。改版前是图标栏第一个按钮（26/34），Mac 上图标栏往下让了 40px，其实一直没对上。`ui-smoke` 的 right-panel-desktop 段量侧栏 logo 和这两个常量（Windows 排法、Mac 排法各一次），改侧栏顶上那一行的边距要一起改。
- **播放器是 `player.toString()` 序列化进页面的**：函数外的任何东西在页面里都不存在（常量要在函数里再写一遍，比如 `HOLD` / `IG`）。esbuild 会改字符串的引号，测试里匹配源码要用 `["']`。配置是 JSON，`<` 转义成 `\u003c`，`</script>` 断不了。
- 跳过：点一下或按任意键（修饰键、Tab、CapsLock 不算；声音按钮不算）→ 直接到字标那一帧。窗口中途被藏起来（最小化 / 收进托盘）也到那一帧；藏着的时候没有 rAF，飞行永远飞不完，所以 `startOut` 在 `document.hidden` 或减少动画时直接结束。系统或应用里的减少动画（`prefers-reduced-motion` / `ui.reduceMotion`）→ 只有最后一帧，不放片子，声音按钮和进度线也不出。
- 自动播放：带声音被拒就静音重试，再被拒出「点一下播放」。片子 6 s 不前进、或超过自己的长度 8 s 还没完 → 直接进 logo（坏片子不卡人）。
- 声音按钮（左下角）：`desktop.openingSound(on)` 告诉主进程；主进程不能写 meta.json（server 管着它），应用进来、meta 加载完后 `desktop.takeOpeningPrefs()` 取走再 `setSetting('ui.opening.sound')`（只取一次）。
- 片子从 **`cw-opening://pack/<id>/<file>`** 来：`protocol.registerSchemesAsPrivileged`（ready 之前；`standard` / `secure` / `stream` / `supportFetchAPI` / `bypassCSP`）+ `protocol.handle` → `packResponse`，支持 Range（206），不然 `<video>` 跳不到简短版的起点。只认两段安全路径、媒体扩展名，根目录依次是内置（打包后 `resources/openings`，源码跑 `desktop/openings`）和 `<数据目录>/openings`。页面 CSP：`media-src cw-opening:`（data: 页面没有 CSP 时 Electron 会报 Insecure CSP 警告；剩下那一条是应用页自己的，老问题）。
- 和主进程的握手（`fromOpening(e)`：主窗口、主 frame、data: 地址）：`desktop:opening:wait`（server 起来时 resolve）、`desktop:opening:done`、`desktop:opening:sound`、`desktop:opening:prefs`。主进程最多等 `max(页面出现 + 开场长度 + 8 s, 现在 + 3 s)`（`openingLength()`），页面坏了也不卡。应用地址带 `opening=1` → `html.opening-in` 淡入（`main.tsx` 读完就从地址里去掉）。

## 放完留作背景（`web/src/features/opening/OpeningBackdrop.tsx`）

- `.obd` 固定在 body 上、`z-index: -1`、在 `.app` 外面；`html.obd-on` 时外壳变半透明：`.app` 底色 `color-mix(surface-1 var(--obd-side))`，首页那一栏（`.pane[data-home]`，只有前面是新对话首页时才有）`var(--obd-main)`。`shellSolid(op)`：side = 100 − 0.55·浓淡，main = 100 − 浓淡（浓淡 0–60，默认 30）。对话、代码、输入框都是实色，背景只从首页和空白处透出来。
- 深色主题放包里的 `loop`（静音循环；窗口看不见或没焦点就暂停；减少动画停在第一帧）；浅色主题（light / paper：暗片子垫在浅色外壳下只会发灰）、点火、没有 loop 的包 → 火星（`embers.ts` 纯函数 + 画布 ~24 fps）。火星每种颜色先画一张「实心核 + 4.5 倍光晕」的小图再盖章，底下一层很淡的暖光；**一开始是 2 px 的实心点，隔着 70% 的外壳在浅色主题上完全看不见**（11-19 真机截图才发现）。字符画主题自己有背景时不叠。
- `ui.opening.keep` 没设过时跟着老的「背景动画」开关（`backdropOn`）：关过背景动画的人不会突然多出会动的东西。开着时首页的字流（LetterFlow）不画——`ui-smoke` 的「新对话页 … the moving backdrop behind it」因此认两种：字流的 `canvas.ascii-field`，或 `html.obd-on` + `.obd > video / canvas` + 这一栏有 `data-home`。

## 设置 › 外观「开场和背景」

- `catalog.ts`：`ui.opening.pack`（卡片，`wide: true` 让控件独占一行）/ `when` / `length` / `sound` / `keep`，一个块；`openings` 正文（动画包：从文件夹导入）在外观页底部，`wording.test.ts` 的 `BODY_SOURCE` 要登记。
- 卡片：Claude Web 娘（默认）、点火、导入的包（右上角删除，`dlg.confirm`）、「自己的视频」（桌面版系统对话框选 mp4 / webm / mov，浏览器里输入路径）。选中的包没了时显示点火（启动时实际放的也是它）。
- 排版的坑：设置行的 `.ctl` 是 `flex: none` 的横排 flex，里面的东西只有自己内容那么宽——卡片网格会缩成两列挤在一边，`wide` 的 `.ctl` 要 `display: block`；缩略图「铺满」的规则只能管 `.th` 的直接子元素（`> img` / `> svg`），否则「+」图标也被撑满整格。
- 试放一次：`PreviewFrame.tsx` 是**单独懒加载的 chunk**（开场页生成器有几十 KB；入口 chunk 上限 1,900,000 字节，加上它到过 1,855,021，拆开后 1,833 KB），iframe `sandbox="allow-scripts"` + `srcDoc`，`mode: 'preview'`：底色透明（logo 飞进真应用的角落）、片子走 server 的 `/api/opening/…?token=`（CSP `media-src http: https:`）、结束 / 声音用 `postMessage` 告诉应用。

## 动画包（`server/src/openings/`）

- 格式：一个文件夹，`opening.json` = `{ name, author?, license?, credits?, kind: 'video', intro, loop?, poster?, logoAt?, shortFrom?, maxSeconds? }`。`intro` mp4 / webm / mov（最多放 12 s，`logoAt` 是切黑点火的时刻，没写就放到 12 s 或片尾）；`loop` 是放完留在后面的循环；`poster` webp / png / jpg 是卡片缩略图。`readPack` 校验并把时间夹到范围内。内置包 `desktop/openings/claude-web-chan`（片子 10.9 MB，720P 出片放大到 1080P，见下「内置片子」；循环 1080P 2.9 MB；`electron-builder.yml` 的 `extraResources` 放进 `resources/openings`，server 从 `CLAUDE_WEB_OPENINGS` 知道在哪；值班 Bot 的子进程 env 也透传它）。
- `OpeningService`：`list()`（内置在前，同 id 内置赢）、`importFolder()`（只复制 json 里用到的文件，先进临时目录再 rename；id 来自文件夹名 `packIdFor`）、`addVideo()`（写一个只有 `intro` 的包）、`remove()`（只删导入的）。WS `openings.list / import / addVideo / remove`（导入要本机桌面窗口，`localWindowOnly`），广播 `openings.changed`；HTTP `GET /api/opening/<id>/<file>?token=` 只给 json 里点名的文件，`CSP: sandbox`。
- 二进制直接进了 git（`.gitattributes` 标了 `*.mp4 / *.webm / *.webp binary`），约 11 MB，单独一个提交；11-20 换片子又是单独一个提交（新片 10.9 MB，旧片 7.9 MB 留在历史里）。

## 内置片子（11-20 换成一镜到底）

- 第一版片子（11-19）在第 3.0 s 有一刀硬切（眼睛亮起的特写 → 全身画 logo），用户录屏说「两个场景，完全没有连贯性」。换成一个连续镜头：闭眼低头慢慢抬头，1.75 s 睁眼 → 拉远到全身，火线沿圆角方框烧一圈，r / 斜杠 / 竖线 / 圆依次点燃，炸开一圈冲击波 → 推近，手掌朝镜头托着火球 → 9.1 s 白光 → 9.67 s 全黑。`logoAt` 9.6（开场页在 `logoAt` 把最后一帧 0.25 s 淡成黑，早一点没关系），`shortFrom` 6（她站着、logo 已经烧起来、镜头开始推近）。
- 生成：Seedance 2.5，中转 `POST /v1/videos`（`seconds: '10'`、`size: '1280x720'`、`images: [http 地址…]`），`TTseadanco2.5-720` 一条 $5；1080P 那两个渠道当天不能用（`TTseadanco2.5-1080` 回「只支持 480p/720p」，`特价…-1080` 已下架，都没扣钱）。参考图：主视觉、人设表、logo 对照，加上旧片第 0 s 和第 8.67 s 的帧（告诉它开头、结尾长什么样）。出了两条，用户看完对比选了第二条。提示词、参数、费用在用户桌面「Claude Web 开场动画」文件夹的 prompts.md，不进仓库。
- 参考图要 http 地址：临时开一个只放这几张图的 cloudflared quick tunnel。**上游隔一分钟左右会再下载一次**：第一次就是拿到第一次下载就关了链接，报「第 3 个参考图片素材下载失败」（退款了）。链接要开到出片。
- 后期：`scale=1920:1080:flags=lanczos,unsharp=5:5:0.45:5:5:0`，libx264 `-preset slow -crf 19`，AAC 160k，`+faststart`（开场页边下边放）。720P 放大的细节比原生 1080P 软一点。
- 查硬切：`ffmpeg -i x.mp4 -vf "select='gte(scene,0)',metadata=print:file=sc.txt" -f null -` 拿每一帧的变化分。旧片硬切那一帧 0.28；新片白光之前每帧都低于 0.075，只有白光那一下 0.44。切黑点看 `signalstats` 的 YAVG 什么时候回到黑。
- 给用户比候选：把构建好的 `fancyOpeningHtml`（`mode: 'preview'`）塞进 iframe 的 `srcdoc`，片子用 data: URI，CSP 换成 `media-src data: blob:`；嵌进外层页面的 JSON 要把 `</` 和 `<!--` 转义。几条并排，一起从头放，双击就能看（全在一个文件里）。

## 手机网页（`PhoneSplash.tsx`）

- 手机宽度打开时盖一层：立绘（`web/src/assets/opening/portrait.webp`，包里 `character/portrait.png` 用 sharp 转的 720×1080 q76，77 KB）+ 下面 logo 和字标亮起来，1.1 s 后 0.35 s 淡出；点一下提前结束；`never` 在 meta 加载后立刻撤掉。挂载时定一次：桌面窗口后来拉窄不会出。不放视频。

## 真机验证 / 截图

- `node scripts/opening-shots.mjs <场景> [输出目录]`（先 `npm run build:all`）：临时 HOME / `CLAUDE_WEB_DIR` / `--user-data-dir`，按场景写 meta.json 和 flags.json，`--remote-debugging-port` 连 CDP，在指定时刻 `Page.captureScreenshot`；`Page.frameNavigated` 知道应用页什么时候接手；系统减少动画用 `--force-prefers-reduced-motion`；手机用 `Emulation.setDeviceMetricsOverride` + reload；最后 `taskkill /T /F` 整棵进程树。场景：full short skip reduced reducedApp light classic ignite igniteLight never sound phone settings（设置页的卡片）。
- 实测（开发版、临时目录、冷启动）：完整版开场页 0.7 s 出现、14.5 s 进应用（片子 9.7 s + logo 2.25 s + 飞 0.7 s，server 早就好了）；简短版 7.5 s（11-20 换片后，机器忙、截图脚本每张要 1.5–2.5 s：完整版 0.8 s 出现、15.1 s 进应用，简短版 9.2 s）；3 s 时点一下 → 4.5 s；老开场 2.3 s；减少动画 1.6–2.2 s；点火 5.3 s。刚 build 完、机器正忙时有一次 server 起了 104 s：开场停在最后一帧、20 s 后下面换成「电脑比较忙…」，server 好了才飞走——截图脚本等 60 s 就报 `app never came`，不是卡死。
- 控制台偶尔出现 `Electron sandboxed_renderer.bundle.js script failed to run` / `Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null`（截图脚本连着 CDP 才看得见）：**老问题，不是开场带来的**——同一台机器上用 `main`（eaa8853c）的桌面壳跑老开场 12 次有 4 次，这个分支的壳 12 次 0 次（之前零星跑二十几次里有 3 次）。出现时应用页的 preload 是好的（窗口按钮都在、`window.desktop` 在），像是 Electron 44 自己的竞态：data: → http 换进程时，新渲染进程的脚本上下文比启动数据先到（多半是那个临时文档）。对比办法：`git archive eaa8853c desktop/src` 解出来用 esbuild 编成 CJS 盖到 `desktop/dist`，跑完 `npm run build -w desktop` 换回来。

## 开场 第二批：星图 / 字符雨 / 网吧开门 / 网页动画包 / 从 GitHub 安装 / 让 Claude 做一个（2026-11-20）

方案的「六种开场」里剩下的。设置页的结构（阶段 2 在改）没动，只改了开场组件自己（`web/src/features/opening/`）和 `catalog.ts` 里开场几行的字。

### 放哪一种、开场页

- `chooseOpening(pack, { roots, cafeScript })`（`opening-pack.ts`）→ `{ kind: 'ignite' | 'stars' | 'ascii' }`（画出来的）、`{ kind: 'cafe' }`、`{ kind: 'video' | 'web', pack }`；包没了 → 点火 + `why`（`pack x missing`），网吧的脚本没 build → 点火（`the cafe script is not built`）。`main.log`：`[opening] stars full`、`[opening] web glow short`、`[opening] ignite full (pack x missing)`。
- 开场页的 `kind` 有六个：画出来的三个（`SCENES` 时间轴：ignite / stars 字标 2.05 s、飞走 3.7 s、完 4.35 s，ascii 2.1 / 3.75 / 4.4；简短版 2 倍速，所以完整约 4 s、简短约 2 s）和「先放一段、再在黑里点亮 logo」的三个（video / cafe / web，`renderLogo`，`LOGO_HOLD` 2.25 s）。星图：天上的星星飞到 logo 的轮廓上、连线亮起、圆点点燃（每颗星按笔画的顺序轮流落位，相邻两颗都到了才连上线，轮廓像是自己描出来的；**一起飞、一起连线的第一版在半路缠成一团乱线**，截图才看出来）；字符雨：代码字符一列列落下，在 logo 的形状里停住拼成一个大字符 logo（`mask()`：96×37 格、每格 10×16.2，logo 按 k = 300/1024 放在 (330, 67)），再缩成真 logo。结尾和点火一样：字标「Claude Web · by Super NB」、logo 飞到 `logoTarget`、应用淡入。减少动画 → 只有最后一帧（浅色主题有自己的纸色调色板）。
- **网吧开门能在 data: 页面里跑**：三维场景（只读借用 `features/cafe` 的 `CafeScene`）单独用 Vite 的库模式打成一个 IIFE（`web/vite.opening.config.ts` → `web/dist/opening/cafe-opening.js`，`npm run build -w web` 会一起打），开场页从壳自己的协议 `cw-opening://app/cafe-opening.js` 拿（`appFilePath`：只认这一个文件；打包后在 `app.asar/web/dist/opening/`），CSP 的 `script-src` 加 `cw-opening:`。`window.cwCafeOpening.start(canvas, { full, sign, room, width, height, first })`：灯一排排亮、有人走进来（`cafe/steps.ts` 纯函数 + 测试），完整 2.3 s / 简短 1.2 s，然后 logo 在调暗到 0.8 的网吧上点亮（不是全黑）。退回点火：没有 WebGL（先探一下）、脚本报错、4 s 内没出第一帧（`CAFE.load`）、脚本没 build（主进程就定了）。所以不用「应用起来后再放」。
- 网页动画包：`opening.json` 的 `kind: 'web'`，`entry` 默认 `index.html`（只认 .html，有大小上限 `WEB_ENTRY_MAX`），自带一切、不联网。**页面内容走 IPC**：主进程读出来（`readWebEntry`），开场页用 `desktop:opening:pack` 要（只给开场页，`fromOpening(e)`）——塞进 data: URL 会撞 Chromium 2 MB 的地址上限，从 data: 页面 fetch `cw-opening://` 又被 CORS 拦。开场页把它放进 `<iframe sandbox="allow-scripts" srcdoc>`，前面加 `packHead()`：自己的 CSP meta（`PACK_CSP`：`default-src 'none'`，只有内联脚本 / 样式，图片 / 媒体 / 字体只认 data: / blob:，connect / frame / worker / form 全 `'none'`）、关 DNS 预取、`overflow: hidden`（不然有滚动条）、`packBoot`（`cwOpening.done()` / `full` / `dark`，拿掉 WebRTC 的构造函数，错误转给开场页，试跑的测量）。srcdoc 的 frame 还继承开场页的 CSP，两层都拦 fetch（实测）；`frame-src 'none'` 拦不住 srcdoc。**CSP 里不能有 `'unsafe-eval'`**：Electron 会在控制台报「Insecure Content-Security-Policy」（ui-smoke 算失败），所以包里不能 eval / `new Function`，skill 里写了。剩下的风险：WebRTC 只在包的主 realm 里拿掉了，包自己再套一层 srcdoc 就又有了（CSP 管不到 WebRTC）；开场页里没有应用的东西可偷，最多知道「放过了」和 IP，装之前也给用户看过作者和许可。
- 网页包到 `maxSeconds`（≤ 12，`opening.json` 写）还没 `done()` → 切掉（试跑报 `cut`），换成点火（底色用包的深色）。主进程最多等的时间里算了它（`openingLength` 的 web = `maxSeconds + LOGO_HOLD`），试放一次的兜底关窗多给 4 s。

### 设置的卡片

- 顺序（`openingCards`）：内置视频包（Claude Web 娘）· 点火 · 星图 · 字符雨 · 网吧开门 · 导入的包（视频或网页）· 「自己的视频」。`OpeningCard` 每种 kind 一个成员（`kind: 'video' | 'web'` 合成一个成员时，`c.kind === 'cafe'` 之后 TS 收窄不掉，`c.pack` 报错）。缩略图是方案 `TH` 那几张 svg 的移植（`Still`），一律深色像片子的一帧；网吧开门在没有 WebGL 的电脑上副标题写「这台电脑没有 WebGL，会放点火」。
- 悬停小样（方案「卡片悬停时小窗预览」）：鼠标停 350 ms（或键盘焦点 `:focus-visible`）后在缩略图上盖一层 `.op-hover`，`CardPreview.tsx` 是单独懒加载的 chunk（开场页生成器跟着它）。视频包放 loop（没有就从 `shortFrom` 放片子），静音；其余放开场页本身的 `thumb` 模式：底色 `#13110e`、简短、不飞、不出进度线 / 声音 / 提示，画出来的三种放完 1.4 s 重来。`pointer-events: none`，点击照样落在卡片上。
- 试放一次所有卡片都能放（`requestFor`）；`preview-options.ts` 统一出参数（预览 / 小样）。网吧在应用里的地址是 server 的 `opening/cafe-opening.js`（web/dist 本来就静态服务）。
- 放完留作背景：星图留下慢慢飘的星星，字符雨留下几列慢慢落的字符（`drift.ts` 纯函数 + `OpeningBackdrop.tsx` 的 `Drift`，浅色主题也有，用纸色）；网吧开门、网页包和点火一样是火星。

### 从 GitHub 安装、让 Claude 做一个

- 从 GitHub 安装：`dlg.prompt` 要地址 → `openings.github.inspect`（只给本机桌面窗口）→ `parseGithubUrl`（`owner/repo`、仓库页、`tree/<ref>/<文件夹>`、`blob/…/opening.json`；别的一律拒，不出网）→ 用 api.github.com 的 contents 读（不带 token，每小时 60 次）→ 只下 opening.json 点名的文件、只认 raw.githubusercontent.com、每个文件有上限，先放进 `<数据目录>/openings/.tmp-gh-<token>`（不列出、不能放），15 分钟过期 → `dlg.confirm` 给用户看 作者 / 许可 / 仓库的许可（和包的不同时）/ 来自 / 类型（网页包写明沙盒、不联网、最多几秒）/ 大小 → `install`（rename 进去，id 用 `packIdFor` 并避开内置 id）或 `cancel`（删掉）。走用户的代理（`goingOut`）。
- 让 Claude 做一个：新对话、输入框里填「用 opening-pack 帮我做一个开场动画：」。`opening-pack` skill（`<数据目录>/runtime/plugins/opening/skills/opening-pack/SKILL.md`；正文和示例 萤火 来自 `server/src/openings/opening-pack.md` + `example/index.html`，`node scripts/gen-skill-text.mjs` 生成 `skill-text.ts`）+ `web` MCP 里的 `opening_guide / draft / get / save / apply / list / delete`（`opening_draft` 是 alwaysLoad）。`opening_draft` 存成草稿（`draft: true`，不出卡片）并**在用户的窗口里放一遍**：最近说过 `openings.trialHost` 的窗口收到 `openings.trial` → 试放一次的 frame 带上 `trial` → 开场页报告 结束方式 / 时刻 / 错误 / 帧时间 / 1、3、6、9 s 和结束时的截图 → 拼成一张条（`trial-report.ts`）→ `openings.trialResult` → 工具结果是文字 + 图。窗口藏着就回一句说明，不放。

### 测试、截图

- `desktop/src/opening.test.ts`、`opening-pack.test.ts`；`server/src/openings/*.test.ts`；web 的 `model / drift / trial-report / cafe/steps` 测试；ui-smoke 的 `opening` 段（用 `openSettings({ reveal: 'ui.opening.pack' })` 打开、按 `data-opening` / `data-act` 找，不依赖设置页的结构）：卡片顺序、悬停小样出现又消失、选星图 / 字符雨（设置、只亮一张、背景的 `canvas[data-drift]`）、试放一次自己放完消失、点一下跳过（直接 `sendInputEvent` 点窗口中间：点在 frame 里，click 助手的守卫看不见）、动画包三个按钮 + GitHub 拒掉非 GitHub 地址（toast，不出网）、390 宽的检查（不查 44 规则，那是设置页的）、让 Claude 做一个（只在不是工作台模式时点，不多开标签）。
- `opening-shots.mjs` 加了场景（窗口改成 1440×900）：`stars starsShort starsLight starsReduced ascii asciiShort asciiLight cafe cafeShort cafeLight cafeNoWebgl web webLight webCut cardsDark cardsLight cardsPhone cardsPhoneLight`；`packs: [...]` 先把网页包写进临时数据目录（萤火、一个永远不 `done()` 的 3 s 包），`hover: [...]` 用 CDP 把鼠标停在卡片上拍小样，`phoneOpen` 在 390×844 下打开设置。没有 WebGL 用 `--disable-webgl --disable-3d-apis`。

### 坑

- 用 tsx / esbuild 生成的测试页里 `player.toString()` 会带上 keepNames 的 `__name(...)`，页面里报 `__name is not defined`：要从 tsc 的输出（`desktop/dist/opening.js`）生成。
- Electron 截图小工具一次只跑一个任务：一个进程带好几个任务参数时什么都不出。
- 测试里从页面取配置（`configOf`）要找最后一个 `)({"kind":`：`packHead` 的 JSON 里也有 `)({`。
- 手写的英文用 `node scripts/i18n/set.mjs <file.json>`（只写用到这个 key 的目录、顺手删掉没用的）；`merge.mjs` 会把已有的译文改掉、整份重排。同一个中文 key 在 server 和 web 两边可以各有各的英文，`set.mjs` 会两边一起写，写完看一眼另一边。
