# 人设版开场与背景（2026-11-19，界面改版方案 第 7 版 #opening）

只做了方案里的开场这一块（图标栏 / 侧栏 / 设置弹窗的改版没动）。老开场（1.6 s 的字标，2026-11-04）还在，见「桌面版」的「开场动画」；署名从「by Super」改成「by Super NB」（`OPENING_CREDIT`，两种开场和手机开屏共用）。

## 放哪一种（桌面版启动时，`desktop/src/opening-pack.ts`，纯函数 + 测试）

- 设置在 meta.json 的 `ui.opening.*`：`pack`（默认 `claude-web-chan`；`ignite` = 点火；或导入的包 id）、`when`（`always` / `daily` 默认 / `never`）、`length`（`full` 默认 / `short`）、`sound`（默认关）、`keep` + `opacity`（放完留作背景，见下）。主进程在 server 起来之前就要定，所以直接读 `<数据目录>/meta.json`（`readMetaSettings`，数据目录同 server 的 `CLAUDE_WEB_DIR` 规则）。
- `pickOpening()`：`--hidden`（开机自启）→ 老开场、不算「今天放过」；`never` → 老开场的最后一帧（`still`），不等 `openingHold`；`daily` 且 `flags.json`（userData）的 `openingDay` 是今天（本地日期）→ 老开场；其余放人设版并写 `openingDay`。包没了（删了 / 文件缺）退回点火。`main.log` 记一行 `[opening] video claude-web-chan full` / `ignite short`。
- 窗口的底色（`titleBar.bg`）按主题取开场结束时的底（`groundOf`：dark `#12110f`、light `#f7f6f2`、dracula / nord / tokyo-night / paper 各自的，system 和字符画主题跟系统），开场的黑淡出到这个颜色，应用接着淡入，不闪。

## 开场页（`desktop/src/opening.ts` 的 `fancyOpeningHtml`）

- 一页 data: URL，两种场景共用一个播放器：`kind: 'video'`（交付包 preview.html 的时间轴：片子 → 在 `logoAt` 切黑 → 黑里点亮 logo、描边、填色、高光、字标 2.25 s）和 `kind: 'ignite'`（方案的轻量版点火，简短版 2 倍速）。之后停在字标等 server（3.5 s 后出「正在启动…」），server 好了 0.7 s 把 logo 飞到左上角（`LOGO_TARGET` 26/34/20，应用标题栏 logo 的位置）、黑淡成底色，然后告诉壳「放完了」。
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

- 格式：一个文件夹，`opening.json` = `{ name, author?, license?, credits?, kind: 'video', intro, loop?, poster?, logoAt?, shortFrom?, maxSeconds? }`。`intro` mp4 / webm / mov（最多放 12 s，`logoAt` 是切黑点火的时刻，没写就放到 12 s 或片尾）；`loop` 是放完留在后面的循环；`poster` webp / png / jpg 是卡片缩略图。`readPack` 校验并把时间夹到范围内。内置包 `desktop/openings/claude-web-chan`（1080P，片子 7.9 MB、循环 2.9 MB，`electron-builder.yml` 的 `extraResources` 放进 `resources/openings`，server 从 `CLAUDE_WEB_OPENINGS` 知道在哪；值班 Bot 的子进程 env 也透传它）。
- `OpeningService`：`list()`（内置在前，同 id 内置赢）、`importFolder()`（只复制 json 里用到的文件，先进临时目录再 rename；id 来自文件夹名 `packIdFor`）、`addVideo()`（写一个只有 `intro` 的包）、`remove()`（只删导入的）。WS `openings.list / import / addVideo / remove`（导入要本机桌面窗口，`localWindowOnly`），广播 `openings.changed`；HTTP `GET /api/opening/<id>/<file>?token=` 只给 json 里点名的文件，`CSP: sandbox`。
- 二进制直接进了 git（`.gitattributes` 标了 `*.mp4 / *.webm / *.webp binary`），约 11 MB，单独一个提交。

## 手机网页（`PhoneSplash.tsx`）

- 手机宽度打开时盖一层：立绘（`web/src/assets/opening/portrait.webp`，包里 `character/portrait.png` 用 sharp 转的 720×1080 q76，77 KB）+ 下面 logo 和字标亮起来，1.1 s 后 0.35 s 淡出；点一下提前结束；`never` 在 meta 加载后立刻撤掉。挂载时定一次：桌面窗口后来拉窄不会出。不放视频。

## 真机验证 / 截图

- `node scripts/opening-shots.mjs <场景> [输出目录]`（先 `npm run build:all`）：临时 HOME / `CLAUDE_WEB_DIR` / `--user-data-dir`，按场景写 meta.json 和 flags.json，`--remote-debugging-port` 连 CDP，在指定时刻 `Page.captureScreenshot`；`Page.frameNavigated` 知道应用页什么时候接手；系统减少动画用 `--force-prefers-reduced-motion`；手机用 `Emulation.setDeviceMetricsOverride` + reload；最后 `taskkill /T /F` 整棵进程树。场景：full short skip reduced reducedApp light classic ignite igniteLight never sound phone settings（设置页的卡片）。
- 实测（开发版、临时目录、冷启动）：完整版开场页 0.7 s 出现、14.5 s 进应用（片子 9.7 s + logo 2.25 s + 飞 0.7 s，server 早就好了）；简短版 7.5 s；3 s 时点一下 → 4.5 s；老开场 2.3 s；减少动画 1.6–2.2 s；点火 5.3 s。刚 build 完、机器正忙时有一次 server 起了 104 s：开场停在最后一帧、20 s 后下面换成「电脑比较忙…」，server 好了才飞走——截图脚本等 60 s 就报 `app never came`，不是卡死。
- 二十来次里有两次控制台出现 `Electron sandboxed_renderer.bundle.js script failed to run` / `Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null`：一次人设版（简短）、一次老开场，都是刚 build 完的冷启动；应用页的 preload 是好的（窗口按钮都在、`window.desktop` 在），热的时候连跑 7 次没有。看着是机器忙时 Electron 44 自己的竞态（新渲染进程的脚本上下文比启动数据先到，多半是换页时那个临时文档），和开场无关。再见到时先看应用页的 `window.desktop` 在不在。
