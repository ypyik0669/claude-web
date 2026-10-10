# 01 · 主流桌面 / Web Agent 应用 UI/UX 调研

调研日期：2026-10-10。只读调研，没有登录任何产品、没有下载或运行安装包。

## 0. 怎么读这份报告

**标记**

- 【V:编号】= VERIFIED：在来源里看到了（文档、更新日志、公开 CSS、Mobbin 上的真实截图）。编号对应文末「来源表」的 URL。
- 【V*:编号】= 来源是第三方抓取 / 拆解 / 搜索摘要，不是官方一手材料，可信度低一档。
- 【I】= INFERRED：我的记忆或判断，没有找到可引用的来源。

**截图里的像素怎么来的**

Mobbin 返回的预览图宽 768px。Linear 的侧栏在预览图里约 124px，而第三方实测是 244px【V*:L4】，由此反推原图约 1512px 宽，换算系数约 1.97。下文所有带「≈」的像素值都是这样从截图里量出来再换算的，属于【I】，误差大约 ±10%。

**没找到的东西**（先说在前面）

- Claude Desktop 的 Code / Cowork 标签页没有找到可查看的截图，视觉数值（圆角、字号）只能从 claude.ai 和 claude.ai/code 的截图类推。
- Codex 桌面版（现在是 ChatGPT 桌面应用里的 Codex 模式）官方文档几乎不描述对话里「步骤 / 命令 / 思考」长什么样；只拿到了 Codex Web 的截图。
- Cursor 3 的 Agents Window 官方博客没有可读的截图说明；用 cursor.com/agents（Web 版，博客说桌面版内置的是同一套体验【V:U1】）的截图代替。
- Windsurf、Antigravity、Jules、Warp、Zed 的视觉数值（字体、色值、圆角）基本没有公开来源，这几节以行为为主。
- ChatGPT canvas 的帮助文章返回 403，没读到。

---

## 1. Claude（claude.ai · Claude Desktop：Chat / Cowork / Code）

### 布局与外框

- 桌面应用三个标签：Chat、Cowork、Code【V:A2】；Code 不是独立程序，从左上角的 Chat 图标悬停进入【V:A3】。
- claude.ai 侧栏 ≈ 288px【I，量自 MA1】。从上到下：衬线字的「Claude」字标 + 右侧收起按钮；`New chat`（圆圈里的 +）、`Search`、`Customize`；空一段；`Chats`、`Projects`、`Artifacts`、`Code`（Pro 账号还有 `Design`）；小号灰字分节 `Starred`、`Recents`；会话行**只有标题文字、没有图标**；底部一行：头像圆（首字母）+ 名字 + 套餐，右边一个下载图标（带蓝点）和上下箭头【V:MA1, MA17】。
- 侧栏和主区**同一个暖白底**，只靠一条极细的竖线分开；静止时主区右上角只有一个「无痕对话」幽灵图标【V:MA1】。
- 打开 Artifact 时侧栏自动收成约 48px 的图标栏，对话缩到左边约一半，右边是面板【V:MA6】。
- Code 标签页（桌面）：侧栏列出所有会话，可按状态 / 项目 / 环境筛选、按项目分组；会话的 PR 合并或关闭后可自动归档【V:A1, A2】。主区由**可拖动的窗格**组成：chat、diff、browser、terminal、file、plan、tasks、subagent（macOS 还有 iOS Simulator）；拖窗格标题换位置、拖边缘改大小、`Cmd+\` 关当前窗格；标题栏有 `Terminal` / `Changes` / `Browser` 三个按钮，窗口太窄时收进 `⋮`；窗格可以**弹出成独立窗口**再停靠回来【V:A2】。
- 按住 Cmd/Ctrl 点侧栏里的会话 = 在第二个窗格里并排打开；分屏期间再点别的会话替换当前焦点窗格【V:A2】。
- claude.ai/code（Web）侧栏很宽（≈ 600px，约占 40%）：`New session`、`Scheduled`、`All projects ▾` 筛选、按日期分组；会话行尾直接显示 `+955 -0`【V:MA9】。

### 输入框（Composer）

- claude.ai 首页：白色圆角矩形，宽 ≈ 672px，圆角 ≈ 16–20px，极细边 + 很淡的投影；两行结构：上面是文字（placeholder `How can I help you today?`），下面一行左边只有一个 `+`，右边是 `Sonnet 4.6 Adaptive ▾`（模型名深色、思考档位灰色，同一个下拉）和一个语音波形图标【V:MA1；尺寸 I】。
- 一打字，波形图标**原位换成**赤陶色的圆角方形发送按钮（白色上箭头，≈ 32px，圆角 ≈ 8px）【V:MA3】。
- 图片附件是输入框**内部顶部**的缩略图（≈ 120px 方形，圆角 ≈ 8px），文字在它下面【V:MA4】。
- 输入框下方一排建议 chip：`Write`、`Learn`、`Code`、`Life stuff`、`Claude's choice`，图标 + 文字，1px 细边，圆角 ≈ 8px【V:MA1】。
- 对话里的输入框 placeholder 变成 `Reply…`【V:MA6】。
- Code 标签页（桌面）：发送前在输入区配置四样——环境（Local / Cloud / SSH / WSL）、项目文件夹、模型（发送按钮旁的下拉）、权限模式（发送按钮旁的选择器）；`+` 里是附件、skills、connectors、plugins；`@` 提文件；拖文件进输入框【V:A2】。
- 模型选择器旁有一个**用量环**，点开看本会话上下文占用和套餐用量【V:A2】。
- 空输入框里会出现**灰色的建议下一句**，Tab 或 → 接受，直接按 Enter 不会把它发出去【V:A2】。
- 运行中：停止按钮立即中断；或者直接打字回车，纠正的话会在当前动作结束后被读到，不打断【V:A2】。
- claude.ai/code（Web）：输入框上沿贴着一条分支栏 `⎇ main ← claude/create-landing-page-Gp888 … +955 -0 [View PR]`；输入框下方另有一行权限模式 `Default`；首页时下方是 `Select a repository` 和 `☁ Default ▾` 两个带边按钮【V:MA9, MA10】。运行中右下角是一个圆形停止按钮（圆里一个方块）【V:MA8】。

### 对话渲染

- 用户消息：右对齐的浅暖灰气泡，圆角 ≈ 12–16px，无头像；助手回复**没有气泡**，正文是**衬线体**（Anthropic Serif），加粗小标题、列表都用衬线【V:MA6, MA7；字体名 V*:A7】。
- 回复下面一排图标：复制、赞、踩、重试；再下面是橙色的 Claude 星芒标志【V:MA6】。
- 思考：折叠成**一行灰色小字的过去式摘要**，例如「Ascertained connection status and sought clarification on target channel ›」，行尾一个小箭头，点开才是全文【V:MA7】。
- 工具调用（Chat）：一张细边圆角小卡，左边图标 + 名称（`Connector search`），右边灰字计数（`10 connectors`），第二行是结果摘要【V:MA7】。
- 工具调用（claude.ai/code）：**每组步骤折成一行灰字 + 左侧小箭头**，例如 `› Read 2 files`、`› Edited 2 files, ran a command`、`› Edited 2 files, searched code, read a file`、`› 1 step`；正文段落夹在这些行之间【V:MA9】。
- 工具调用（Claude Design）：通栏的浅灰药丸行，左边星芒小图标，文字是合并后的动词串 `Writing ×4, Done, Listing files`，右边向下箭头；文件产出是单独一行文件名 + 打开图标【V:MA12】。
- 进行中状态：橙色小圆点 + 橙色文字 `Pondering…`（Code Web）【V:MA8】；或橙色星芒 + 灰字 `Sauteing…`（Design）【V:MA15】。动词是随机换的趣味词【I】。桌面版流里有一个小的橙色星号，旁边显示已工作时间和消耗的 token【V:A3】。
- 桌面 Code 标签的**转录视图三档**：Normal（工具调用折成摘要）/ Thinking（再加思考）/ Verbose（每个工具调用、文件读取、中间步骤都展开），`Ctrl+O` 循环切换；Thinking 只在本会话出现过思考后才出现在菜单里【V:A2】。
- 改动汇总：Claude 改了文件后出现 `+12 -1` 这样的统计指示，点它打开 diff 查看器【V:A2】。
- `/code-review` 的结果是一张按文件分组的 **Code review 卡**，上面有 `Walk through in diff`（逐条在 diff 里走一遍，每条可 `Fix this one` 或忽略）和 `Apply fixes`【V:A2】。
- Claude 发现当前任务范围之外值得修的问题时，在对话里给一个**任务 chip**，点一下就在新会话 + 新 worktree 里开工，当前会话不受影响【V:A2】。

### Artifact / 预览 / 审阅侧面板

- Artifact 面板：左上是「预览 / 代码」两个图标的分段开关；右上 `Copy ▾`、黑色实心 `Publish`、关闭 ×；对话里对应一张卡（标题 + `Interactive artifact` 小字 + 右侧图标）【V:MA6】。
- 报错旁有 `Try fixing with Claude`，把错误详情填进新消息【V:A4】。文档里选中文字有 `Edit with Claude`【V:A4】。
- Diff 查看器（桌面 Code）：左边文件列表、右边每个文件的改动；**点任意一行出评论框**，回车加一条，多条一起用 `Cmd/Ctrl+Enter` 提交，Claude 改完出新的 diff【V:A2】。
- Browser 窗格：带标签页的内置浏览器，预览 dev server、静态 HTML、PDF、图片、视频；Claude 改完自动截图 / 点按验证（auto-verify 默认开）；标题里有 `Dev servers` 菜单【V:A2】。
- 文件窗格：点对话或 diff 里的路径打开，`Save` / `Discard`，磁盘上变了会警告；右键路径有 `Attach as context`、`Open in`、`Show in Finder/Explorer`、`Copy path`【V:A2】。
- PR 状态：开了 PR 后会话里出现 **CI 状态条**，点 `CI` 可开 `Auto-fix CI & address comments` 和 `Auto-merge when ready`【V:A2】。
- Side chat（`Cmd+;` 或 `/btw`）：从当前对话岔出去问一句，读得到主线上下文但不写回主线【V:A1, A2】。
- Cowork：任务页右侧叠三块面板——Progress（编号步骤：做完的打勾 + 删除线、进行中的高亮、没做的只是编号）、Project（指令文件、文件夹里的文件、Scratchpad 审计记录）、Context（本任务的上传文件和启用的连接器）【V*:A5】。
- Claude Design：右边是带标签页的画布；工具栏 `Tweaks` 开关、`Comment`、`Edit`、`Draw`、缩放；点画布元素弹评论小窗（`Comment` / `Send to Claude`）；待发评论以 chip 形式挂在输入框上方的粉色提示条里；底部提示多条评论会合并成一条消息发送【V:MA12, MA14, MA15】。

### 权限 / 审批

- 权限模式五种：Manual、Accept edits、Plan、Auto、Bypass permissions，发送按钮旁切换，`Cmd+Shift+M` 打开菜单；选择按文件夹记住【V:A2】。
- Manual 模式下每次改动给你看 diff，逐个接受或拒绝【V:A2】。
- 外部网站第一次被操作时出**权限卡**：`Allow once` / `Always allow` / `Deny`【V:A2】。Computer use 第一次用某个应用：`Allow for this session` / `Deny`，卡上写明这类应用的控制级别（只看 / 只点 / 完全控制），终端、访达这类还多一条警告【V:A2】。
- 提问（AskUserQuestion）在 Chat 里是**顶替输入框位置的一张卡**：标题是问题，右上角 `‹ 1 of 2 ›` 翻页和 ×；选项是带编号方块（1–4）的整行，第一项高亮并在行尾有 →；最后一行是带铅笔图标的 `Something else` 输入框和 `Skip`；卡片下面一行灰字键位提示（↑↓ 选择、Enter 确认、Esc 跳过）【V:MA7】。
- 打开的菜单里按 `1`–`9` 直接选第 N 项【V:A2】。

### 空状态 / 首页 / 引导

- claude.ai：正中一行**衬线大字问候** + 橙色星芒（`Good afternoon, Alex` / `Welcome, Sam`），下面就是输入框和一排 chip；免费账号在问候上方有一个小药丸 `Free plan · Upgrade`【V:MA1, MA5】。
- claude.ai/code：粗体无衬线标题 `Let Claude handle it`，输入框下面四张小卡 `Import issues` / `Monitor PRs` / `Implement designs` / `Add more data sources`，每张卡里是品牌图标按钮【V:MA10】。右下角有一只**橙色像素风小动物**，新会话页它站在输入框上沿【V:MA10, MA11】。
- 引导页 `Connect your terminal`：居中衬线标题 + 一张黑色终端卡片示意【V:Mobbin 4e6c7cbe，见 MA 组】。

### 微交互与动效

- Toast：右上角白底细边圆角小条，`ⓘ Connected to Slack. ×`【V:MA5】。
- 等回复时输入框上方出现一条米色横条问要不要通知，右边黑色小按钮 `Notify`【V:MA7】。
- 回复逐字流出【V:A1】；动效时长、缓动没有找到来源。
- 桌面 Code 快捷键一览 `Cmd+/`；`Cmd+N` 新会话、`Ctrl+Tab` 切会话、`Esc` 停止、`Cmd+Shift+D` diff、`Cmd+Shift+B` 浏览器、``Ctrl+` `` 终端、`Cmd+;` side chat、`Cmd+Shift+I` 模型、`Cmd+Shift+E` effort【V:A2】。
- 会话结束且你没在看它时发系统通知【V:A2】。

### 视觉语言

- 字体：Anthropic Serif（问候、回复正文、卡片标题）、Anthropic Sans（控件、标签、说明）、等宽 JetBrains Mono / Anthropic Mono；还内置 OpenDyslexic 无障碍字体【V*:A7 及搜索到的 claude.ai 样式表】。
- 字号（第三方抓取）：正文 1rem/1.5、次要 0.875rem、小标签 0.75rem 字重 500、卡片标题衬线 1.125rem【V*:A7】。
- 色：工作区底 `#FAF9F5`，表面 `#FFFFFF` / `#F2F0EA` / `#ECEAE4`，浅色描边 `#DEDCD1`；暗色底 `#141413`，暗色描边 `#30302E`；珊瑚强调 `#D97757` / `#C6613F`；链接和主按钮蓝 `#2C84DB`；红 `#B93535`；绿 `#4A7B00`【V*:A7】。暗色截图里主区 ≈ `#262624`、输入框 ≈ `#30302E`【I，看 MA2】。
- 形状：大外壳 2rem、卡片 1.75rem（多见于登录 / 营销页）【V*:A7】；应用内输入框 ≈ 16–20px、chip ≈ 8px、发送按钮 ≈ 8px【I】。几乎不用投影，靠细线。
- 图标：细线、圆头、约 1.5px 描边；印象里是 Phosphor 系（SVG viewBox 256）但**没有找到来源确认**【I】。

---

## 2. OpenAI：Codex 桌面应用 + ChatGPT

### 布局与外框

- Codex 应用 2026-02 上线 macOS，03 月上 Windows【V*:搜索摘要，developers.openai.com/codex/changelog】；现在是 ChatGPT 桌面应用里的一个模式，`Ctrl+1/2/3`（Windows 是 `Alt+1/2/3`）在 Chat / Work / Codex 之间切【V:O2】。
- 侧栏分节：`Pinned`、`Projects`、`Recents`，顶上 `New chat` + 搜索图标【V:O1】；还有 Plugins、`Scheduled`（定时任务）和设置【V*:O13】。`New chat` 右侧悬停出现 Quick chat 图标【V:O11】。
- 右侧面板从面板菜单打开：Files、Terminal、内置浏览器，Git diff 在 review 面板【V*:O13】。底部面板 `Cmd+J`、终端 ``Ctrl+` ``、文件树 `Cmd+Shift+E`、review 标签 `Ctrl+Shift+G`、**循环切换工作区布局** `Cmd+Shift+B`、全视图 `Cmd+Shift+F`【V:O2】。
- 对话可以**弹出成独立小窗**并置顶（Always on top）【V:O3】。
- 实现：Electron + React 19 + Vite，样式是 Tailwind v4 形状的产物 + CSS Modules，颜色用 OKLCH，令牌 `--color-token-*`，浮层用 Floating UI，窗口背景透明【V*:O12】。
- ChatGPT Web：侧栏 ≈ 258px，浅灰底（主区纯白）；顶上 logo + 收起；`New chat`、`Search chats`、`Images`、`Apps`、`Codex`、`Projects`，每项图标 + 文字；`Your chats` 下是纯文字行，当前行浅灰圆角底，未读在行尾一个蓝点；底部头像 + 名字 + 套餐 + `Upgrade` 药丸【V:MO4】。主区顶栏左边是 `ChatGPT ▾`（模型选择），右边 `Share` 和 `···`【V:MO4】。

### 输入框（Composer）

- ChatGPT Web：**大药丸**，宽 ≈ 640–768px，圆角 ≈ 24–28px（第三方记 26px【V*:O15】），细边 + 淡投影；两行：上面 placeholder（`Ask anything`），下面左边 `+`，接着当前工具的**蓝色文字 chip**（`Research`、`Shopping research`），右边麦克风和一个实心圆按钮【V:MO4, MO5】。
- 右下角那个圆按钮随状态换图标：空 = 黑底波形（语音模式）；有字 = 黑底上箭头；运行中 = 浅灰底黑方块（停止）【V:MO3, MO2, MO5】。
- 运行中输入框上方贴一张小提示卡（`Multitasking`：等的时候可以问别的），可 × 掉【V:MO1】。
- Codex 桌面：`+` 菜单里是 `Files and folders`、`Attach Google Chrome`、`Goal`、`Plan mode`；另有 Plugins 菜单【V:O1】。输入框周围可点的东西：模型、推理档位（各自独立可点）、项目、环境（`Work in`：`This computer` / `Cloud`，Git 项目另有 `Worktree`）、分支；**权限选择在输入框下方**（`Ask for approval` / `Approve for me` / `Full access`）【V:O8, O10；V*:O13】。
- 输入框为空时 `↑` 恢复上一条 prompt【V:O2】。设置里可选 Enter 是发送还是换行，以及「运行中发的消息是插话还是排队」【V:O3】。
- Goal 模式：输入框**上方出现一行目标进度条**，可暂停、继续、编辑、清除【V:O9】。
- Codex Web：标题 `What should we code next?`，药丸输入框下排是 `+`、仓库选择、分支选择、并行份数 `1x ▾`，右边麦克风和圆形发送（空时灰、有字时黑）【V:MO6】。

### 对话渲染

- ChatGPT：用户消息右对齐浅灰药丸气泡（第三方记圆角 18px【V*:O15】）；助手无气泡、无头像，正文无衬线；回复下一排图标：复制、赞、踩、分享、重新生成、更多【V:MO4】。
- 思考：回复上方一个 `Thought for 5s` 标签，点它在**右侧打开 Activity 面板**；重新生成不覆盖，用 `< N/N >` 翻版本【V*:O16】。
- 深度研究：对话里一张小**进度卡**（标题 + `2 sources` + 进度条 + 圆形停止钮）；右侧面板顶上是 `Activity | 23 Sources` 药丸分段；Activity 里每步一行：模型图标 + 一段第一人称的思考、放大镜 + `Searched for …`、网站 favicon + `Read reuters.com`；底部 `Stop` 和黑色 `Update`；完成后对话里留一行灰字 `Research completed in 5m · 23 sources · 63 searches`，报告本身放在一张大圆角浅投影的卡里【V:MO1, MO2, MO3】。
- Codex Web 任务页：左栏窄对话（用户 prompt 灰气泡 → `Worked for 2m 13s ›` → `Summary` 列表 → `Testing` 行带 ✅ 和命令 → `File (1) ›` 药丸行 → 赞踩 → 药丸输入框）；右边大区域 `Diff | Logs` 两个标签；顶栏是标题 + 一行元信息（日期 · 仓库 · 分支 · `+28 -0`），右边 `Archive`、`Share`、黑色 `Create PR ▾`【V:MO9】。
- Codex 桌面对话里步骤、命令、思考的具体样子：文档没有描述。只知道有内联 diff、图片预览、可下载的计划【V*:O14】。

### 审阅面板

- 默认看 Unstaged，可切 Staged / Commit / Branch / `Last turn`；多仓库时头部有仓库选择【V:O4】。
- 悬停一行 → 出现 `+` → 写评论并提交 → 在对话里发一句话让它处理【V:O4】。
- 头部 `Stage all` / `Revert all`；每个文件、每个 hunk 都能 stage / unstage / revert【V:O4】。
- 点文件名在编辑器打开；点文件名**旁边的空白**折叠 / 展开该文件；Cmd 点某一行在编辑器里跳到那行【V:O4】。
- `/review` 可以在当前对话跑，也可以在设置里改成在单独对话（Detached）里跑【V:O4】。绿 / 红计数点一下就打开 diff，可切 split 视图【V*:O13】。

### 权限 / 审批

- 审批请求打开时 `Enter` 批准、`Esc` 拒绝【V:O2】。按钮文字文档没写。
- `Approve for me` 把符合条件的请求交给自动审查，工作区边界不变【V:O8】。
- 浏览器权限按站点分 Browse / Download / Upload，各自 Requires approval / Always allow / Block【V:O3】。

### 空状态 / 首页

- Codex Web：标题 + 输入框 + `Tasks | Code reviews | Archive` 下划线标签；没有任务时是 `Start your first task` 下三张建议卡，每张一个 `Start`；Code reviews 空状态是居中小图标 + 一句话 + 黑色药丸按钮 `Enable for me`【V:MO6, Mobbin a77665fa】。
- 任务行：标题 + 灰色元信息，行尾 `Starting container` + 方形停止钮；列表加载时两条灰色骨架线【V:MO7, MO8】。

### 微交互与动效

- **状态四态和优先级**：Running / Needs input / Ready / Blocked；多个对话同时有动静时 Needs input 最优先，然后 Blocked、Ready、Running【V:O6】。
- Activity 视图：点侧栏的铃铛，或 `Cmd+Opt+U`，列出未读、运行中、等你回应的对话，可按 Work / Chat / Pinned / Scheduled 筛选，`Mark all as read`【V:O7】。
- `Cmd+Opt+A` 跳到**下一个需要处理的对话**；`Shift+Esc` 清未读；`Cmd+1–9` 跳第 N 个对话；`Cmd+Opt+1–6` 最近对话【V:O2】。
- `Cmd+Z` / `Cmd+Shift+Z` 撤销 / 重做**应用层操作**；`Cmd+Shift+T` 重开刚关的标签【V:O2】。
- Pets：一只浮在所有窗口上的小宠物，下面一排控件（铅笔 = 新对话、铃铛 = 活动托盘、语音），显示上面四种状态；`Mini` 模式只留控件不要宠物；系统开了「减少动态效果」时显示静帧【V:O6】。
- 通知：回合结束的通知可设 从不 / 仅后台 / 总是；权限请求和提问各有开关【V:O7】。`Prevent sleep while running`【V:O3】。
- Toast（Codex Web）：顶部居中绿底白字小条，带勾【V:MO8】。
- 设置 → Keyboard Shortcuts 可搜命令名，也可以**按键搜索**【V:O3】。命令面板 `Cmd+K` 或 `Cmd+Shift+P`【V:O2】。

### 视觉语言

- 外观设置：Theme（Light / Dark / System）、Accent / Background / Foreground 三个色、Contrast 滑杆、UI font、Code font、`Translucent sidebar`、`Use pointer cursors`、UI 和代码字号各 14px；主题可 `Import` / `Copy` 成一段字符串【V:O3】。
- 默认主题：浅色 Accent `#0285FF`、Background `#FFFFFF`、Foreground `#0D0D0D`、Contrast 45；深色 Accent `#339CFF`、Background `#181818`、Foreground `#FFFFFF`、Contrast 60【V*:O17】。
- ChatGPT 的字体是 OpenAI Sans（2025 年品牌更新，之前是 Söhne）【V*:搜索摘要，wallpaper.com 等】。
- ChatGPT 令牌（第三方「声明值」，该页自己说只有 8% 在线上核对到，当参考）：暗色三层 `#171717`（侧栏）/ `#212121`（主区）/ `#2F2F2F`（卡片、气泡、输入框）；圆角 6 / 8 / 12 / 16、气泡 18、输入框 26、药丸 9999；投影只给浮层（菜单 `0 4px 16px rgba(0,0,0,.12)`）；动效 120ms（hover / focus）/ 200ms（菜单、tab）/ 300ms（弹窗、抽屉）；菜单从 0.96 缩放淡入【V*:O15】。
- 图标：自家线性图标集，圆头，约 1.5px 描边【I】。

---

## 3a. Cursor

### 布局与外框

- Cursor 3（2026-04-02）新增 **Agents Window**：从头为 agent 写的界面，不是 VS Code 的延伸；本地、worktree、云端、远程 SSH 的 agent 都在同一个侧栏里，从手机 / Web / Slack / GitHub / Linear 发起的也在；命令面板 `Agents Window` 打开，可和编辑器同时开【V:U1, U2】。
- Agent Tabs：多个对话并排或宫格查看【V:U2】。
- cursor.com/agents（Web）：侧栏 ≈ 278px，浅灰底；顶上只有收起和搜索两个图标；`New Agent`、`Automations`、`Dashboard`；按 `Today` / `Yesterday` 分组；行 = 状态小图标 + 标题 + **行尾绿色 `+853`**；底部头像 + 名字 + 套餐【V:MU1】。
- 开着 agent 时是三栏：侧栏｜对话（≈ 540px）｜右面板（标签 `Setup`、`Secrets`、`Git`、`Desktop`、`Terminal`，右上角更多 / 全屏 / 收起）【V:MU1】。

### 输入框

- 首页：仓库和分支选择是输入框**上方的两段纯文字下拉**；输入框是圆角 ≈ 8–10px 的浅底矩形，无明显边框；底行左边 `Codex 5.3 High ▾`、`MCPs ▾`，可能多一个橙色警示 chip（`No test`，悬停出说明和 `Set up environment` 按钮）；右边图片图标、麦克风、**黑色圆形发送**【V:MU5, Mobbin f3446a29】。
- 模型选择器：顶上 `Use Multiple Models` 开关；列表是复选框，每个选中的模型右边一个 `1x ▾`（同一任务跑几份）；选多个后 chip 文字变成 `2x Codex 5.3 High, GPT-5.4 High, Composer 1.5`【V:MU6】。
- 文件和目录在输入框里显示成**行内药丸**【V:U3】。输入框最多长到 6 行，超过滚动；大段粘贴折成药丸【V*:U9，可能说的是 CLI】。
- 运行中打字回车 = **排队**；排队的消息按顺序列在当前任务下面，可拖动排序；`Cmd+Enter` 立刻发；`Send now` 或连按两次回车 = 在下一个工具调用处插话【V:U4】。
- `Shift+Tab` 切到 Plan 模式；输入里出现复杂任务的关键词时会建议切 Plan【V:U5】。

### 对话渲染

- 云端 agent 对话：顶部一张细边卡是用户 prompt；然后灰字 `Environment ready`、`Worked for 16m 38s`；`Walkthrough` 小标题下是**带播放按钮的录屏缩略图**和截图宫格；`Summary`、`Testing`（每行 ✅ + 行内代码）；最后 `Worked for 37s`【V:MU2, MU1】。
- 改动汇总卡：细边圆角卡，标题行 `› 7 Files Changed`，下面每个文件一行：文件类型小图标 + 文件名，**行尾绿色 `+9`**【V:MU3】。
- 输入框上方的提示条：一句话 + `Review` + 黑色主按钮（`Start new agent` / `Save`）【V:MU1】。
- 思考块可在流式过程中展开 / 折叠；agent 面板内容溢出时出现「滚到底部」按钮；todo 卡在全部完成后不再消失【V:U2】。
- 紧凑聊天模式：去掉工具图标、diff 默认折叠、空闲时收起输入框【V*:U8】。
- Checkpoints：点对话时间线里的检查点预览文件；之前的请求上有 `Restore Checkpoint`，或悬停消息出 `+`；恢复只回滚文件不删消息【V:U4】。

### 审阅面板

- 右面板 `Git` 标签：PR 标题 + 编号链接；状态药丸（`Open` 绿 / `Draft` 灰 / `Merged` 紫）+ 分支 → main；子标签 `Diff`、`Review`、`Commits 2`；右上黑色按钮随状态变：`Mark as ready` → `Squash and merge ▾`（下拉 Squash and merge / Merge / Rebase merge）→ `Merging…`（灰）→ `Finish setup`【V:MU1, MU4, MU7】。
- Diff：每个文件一张可折叠卡，头部文件名 + 绿色 `+21` + `New` / `Generated` 徽标；新增行浅绿底 + **左侧一条深绿竖线**；图片文件直接渲染预览【V:MU1, MU2】。
- 任务结束后 `Review` → `Find Issues` 跑一遍逐行审查【V:U6】。
- 新的 diffs 视图里可以直接 stage、commit、管理 PR【V:U1】。

### 权限 / 审批

- 终端命令默认在沙箱里跑，Run Mode 决定何时问【V:cursor.com/docs/agent/terminal】。按钮文字没找到来源。
- Plan 模式下改文件要等你确认计划【V*:搜索摘要，cursor.com/help/ai-features/agent】。

### 空状态 / 首页

- 输入框下三个建议 chip（`Run security audit`、`Improve AGENTS.md`、`Solve a TODO`）；再往下是**最近的 agent 卡片列表**：左边一张小缩略卡（`7 files`、`+17 -0`、状态药丸 `Draft` / `Branch` / `Merged`），右边标题 + 一行灰字（模型 · 仓库 · 多久之前）【V:MU5】。侧栏空状态只有一句灰字 `No Agents Yet`【V:MU6】。

### 微交互

- 内置浏览器 Design Mode（`Cmd+Shift+D`）：在页面上圈元素给 agent；`Shift+拖` 选区域、`Cmd+L` 把元素加进对话、`Alt+点` 加进输入框【V:U2】。
- `Cmd+K` 在 Agents Window 里搜对话，`Cmd+F` 搜当前对话【V:U4】。
- Side chat：`/side`、`/btw` 或面板顶上的 `+`；可以 @ 一个 side chat 把它的上下文拉回主线【V:U4】。

### 视觉语言

- 品牌字体 Cursor Gothic + Berkeley Mono；品牌色 `#F7F7F4`（米白）、`#14120B`（黑）、`#26251E`（深字）【V*:U10】。应用内的实际主题值没找到。
- **图标是今年重画的自家图标集**（之前是 VS Code Codicons 加零散自绘）：主尺寸 16px 网格、**1.25px 描边**（12–20px 通用）；22px 以上换 24px 网格、1.5px 描边；全部圆头、圆角，线条只走水平 / 垂直 / 45°；四种光学外形（方 / 圆 / 横 / 竖），圆画得略大以便看起来一样大；线条交汇处切小缺口防止发黑；间隙最少 3 个网格单位；600 多个图标，只给产品用得到的做实心版【V:U7】。

---

## 3b. Windsurf Cascade

- 入口：`Cmd/Ctrl+L` 或窗口右上角图标；编辑器或终端里选中的文字自动带进去【V:W1】。
- 面板左上角下拉切换同时在跑的多个 Cascade；右上角 `...`【V:W1】。
- 模式：Code（能改代码）/ Chat（只问）；模型选择在输入框下面的菜单里【V:W1】。
- 复杂任务会在对话里建 Todo 列表，并可能自己更新计划【V:W1】。
- 排队：运行中打字回车排队；**对着空输入框再按一次回车立刻发**；可以从队列里删【V:W1】。
- 回滚：悬停原 prompt，点右边的回滚箭头，或从**目录（table of contents）**里回滚；可建命名检查点；回滚不可逆【V:W1】。
- 每个 prompt 默认最多 40 次工具调用，到了出 `continue` 按钮【V:W1】。
- Problems 面板 `Send all to agent`；编辑器里选中报错点 `Explain and Fix`【V:W1】。
- 视觉数值、审批按钮文字：没找到。

## 3c. VS Code Copilot agent / Agents 窗口

### 布局

- 两个面：编辑器里的 Chat 视图，和独立的 **Agents 窗口**（跨工作区管理多个会话，随时 `Open in Editor`）【V:V1, V2】。
- Agents 窗口左侧会话列表：每项显示会话名、工作区、所用 harness（Copilot / Claude / Codex）、**文件改动统计**；默认按工作区分组，可切按时间；可建自定义分组、拖动排序、拖到 `Pinned` 置顶；悬停出 pin 和归档（这里叫 `Mark as Done`）【V:V2】。
- Chat 视图里的会话列表两种摆法：compact（列表嵌在视图里，选中后有返回按钮）和 side-by-side，右上角一个开关切换【V:V2】。
- 状态：In progress / Waiting for your input / Unread / Completed / Error；命令中心有未读徽标，点它把列表筛成未读；**应用图标角标**统计未读、等输入、PR 上 CI 失败的会话【V:V2】。
- 2026-07 起有 Modern UI 预览（`workbench.experimental.modernUI`）：侧栏、编辑区、活动栏变成**各自独立、带圆角和间隙的卡片**，菜单是浮动面板，暗色主题边框更柔、对比更低；风格来自 Agents 窗口【V*:V5】。另有毛玻璃选项 `workbench.modernUIFrostedGlass`【V*:V6】。社区有明显反对声音（嫌圆角和间隙浪费空间）【V*:github.com/microsoft/vscode/issues/326146】。

### 公开 CSS 里的具体数值（`chat.css`）【V:V4】

- 输入框：`border-radius: var(--chat-input-radius, cornerRadius-large)`，紧凑模式用 small；`padding: 0 6px 6px`；focus 时边框变 `focusBorder`。
- **运行中的输入框边框**：focus 色降到 40% 透明度，并有一个 `chat-input-working-border-spin` 动画（渐变角度 135° → 495°，线性无限循环，默认 4s）。边框状态过渡 350ms ease。
- 用户消息：`background: chat-requestBubbleBackground`、`border-radius: cornerRadius-medium`、`padding: 8px 12px`、`max-width: 90%`、`width: fit-content`。
- 工具输出块：1px 边 + `cornerRadius-medium`，`margin: 4px 0`，标题 `padding: 8px 12px`；折叠消息最高 96px，底部 24px 渐隐遮罩。
- **思考 / 进度微光**：`chat-thinking-shimmer 2s linear infinite`，`background-size: 400% 100%`，背景位置从 120% 扫到 −120%。
- 加载省略号：`steps(4, end) 1s infinite`；转圈图标 `1.5s steps(30)`。
- 折叠箭头：`opacity 100ms ease-in-out`，`transform 180ms cubic-bezier(0.2, 0, 0, 1)`；`prefers-reduced-motion` 时全部 `transition: none`。
- 字号：基准 13px；正文 `1em`、行高 1.5；xs ≈ 11px、s ≈ 12px、l ≈ 14px、xl ≈ 16px。对话区 `max-width: 950px`。
- 附件 chip：`cornerRadius-xSmall`；图片附件缩略图 88×88、large 圆角。
- 改动文件列表：1px 边、small 圆角，行 hover 用列表 hover 色。

### 改动审阅与检查点【V:V3】

- 有待处理改动的文件在资源管理器和标签上有一个**方框圆点**标记，重启后还在。
- 编辑器里浮一条控件：上 / 下跳改动，每处 `Keep` 或 `Undo`；悬停单个改动可单独接受 / 拒绝；处理完自动打开下一个有待处理改动的文件。
- `chat.editing.autoAcceptDelay`：过 N 秒自动接受，**鼠标悬停在控件上时倒计时暂停**。
- 悬停某条请求 → `Restore Checkpoint`（之后可 `Redo`）或 `Fork Conversation`；可以直接编辑之前的 prompt 重发。

---

## 4a. Google Antigravity

- 两个面：Editor（像 VS Code 的 IDE）和 Manager（agent 优先，跨工作区派发、编排、观察多个 agent）【V:G1】。`Cmd/Ctrl+E` 在两者之间切【V*:搜索摘要】。
- Manager 布局（较早的第三方描述）：三栏——左边工作区列表 + `Playground`，中间 **Inbox**（每个任务一条对话线，状态 `Idle` / `Running` / `Blocked`），右边写 prompt、看计划、审结果【V*:G5】。较新的官方 codelab：左导航是 Projects（每个项目一个齿轮）、`Conversation History`、`Schedule`，设置在左下角【V:G2】。
- 输入框：模型选择、`+` 加上下文、`@` 和 `/`【V:G2】；开始时选 Planning（先出计划）或 Fast（直接做）【V:G3】。
- **Artifacts 是核心**：任务清单、实现计划、Walkthrough（总结 + 文件 diff + 截图 / 录屏）、截图、浏览器录像；目的是让人不用读工具日志就能验收【V:G1, G2】。从右上角的 `Auxiliary Pane` 开关打开，上面显示生成了几个 artifact【V:G2】。
- 评论：像给文档加批注一样直接在 artifact 上留反馈，agent **不停下**就吸收进去【V:G1】。实现计划上有 `Proceed` 按钮【V:G2】。
- 审查策略：`Request review`（出计划或 diff 时暂停并通知你）/ `Always proceed`，另有 `Agent decides`；终端命令有允许 / 拒绝清单【V:G3, V*:G4, G5】。
- 浏览器子 agent：点击、填表、滚动、读 console；测试报告里每项测试带一张截图【V*:G5】。
- 视觉语言：没找到数值。

## 4b. Jules

- 首页：仓库选择 + 分支选择 + prompt 框，提交按钮叫 `Give me a plan`【V:J1】。
- 计划先出来给你审，批准后才动代码；不回应的话一段时间后视为批准【V:J1；V*:搜索摘要】。
- 工作视图：活动流里有紧凑 diff，后面有完整 diff 编辑器；截图里代码改动在右边，活动流里是黑色进度块和带蓝色编号的计划步骤【V*:J2】。
- 任务完成或需要你时发浏览器通知【V:J1】。
- 其余没找到。

## 4c. Gemini（Web）

- 侧栏 ≈ 288px，和主区同为白底：`New chat`（当前项是浅灰**全圆角药丸**底）、`Search chats`、`Images`、`Videos`、`Library`、`Gems`；分节 `Notebooks`、`Recents`；底部头像 + 名字 + 套餐 + 设置齿轮（带蓝点）【V:Mobbin f3b9012f】。收起后是只剩图标的细栏【V:Mobbin eeb82ce8】。
- 首页：问候语每次不同（`What's the vibe, Alex?` / `Ask away, Alex!`），无衬线大字；输入框背后有一团**很淡的蓝色光晕**【V:Mobbin f3b9012f】。
- 输入框：单行时是完整药丸（高 ≈ 64px），`+`、`Ask Gemini`、右边 `Flash ▾` 模型选择和麦克风；有字后多一个**浅蓝圆形发送钮**；附件是输入框内顶部的灰色圆角方卡（图标 + 两行文件名），此时输入框变成大圆角矩形（≈ 24–28px）【V:Mobbin e50e041f】。
- 用户气泡：右对齐浅灰，大圆角 ≈ 24px，右上角圆角更小【V:Mobbin c7dbab4c】。
- Deep Research 计划卡：浅灰大圆角卡，标题 + 三个带图标的阶段（`Research Websites` 下是灰色小字编号步骤，可 `More` 展开）+ `Ready in a few mins`；右下 `Edit plan` 文字按钮和蓝色药丸 `Start research`【V:Mobbin c7dbab4c】。
- Toast：左下角深色小条（`Renamed to …`）；tooltip 是黑色小药丸【V:Mobbin cf3591c0, cee4870c】。
- Canvas：左对话右画布；右上角 `Code`、`Show console`；应用类用右下角 `Select & ask` 圈选后提要求；文档有调整语气 / 长度 / 格式的快捷工具，右上角 `Create` 生成衍生格式【V*:GM1】。

---

## 5a. Zed agent panel

- 打开：状态栏的 ✨ 图标或 `agent: new thread`；`Cmd+N` 新线程；`+` 菜单里 `New Thread…` 可选 Zed Agent、外部 agent、`New From Summary`、`Terminal`【V:Z1】。
- 线程侧栏 `Cmd+Alt+J`，按项目分组；`Ctrl+Tab` 线程切换器；悬停线程出归档图标，或选中后 `Shift+Backspace`【V:Z1】。
- 消息编辑器：回车发送；发过的消息**点一下卡片就能改了重发**；`Shift+Alt+Esc` 放大编辑器【V:Z1】。
- 运行中的消息排队，可编辑、可删；`Send Now`（连按两次回车）；排队消息上有 `Steer` 开关，表示在下一步就送进去【V:Z1】。
- 改过文件后，你那条消息顶上出现 `Restore Checkpoint`【V:Z1】。
- **跟随 agent**：面板左下角的准星图标，开了之后编辑器跟着 agent 跳到它正在动的文件；按住 Cmd/Ctrl 发送也会开启【V:Z1】。
- 审阅：输入框上方一条**手风琴栏**汇总改了哪些文件和行数；`Review Changes`（`Shift+Ctrl+R`）打开一个多文件合并的 diff 标签页，逐 hunk 或整体接受 / 拒绝【V:Z1】。
- 工具权限：每个请求是一张工具卡，菜单里 `Allow once` / `Deny once`、`Always for <tool>`、`Always for <pattern>`（只有能安全提取出模式时才有）【V:Z2】。
- 上下文：`@` 提文件、目录、符号、旧线程、诊断、分支 diff、URL；**粘贴多行代码自动变成 @ 引用**，`Cmd+Shift+V` 才是原文粘贴【V:Z1】。
- token 用量显示在输入框里 profile 选择器旁；模型选择器里每个模型左边是厂商 logo，星标收藏，`Alt+Tab` 在收藏里轮换【V:Z1】。
- 面板底部有滚动箭头，跳到你最近一条 prompt 或线程开头【V:Z1】。
- 回复结束而 Zed 在后台时发桌面通知和提示音【V:Z1】。
- 字体：UI 默认 IBM Plex 系（别名 `.ZedSans`），等宽是 Lilex（`.ZedMono`）【V*:Z4】。
- 图标：以 Lucide 为底再改，16×16 viewBox、**1.2px 描边**、尽量落在内部 12×12 的框里，光学对齐优先于数学对齐【V:Z3】。
- 主题里没有单独给用户消息 / agent 消息设背景、边框、圆角的令牌（有人提了需求）【V*:Z5】。终端工具卡是带圆角的卡片【V*:Z6】。

## 5b. Warp

- 输入：默认自动判断你打的是 shell 命令还是给 agent 的话；`!` 前缀强制终端、`*` 前缀强制 agent，`Cmd+I` 切换（旧版 Universal Input；现在默认是专门的对话视图）【V*:P4】。
- agent 提的改动以**内联 diff 编辑器**出现在对话里，按 hunk 分组；`↑↓` 在 hunk 间走，`←→` 换文件；`Enter` = `Accept Changes`，`R` = `Refine`（用自然语言再提要求，重新出 diff），`E` = `Edit`（变成可手改的视图），`Esc` 退出【V:P1】。
- Code Review 面板四个入口：终端输入框里的 **Git diff chip**（显示改了几个文件、加减行数，tooltip `View changes`）、agent 对话底部的 `Review changes` 按钮、对话右下角的工具带 chip、标签栏右上角的按钮；快捷键 `Cmd+Shift++`【V:P2】。
- 面板从右边开出来，可拖到别处；左边文件列表，点了滚到该文件；每个文件头有文件名、改动行数、附加为上下文 / 回滚 / 在编辑器打开；头部 `Discard all` 和范围下拉（未提交 / 对比 main / 对比别的分支）；**diff 里可以直接改**；hunk 边上有回滚控件【V:P2】。
- 行内评论**攒成一批**发给正在跑的 agent，Claude Code、Codex 这类 CLI agent 也行【V:P2, V*:P5】。
- 多个对话并行时在 Agent Management Panel 里追踪【V:P3】。该面板的页面 404，没读到细节。
- 视觉数值：没找到。

## 5c. Linear（只看相关的：圆角、侧栏、命令菜单、动效）

- **内嵌卡片**：侧栏和窗口底色是同一块浅灰（≈ `#F5F5F5`），主内容是一张浮在上面的白卡——圆角 12px、四周留 8px、1px 边 `#E0E0E0`、卡面 `#FCFCFD`【V*:L4；形态 V:Mobbin 0ac97560】。
- 侧栏 244px【V*:L4】：工作区切换（头像 + 名字 + ▾）+ 搜索和新建两个图标；图标 + 文字的导航行，当前行浅灰圆角底；分节标题是小灰字 + ▾（`Workspace`、`Your teams`、`Try`）；子项缩进【V:Mobbin 0ac97560】。
- 2026-03 的刷新：侧栏**调暗几档**，不再和主区抢眼；图标更小、未选中项文字更灰、垂直留白更多；分隔线更少、更柔、端头圆；桌面标签栏不再通栏、带圆角；团队图标去掉彩色底；默认灰从偏蓝改成偏暖、更不饱和【V:L2】。
- 2024 的重做：主题只由 3 个变量生成（base 色、accent 色、contrast），用 LCH 色彩空间保证同亮度看起来一样亮；标题用 Inter Display，其余用 Inter；侧栏和标签里文字、图标、按钮横竖对齐【V:L1】。
- 列表：分组头是一条通栏浅灰圆角条（状态图标 + 名称 + 数量，行尾 +）；行 = 优先级图标 + 灰色编号 + 状态圆 + 标题 + 右对齐的**全圆角标签药丸**（彩色圆点 + 文字 + 细边）+ 头像 + 日期【V:Mobbin 0ac97560】。
- 头部标签是小药丸按钮（`All issues` / `Active` / `Backlog`），选中的有浅灰底【V:Mobbin 9ec39891】。
- 多选后底部居中浮出**操作条**：`6 selected · × | ⌘ Actions`，白底、圆角、投影【V:Mobbin 97ac166b】。
- 筛选菜单：顶上一个输入框（右边灰色键帽 `F`），下面图标 + 文字的行，二级菜单向左展开，行尾灰字计数【V:Mobbin ed670cda, 2579f037】。显示选项弹层：`List | Board` 分段、开关、属性 chip【V:Mobbin 815793b1】。
- 动效（第三方观察，作者说没看过源码）：hover 高亮、弹层、面板**进场不做动画，退场 150ms 淡出**；行 hover 背景过渡 0.12s；速度令牌 0.1s / 0.25s / 0.35s；只动 transform、opacity，偶尔 background / border，从不动布局属性；弹层从触发它的元素处缩放出来；本地优先所以几乎没有 spinner 和骨架屏【V*:L4】。另一份第三方总结：100 / 150 / 250ms 三档，缓出曲线 `cubic-bezier(0.16, 1, 0.3, 1)`【V*:L5】。
- 命令菜单 `Cmd+K`：搜的是内存里的本地数据；导航、建 issue、改状态、切主题都在里面，内容随当前页面变；界面各处都印着快捷键提示【V*:L4】。
- 字体 Inter Variable，常用字重 510，13px 为主【V*:L6】。

---

## 6. 共同模式（几乎所有产品都收敛到的做法）

1. **三栏，右栏按需出现。** 侧栏（240–290px）｜对话（正文列 ≈ 720–770px，居中）｜右面板（diff / 预览 / 活动）。右面板默认不在，点了统计数字或产物才滑出来，同时侧栏让位（Claude 收成图标栏）【V:MA6, MO1, MU1；X2】。
2. **侧栏退后，主区是主角。** 要么侧栏更灰（ChatGPT、Cursor、Linear），要么同底只留一条细线（Claude、Gemini）。会话行就是一行标题，状态放行尾：未读点、运行中转圈、`+N −M`【V:MO4, MU1, MA9, L2】。
3. **输入框是页面上唯一「有分量」的物件。** 大圆角（16–28px）+ 细边 + 很淡的投影；内部两行（上文字、下控件）；控件是无边的文字 chip（模型、模式）；整个框里只有发送按钮是实色。发送 / 语音 / 停止**共用同一个位置**，随状态换【V:MA1, MA3, MO4, MO5, Mobbin e50e041f】。
4. **用户有气泡，助手没有。** 用户消息右对齐浅灰圆角块，助手回复是直接排在页面上的正文，行高约 1.5–1.6【V:MA6, MO4, V4；X2】。
5. **过程默认折叠成一行。** 思考 = 一行摘要或 `Thought for 5s`；工具调用按组合并成「读了 2 个文件」「改了 2 个文件、跑了 1 条命令」；整轮结束后是 `Worked for 2m 13s`。想看细节再展开，或切到 Verbose 视图 / 右侧 Activity 面板【V:MA9, MO9, MU1, A2, O16】。
6. **正在进行的状态用「微光文字」而不是进度条。** 状态词上扫过一道亮带（VS Code 是 2s 线性循环）；品牌感来自状态词和小图标（Claude 的星芒和 `Pondering…`）【V:V4, MA8；X2】。
7. **改动 = 文件清单 + `+N −M`，点开进右侧审阅。** 清单在回复末尾（Cursor 的 Files Changed 卡），统计还出现在侧栏行尾、输入框上沿、标题栏；审阅里按文件折叠、新增行浅绿底【V:MU3, MA9, A2, O4】。
8. **审阅靠「行内评论，攒一批再发」。** 悬停行出 `+`，写几条，一次提交给 agent（Claude Code、Codex、Warp、Antigravity、Claude Design 都是）【V:A2, O4, P2, G1, MA15】。
9. **审批三选一，键盘直达。** 允许一次 / 总是允许 / 拒绝；Enter 批准、Esc 拒绝；权限模式是输入框旁边的一个 chip【V:A2, O2, O8, Z2】。
10. **并行会话是一等公民。** 每个会话可在独立 worktree；状态四态（运行 / 等你 / 完成未读 / 出错）；有「需要你」的汇总入口、系统通知、应用角标；PR 合并后自动归档【V:A2, O6, O7, V2, U1】。
11. **运行中照样能打字。** 回车 = 排队，另有一个「现在就发 / 插话」的动作；排队项可编辑、删除、拖动排序【V:U4, Z1, W1, A2, O3】。
12. **检查点挂在用户消息上。** 悬停某条消息出现「回到这里」；编辑旧消息 = 回滚后重发【V:U4, Z1, V3, W1】。
13. **圆角有刻度，阴影只给浮层。** 小件 6–8px、卡片 12px、弹窗 16px、输入框 24px 以上、标签和 chip 全圆；平面元素靠 1px 细线，投影只留给菜单、弹窗、输入框【V*:O15, L4；V:V4】。
14. **动效很短。** hover / 按下 ≈ 100–120ms，菜单 ≈ 150–200ms，面板 ≈ 250–350ms；进场快或没有、退场淡出；只动 transform 和 opacity；尊重 `prefers-reduced-motion`【V:V4；V*:L4, O15】。
15. **中性灰 + 一个强调色。** 语义色（绿 / 红 / 黄）只用于状态和 diff；暗色是三层灰（侧栏最深、主区居中、卡片最浅）；主题由三四个变量生成（Linear：base / accent / contrast；Codex：accent / background / foreground / contrast）【V:L1, O3；V*:O15】。
16. **自家图标，16px 网格、细描边。** Cursor 1.25px、Zed 1.2px，圆头圆角，按光学大小调整【V:U7, Z3】。
17. **首页 = 一句问候 + 居中输入框 + 几个建议 chip。** 选仓库 / 分支 / 环境的控件贴在输入框边上；有历史时下面列最近任务【V:MA1, MO6, MU5, Mobbin f3b9012f】。
18. **命令面板 + 一张快捷键表。** `Cmd+K`，`Cmd+/` 列出全部快捷键，菜单里数字键直选【V:O2, A2；V*:L4】。

---

## 7. 值得偷的 15 个点子（按对 claude-web 观感的预期提升排序）

### 1. 内嵌卡片 + 调暗的侧栏
- **是什么**：窗口底色和侧栏是同一块灰，主内容是浮在上面的一张圆角卡。
- **怎么表现**：卡片圆角 12px、四周 8px 间隙、1px 浅边；侧栏没有自己的边框，未选中项文字更灰、图标更小、行间留白更多；选中行只是一块浅灰圆角底。分屏时每个窗格各是一张卡，间隙就是分隔线。
- **来源**：https://performance.dev/how-is-linear-so-fast-a-technical-breakdown （244px / 12px / 8px）；https://linear.app/now/behind-the-latest-design-refresh ；https://linuxiac.com/microsoft-gives-visual-studio-code-a-modern-ui-preview/ ；截图 https://mobbin.com/screens/0ac97560-1aef-4907-a356-8c18c749437b
- **为什么排第一**：「方、硬」主要来自满屏直线分栏；这一条不改任何功能就能换掉整体气质。VS Code 的反对声提醒：间隙别超过 8px，并给紧凑密度留一个 0 间隙的选项。

### 2. 把输入框做成唯一的「大件」
- **是什么**：大圆角、细边、淡投影的输入框，里面只有一个实色按钮。
- **怎么表现**：圆角 20–26px；两行（文字在上，控件在下）；模型 / 权限是无边文字 chip，悬停才有底色；右下角一个 32–36px 的按钮，空时是语音、有字时是发送、运行中是停止，**原位切换**不挪位置；附件缩略图放在框内顶部；聚焦时投影加深一档（约 120ms）。
- **来源**：https://mobbin.com/screens/33b8745d-b1f7-405b-aa9c-a50c06e44ab4 ；https://mobbin.com/screens/dc0671c0-a055-45bd-92dc-42cadf7c1934 ；https://mobbin.com/screens/5c556404-2ff5-4c49-8bf1-3d796beab3d3 ；数值参考 https://oh-my-design.kr/design-systems/openai （第三方）

### 3. 运行中的输入框边框流光 + 微光状态字
- **是什么**：agent 在跑时，输入框边框有一圈缓慢转动的渐变光；状态词上扫过一道亮带。
- **怎么表现**：边框是角度渐变，135° 转到 495°，4s 线性循环，聚焦色降到 40%；状态字用 400% 宽的渐变背景，2s 线性从右扫到左；减少动态效果时两者都停。
- **来源**：https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/chat/browser/widget/media/chat.css （`chat-input-working-border-spin`、`chat-thinking-shimmer`）
- **备注**：这是公开代码里能直接照抄数值的两处动效，成本低、辨识度高。

### 4. 步骤折成「一行灰字」，不用卡片
- **是什么**：一组工具调用只占一行：小箭头 + 过去式动词短语。
- **怎么表现**：`› Read 2 files`、`› Edited 2 files, ran a command`；13px 左右的灰字，无边框、无底色、无图标；相同动作合并计数（`Writing ×4`）；正文段落夹在这些行之间；展开后才是带细边的输出块（最高约 96px，底部渐隐）。另提供三档视图（正常 / 带思考 / 全部展开），一个快捷键循环。
- **来源**：https://mobbin.com/screens/40a2b9db-e22a-4ef8-94da-7f7d6f9ba445 ；https://mobbin.com/screens/a82d3f4d-6a91-412a-aa00-a53892123f8e ；https://code.claude.com/docs/en/desktop （Transcript view、`Ctrl+O`）
- **落到 claude-web**：已有「已处理 27 秒 · 读了 2 个文件…」的折叠，差的是展开后的时间线仍然是带节点和卡片的重样式；可以改成同样的灰字行。

### 5. 字体分工：标题 / 问候用一款有性格的字，正文一款，界面一款
- **是什么**：Claude 用衬线做问候和回复正文、无衬线做控件；Linear 用 Inter Display 做标题、Inter 做其余。
- **怎么表现**：首页问候 ≈ 36–40px 的 display 字；回复正文 15–16px、行高 1.5–1.6、列宽 720–770px；界面文字 13px、字重 500 左右；元信息 12px 更灰。
- **来源**：https://mobbin.com/screens/587db0a6-6f7d-4a6a-b1ac-80ea594f7c7a ；https://fudge.design/tokens/claude.ai （第三方）；https://linear.app/now/how-we-redesigned-the-linear-ui
- **备注**：中文正文不必上衬线，但首页问候和回合标题可以用一款更有性格的字，和界面字拉开。

### 6. 图标重画到 16px 网格、1.25px 描边
- **是什么**：小尺寸专用的图标集，而不是把 24px 图标缩小。
- **怎么表现**：16px 网格 1.25px 描边（12–20px 通用），22px 以上另画一套 24px / 1.5px；圆头、圆角；线条走水平 / 垂直 / 45°；圆形略大于方形；交汇处切缺口；间隙不少于 3 格；只给需要的图标做实心版（选中态）。
- **来源**：https://www.minoradventures.co/blog/the-making-of-cursors-icons ；https://github.com/zed-industries/zed/blob/main/crates/icons/README.md （16×16、1.2px、12×12 内框）
- **落到 claude-web**：现在是 24 网格 1.75 描边缩到 16px 用，等于约 1.17px 但细节是按 24 画的，容易糊；重画常用的四五十个即可。

### 7. 动效规范：进场即时，退场 150ms，只动 transform / opacity
- **是什么**：一套很短、不对称的时长。
- **怎么表现**：hover 高亮进场 0s、退场 150ms；行 hover 背景 120ms；菜单从触发元素处缩放出现（0.96 → 1）；折叠箭头 180ms `cubic-bezier(0.2, 0, 0, 1)`；三档令牌 100 / 250 / 350ms；从不对宽高、边距做过渡。
- **来源**：https://performance.dev/how-is-linear-so-fast-a-technical-breakdown （第三方观察）；https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/chat/browser/widget/media/chat.css
- **落到 claude-web**：右侧面板现在有 240ms 的列宽过渡（动的是布局），可以改成面板自身 transform 滑入。

### 8. 提问 / 审批卡：编号选项 + 键位提示 + 翻页
- **是什么**：顶替输入框位置的一张卡，键盘可以直接答。
- **怎么表现**：标题是问题；右上 `‹ 1 of 2 ›` 和 ×；选项是整行，行首是带编号的小方块，当前项浅底 + 行尾箭头；数字键直选；最后一行是「其它」输入框 + `Skip`；卡片下一行灰字写明 ↑↓ / Enter / Esc 各干什么。审批同理：Enter 批准、Esc 拒绝。
- **来源**：https://mobbin.com/screens/34aa9592-2138-4be6-95f6-4aa7410e9bb9 ；https://learn.chatgpt.com/docs/reference/commands ；https://code.claude.com/docs/en/desktop （`1`–`9`）
- **落到 claude-web**：停靠卡已有；加编号、翻页和那行键位提示，就不必靠 placeholder 解释。

### 9. 改动统计到处可点：行尾、输入框上沿、回复末尾
- **是什么**：`+N −M` 作为进入审阅的统一入口。
- **怎么表现**：侧栏会话行尾 `+955 -0`；输入框上沿贴一条「分支 ← 工作分支 … `+955 -0` [View PR]」；回复末尾一张细边卡「7 Files Changed」，每个文件一行、行尾绿字增量；点任何一处都打开右侧审阅并滚到对应文件。
- **来源**：https://mobbin.com/screens/40a2b9db-e22a-4ef8-94da-7f7d6f9ba445 ；https://mobbin.com/screens/30b8abbf-93dd-43f7-bd8a-12a88d2ff0a4 ；https://code.claude.com/docs/en/desktop
- **落到 claude-web**：改动文件卡和会话头的统计已有；可补「输入框上沿的分支条」和侧栏行尾对未加载对话也显示统计（需服务端下发）。

### 10. 行内评论，攒一批再发
- **是什么**：在 diff（或预览）上点一行写评论，多条一起交给 agent。
- **怎么表现**：悬停行号出现 `+`；写完回车加入待发；输入框上方出现一条提示条，里面是待发评论的 chip，可逐个删；`Cmd/Ctrl+Enter` 一次提交；agent 改完出新的 diff。
- **来源**：https://code.claude.com/docs/en/desktop ；https://learn.chatgpt.com/docs/code-review?surface=app ；https://docs.warp.dev/code/code-review/ ；截图 https://mobbin.com/screens/1dc4800e-1824-4ab6-a46e-1a582a6221e7

### 11. 状态优先级 + 「下一个需要我的对话」
- **是什么**：把所有会话的状态排出先后，一个键跳过去。
- **怎么表现**：四态 Needs input > Blocked > Ready > Running；侧栏铃铛打开活动列表（未读 / 运行中 / 等回应，可筛选，可全部标已读）；一个快捷键跳到下一个需要处理的对话，另一个清未读；应用图标角标计数。
- **来源**：https://learn.chatgpt.com/docs/pets.md ；https://learn.chatgpt.com/docs/notifications.md ；https://learn.chatgpt.com/docs/reference/commands ；https://code.visualstudio.com/docs/copilot/chat/chat-sessions
- **落到 claude-web**：「需要你」分区已有；缺的是那个跳转快捷键和桌面角标。

### 12. 灰色建议下一句（Tab 接受）+ 空框 ↑ 取回上一条
- **是什么**：回复结束后，空输入框里出现一句灰色的建议 prompt。
- **怎么表现**：只在输入框为空且没有附件时显示；Tab 或 → 把它变成可编辑的真文字；直接按 Enter 不会发送它；一打字就消失。输入框为空时按 ↑ 取回上一条发过的 prompt。
- **来源**：https://code.claude.com/docs/en/desktop ；https://learn.chatgpt.com/docs/reference/commands

### 13. 主题由三四个变量生成，可导出成一段字符串
- **是什么**：用户只调 accent、background、foreground、contrast，其余全部派生。
- **怎么表现**：对比度是 0–100 的滑杆；主题可复制成一段带前缀的 JSON 字符串，粘贴即导入；另有 UI 字体、代码字体、半透明侧栏、指针光标几个开关。Linear 用 LCH 派生各层表面，保证不同色相同亮度看起来一致。
- **来源**：https://learn.chatgpt.com/docs/reference/settings ；https://linear.app/now/how-we-redesigned-the-linear-ui
- **落到 claude-web**：已经是「十来个原色 + color-mix 派生」；再往前一步是把原色降到 3–4 个并给一个对比度滑杆，顺带解决「配色不好看」时用户没法自己调的问题。

### 14. 首页：最近任务做成带状态的卡片
- **是什么**：输入框下面不是一排纯文字，而是带缩略信息的任务卡。
- **怎么表现**：每张卡左边是小预览块（文件数、`+17 −0`、状态药丸 Draft / Branch / Merged），右边标题 + 一行灰字（模型 · 项目 · 多久前）；上面是三个一键填入的建议 chip；仓库、分支选择贴在输入框上沿。
- **来源**：https://mobbin.com/screens/953e6534-bdfb-4c05-8d5b-d78a3355079c ；https://mobbin.com/screens/ce38ca22-4439-40a6-8777-0eb2d6318530

### 15. 一点有性格的小东西：吉祥物和趣味状态词
- **是什么**：不影响效率的地方放一点品牌个性。
- **怎么表现**：Claude 的新会话页有一只像素小动物站在输入框上沿；进行中的状态词是随机的趣味动词（`Pondering…`、`Sauteing…`）；Codex 有可选的浮动宠物显示四种状态，系统要求减少动效时只显示静帧，并且可以整个关掉（Mini）。
- **来源**：https://mobbin.com/screens/c66b5013-2e69-4210-995a-77c6dadbea95 ；https://mobbin.com/screens/93c81a12-7fed-46c9-9d63-27629c3d2270 ；https://learn.chatgpt.com/docs/pets.md
- **备注**：排最后是因为它锦上添花；前面十四条没做好之前，加它只会显得花哨。

**没排进前 15、但值得记一笔的**

- 跟随 agent 的准星开关（Zed）：https://zed.dev/docs/ai/agent-panel
- 粘贴多行代码自动变成 @ 引用（Zed）：同上
- 多选后的底部浮动操作条（Linear）：https://mobbin.com/screens/97ac166b-44cc-41ce-9113-43b3491ab809
- Cmd 点侧栏会话 = 并排打开；窗格可弹出成独立窗口（Claude Code 桌面）：https://code.claude.com/docs/en/desktop
- 自动接受倒计时，鼠标悬停时暂停（VS Code）：https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- 一个任务同时跑多个模型 / 多份，再比较（Cursor 模型选择器的 `1x ▾`）：https://mobbin.com/screens/5086a06b-e76b-49ad-a5e4-c2100759b758
- Walkthrough 产物：结果里直接带录屏和截图（Cursor 云端 agent、Antigravity）：https://mobbin.com/screens/cb7068e4-7d4d-4f04-9c5c-855782a96309

---

## 来源表

### Claude
- A1 https://claude.com/blog/claude-code-desktop-redesign
- A2 https://code.claude.com/docs/en/desktop
- A3 https://venturebeat.com/orchestration/we-tested-anthropics-redesigned-claude-code-desktop-app-and-routines-heres-what-enterprises-should-know
- A4 https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
- A5 https://camp-claude.github.io/learn/cowork-task-anatomy/ （第三方）
- A6 https://claude.com/product/cowork
- A7 https://fudge.design/tokens/claude.ai （第三方抓取）
- MA1 首页 https://mobbin.com/screens/33b8745d-b1f7-405b-aa9c-a50c06e44ab4
- MA2 首页暗色 https://mobbin.com/screens/77a7bdab-b92a-46d4-8abf-5d579e59d699
- MA3 有字时的发送钮 https://mobbin.com/screens/dc0671c0-a055-45bd-92dc-42cadf7c1934
- MA4 图片附件 https://mobbin.com/screens/33f11630-09ce-486e-9482-3fdf9bee9b62
- MA5 Toast https://mobbin.com/screens/41dc0527-d241-4ef3-b2d9-70ce664ff35f
- MA6 Artifact 面板 https://mobbin.com/screens/587db0a6-6f7d-4a6a-b1ac-80ea594f7c7a
- MA7 提问卡 + 思考摘要 + 工具卡 https://mobbin.com/screens/34aa9592-2138-4be6-95f6-4aa7410e9bb9
- MA8 Claude Code Web 运行中 https://mobbin.com/screens/93c81a12-7fed-46c9-9d63-27629c3d2270
- MA9 Claude Code Web 折叠步骤 + View PR https://mobbin.com/screens/40a2b9db-e22a-4ef8-94da-7f7d6f9ba445
- MA10 Claude Code Web 首页 https://mobbin.com/screens/49bc709a-3319-4473-b1ee-7a17a7876a07
- MA11 新会话 + 吉祥物 https://mobbin.com/screens/c66b5013-2e69-4210-995a-77c6dadbea95
- MA12 Claude Design 对话药丸 https://mobbin.com/screens/a82d3f4d-6a91-412a-aa00-a53892123f8e
- MA13 Claude Design 问题表单 https://mobbin.com/screens/607a00db-cf9a-40c2-a9b6-c1cb0e8eca94
- MA14 Claude Design 评论 https://mobbin.com/screens/1dc4800e-1824-4ab6-a46e-1a582a6221e7
- MA15 Claude Design 进行中 https://mobbin.com/screens/16b71c74-387d-4aa8-83ca-8b542a5c4876
- MA16 Customize / Skills https://mobbin.com/screens/3307a3b1-398c-443e-8d0d-9b2083a9a12f
- MA17 首页（含 Design、Starred）https://mobbin.com/screens/d72b17b4-df91-4813-8e5d-a04d20041570
- 引导页 Connect your terminal https://mobbin.com/screens/4e6c7cbe-e04b-4e38-a342-5f63ed88eec2

### OpenAI
- O1 https://learn.chatgpt.com/docs/features
- O2 https://learn.chatgpt.com/docs/reference/commands
- O3 https://learn.chatgpt.com/docs/reference/settings
- O4 https://learn.chatgpt.com/docs/code-review?surface=app
- O5 https://learn.chatgpt.com/docs/automations?surface=app
- O6 https://learn.chatgpt.com/docs/pets.md
- O7 https://learn.chatgpt.com/docs/notifications.md
- O8 https://learn.chatgpt.com/docs/permission-modes.md
- O9 https://learn.chatgpt.com/docs/long-running-work.md
- O10 https://learn.chatgpt.com/docs/environments/modes.md
- O11 https://learn.chatgpt.com/docs/projects.md
- O12 https://www.kitze.io/posts/codex-electron-app-technical-breakdown （第三方拆解）
- O13 https://flaviocopes.com/codex/ （第三方）
- O14 https://getpushtoprod.substack.com/p/complete-beginners-guide-to-openais （第三方）
- O15 https://oh-my-design.kr/design-systems/openai （第三方「声明值」，低置信）
- O16 https://aiuxplayground.com/teardowns/chatgpt/output/ （第三方拆解）
- O17 https://developers.openai.com/codex/app/settings （默认主题色值来自搜索摘要）
- MO1 深度研究进度卡 + Activity https://mobbin.com/screens/b045e2cd-4f54-424a-97f6-4c5954f0c1e1
- MO2 报告 + Activity https://mobbin.com/screens/1d43b453-a7b4-438f-8038-f9d5c16c903e
- MO3 研究完成 https://mobbin.com/screens/f04ce3e0-b627-4e84-a554-615d0930d8e2
- MO4 普通对话 https://mobbin.com/screens/5c556404-2ff5-4c49-8bf1-3d796beab3d3
- MO5 运行中的停止钮 https://mobbin.com/screens/c630b918-ca8d-4d44-9741-f35dcb5325e0
- MO6 Codex Web 首页 https://mobbin.com/screens/ce38ca22-4439-40a6-8777-0eb2d6318530
- MO7 Codex Web 任务行 https://mobbin.com/screens/74d12525-40a5-44f5-ad4c-079471a47a23
- MO8 Codex Web toast + 骨架 https://mobbin.com/screens/395036a8-6f8e-46aa-8c29-961f040ca027
- MO9 Codex Web 任务页 https://mobbin.com/screens/616a9efa-5fd6-4ff1-b831-2b7bd22eac70
- Code reviews 空状态 https://mobbin.com/screens/a77665fa-49d9-47f8-9819-f9eb83e464aa

### Cursor
- U1 https://cursor.com/blog/cursor-3
- U2 https://cursor.com/changelog/3-0
- U3 https://cursor.com/changelog/2-0
- U4 https://cursor.com/docs/agent/overview
- U5 https://cursor.com/docs/agent/modes
- U6 https://cursor.com/docs/agent/review
- U7 https://www.minoradventures.co/blog/the-making-of-cursors-icons
- U8 https://cursor.com/changelog/1-4 （经搜索摘要）
- U9 https://cursor.com/docs/release-notes （经搜索摘要）
- U10 https://www.designyourway.net/blog/cursor-logo/ ，https://www.loftlyy.com/en/cursor （第三方）
- MU1 agent + diff https://mobbin.com/screens/fa7df34d-7288-4c26-a0e9-95a84921e34e
- MU2 Walkthrough 录屏 https://mobbin.com/screens/cb7068e4-7d4d-4f04-9c5c-855782a96309
- MU3 Files Changed 卡 https://mobbin.com/screens/30b8abbf-93dd-43f7-bd8a-12a88d2ff0a4
- MU4 合并下拉 https://mobbin.com/screens/c4183cfb-6761-4cbc-9b05-79d0eb1e5990
- MU5 首页 + 最近 agent https://mobbin.com/screens/953e6534-bdfb-4c05-8d5b-d78a3355079c
- MU6 多模型选择 https://mobbin.com/screens/5086a06b-e76b-49ad-a5e4-c2100759b758
- MU7 Review 子标签 https://mobbin.com/screens/31d6cd67-5ba7-4025-b02c-0cccf4bf0963
- 「No test」提示 https://mobbin.com/screens/f3446a29-a899-4e74-93d4-8f2178f7c33b

### Windsurf / VS Code
- W1 https://docs.devin.ai/desktop/cascade/cascade （docs.windsurf.com 重定向到这里）
- V1 https://code.visualstudio.com/docs/copilot/agents/overview
- V2 https://code.visualstudio.com/docs/copilot/chat/chat-sessions
- V3 https://code.visualstudio.com/docs/copilot/chat/review-code-edits
- V4 https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/chat/browser/widget/media/chat.css
- V5 https://linuxiac.com/microsoft-gives-visual-studio-code-a-modern-ui-preview/
- V6 https://releasebot.io/updates/microsoft/visual-studio-code （经搜索摘要）

### Google
- G1 https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/
- G2 https://codelabs.developers.google.com/getting-started-google-antigravity
- G3 https://antigravity.google/docs/artifact-review/
- G4 https://antigravity.google/docs/settings/ ，https://antigravity.google/docs/agent-settings/ （经搜索摘要）
- G5 https://betterstack.com/community/guides/ai/antigravity-ai-ide/ （第三方）
- J1 https://jules.google/docs/
- J2 https://www.infoworld.com/article/4086269/agentic-coding-with-google-jules.html （经搜索摘要）
- GM1 https://support.google.com/gemini/answer/16047321 （经搜索摘要）
- Gemini 截图：首页 https://mobbin.com/screens/f3b9012f-3f75-433b-a9e0-c70c2a39e9bc ；临时对话 https://mobbin.com/screens/eeb82ce8-837a-4e5c-8364-621c22334f11 ；附件 https://mobbin.com/screens/e50e041f-a944-4982-ba81-067ab2e9f4ab ；toast https://mobbin.com/screens/cf3591c0-6e60-4ee1-88a8-039309a6cd1e ；tooltip https://mobbin.com/screens/cee4870c-d114-431c-8ac9-4051fc3ba8d1 ；研究计划卡 https://mobbin.com/screens/c7dbab4c-ec0a-43f3-a888-f8c21e5be86b

### Zed / Warp / Linear
- Z1 https://zed.dev/docs/ai/agent-panel
- Z2 https://zed.dev/docs/ai/tool-permissions
- Z3 https://github.com/zed-industries/zed/blob/main/crates/icons/README.md
- Z4 https://zed.dev/docs/visual-customization ，https://zed.dev/docs/reference/all-settings （经搜索摘要）
- Z5 https://github.com/zed-industries/zed/discussions/53162
- Z6 https://zed.dev/releases/preview （经搜索摘要）
- P1 https://docs.warp.dev/agents/local-agents/code-diffs/
- P2 https://docs.warp.dev/code/code-review/
- P3 https://docs.warp.dev/agents/local-agents/overview/
- P4 https://docs.warp.dev/terminal/input/universal-input/ （经搜索摘要）
- P5 https://docs.warp.dev/agents/local-agents/interactive-code-review/ （经搜索摘要）
- L1 https://linear.app/now/how-we-redesigned-the-linear-ui
- L2 https://linear.app/now/behind-the-latest-design-refresh
- L3 https://linear.app/changelog/2026-03-12-ui-refresh （经搜索摘要）
- L4 https://performance.dev/how-is-linear-so-fast-a-technical-breakdown （第三方观察，作者未看过源码）
- L5 https://blakecrosley.com/guides/design/linear （经搜索摘要，第三方）
- L6 https://open-design.ai/plugins/design-system-linear-app/ （经搜索摘要，第三方）
- Linear 截图：列表 https://mobbin.com/screens/0ac97560-1aef-4907-a356-8c18c749437b ；头部标签 https://mobbin.com/screens/9ec39891-cdbb-4d57-b0c6-de43f82c5f4e ；多选操作条 https://mobbin.com/screens/97ac166b-44cc-41ce-9113-43b3491ab809 ；显示选项 https://mobbin.com/screens/815793b1-5c75-43ac-94c7-93380781e337 ；筛选菜单 https://mobbin.com/screens/ed670cda-0527-4716-a1a6-0159f12c4f42 ，https://mobbin.com/screens/2579f037-4e90-4330-ac35-19323ca9828a

### 跨产品的模式总结（第三方）
- X1 https://www.setproduct.com/blog/ai-agent-ui-design-patterns
- X2 https://www.setproduct.com/blog/ai-chat-interface-ui-design
- X3 https://ui.shadcn.com/docs/changelog/2026-06-chat-components
