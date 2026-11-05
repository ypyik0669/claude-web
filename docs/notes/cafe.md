# 后台 · 网吧（3D 网吧，2026-11-05；之前一版是 3D 办公楼，再之前是 Canvas 2D 像素网吧）

用户要把 3D 办公楼换回网吧，但是 3D 的、我们自己设计的：一个等距低多边形大厅，默认夜里（霓虹、城市夜景），白天是木地板和阳光。
数据映射、左栏 / 右卡片 / 胶囊 / 面包屑 / 昼夜 / 缩放 / 拖动 / 滚轮 / Esc / 无 WebGL 列表这些交互都沿用办公楼那版，只换场景和文案。

## 数据怎么对上

- **数据只来自 `background.changed` 快照**（见 [background](background.md)）+ store 的 `open[sid]`（主对话的状态和权限请求）/ `sessions[].live`。
  网吧没有自己的服务端状态，角色库除外。
- 纯函数 `web/src/features/office/model.ts` 的 `officeModel()`（`model.test.ts`）：
  - **区 = 一个有后台任务的对话**，按 `sortSessions` 排，第一个是 A区；最多 `MAX_ZONES = 8`，多的在左栏写「还有 N 个对话没放下」。
    区的颜色按 sessionId 哈希到 `--agent-1..10`，`letter` = A、B、C…，界面上写 `tr('{z}区')`。
  - **人**：每区一个网管（主对话，`<sid>|lead`，名字 `tr('网管')`，戴帽子，站在前台后面、和自己那一排对齐）+ 客人（工作流代理 / 子代理，
    `<sid>|<taskId>|<agentKey>`）+ 后台命令（`<sid>|<taskId>|shell`，不是人，是**包间**里的一台机器）。配饰按 `agentType || label` 哈希
    （耳机 / 毛线帽 / 天线 / 蝴蝶结）。
  - 状态、计数胶囊、「等你处理」（允许 / 拒绝 / 打开对话）、「完成了」、动态、费用（`cafe/money.ts`）和办公楼那版一样。
  - **座位**（`seatBots`）：每区一排 `PCS = 6` 台电脑；没完成的客人都占一台，跨快照不变，排满时在干活的优先，坐不下的只计数；完成的给 `EXIT`
    （不要电脑，去前台结账、出门）。**包间**（`seatRooms`）是整个大厅共用的，数量 `roomsFor(区数)`，稳定，满了在跑的优先。
  - 大厅尺寸也在 model 里（`rowsFor` 至少 3 排、`hallDepth`），scene 和 seatRooms 用同一个公式。

## 场景（`office/scene.ts`，`CafeScene`，纯 three.js）

- 布局（x 向右、z 向前，镜头在右前方）：后墙左边两扇窗（墙上真的开洞，白天阳光照进来）、中间大屏（canvas 纹理的比赛画面）+ 两张对着的沙发、
  右边是门和「Claude 网吧」霓虹招牌；左墙是零食架，左边一列玻璃包间（屏幕 + 状态灯 + 霓虹门牌）；中间每区一排电脑（桌、隔板顶上一条区色灯带、
  显示器、键盘、机箱灯、矮背椅，排头一根杆子挂区牌）；右边主过道 + 一条长前台，网管站在前台后面，前台上有收银机和区牌小立卡。
  外面是地面、街和 InstancedMesh 的楼（夜里窗户亮）。静态的大厅按区数重建（`buildHall`），每排一个 `Mats`（区色、变暗用）。
- 材质：`Mats` 每个颜色存白天 / 夜里两值，`tint(t)` 插值，`dim` 让不在焦点的区暗一点（不移走）。霓虹 / 屏幕是 `MeshBasicMaterial`（`toneMapped: false`）。
  夜里另有粉 / 青两盏点光（招牌、大屏）、前台一盏暖光、每排一盏区色光。
- 屏幕：在干活 = 自己一份克隆的代码纹理往上滚（`offset.y`）+ 轻微闪；等你 = 黄色「?」对话框；卡住 = 蓝屏 + 红「!」；人走开了 = 屏保；没人 = 黑。
  包间：在跑 = 绿灯 + 终端字，失败红灯。
- 人：默认是小章鱼（球头 + 六条腿 + 眼睛腮红 + 两只手 + 配饰），有自定义角色时是 `Sprite`（`bakeCharacter`，NearestFilter）+ 影子。
  坐着打字两只手交替点、等你举右手挥、卡住低头抖、走路上下颠 + 腿摆 + 手甩，转身缓动。
- **走路**：不是 A*，大厅是规整的，每个地点（`Spot`）带一条「到主过道」的出口折线：电脑 → 那排后面的走道 → 主过道；休息点 → 休息区前的横道 → 主过道；
  前台结账点 / 门直接在主过道上。`route(a, b)` = a 的出口 + b 的出口倒过来 + b，所以只走过道。状态机在 `want()`：
  在干活 / 等你 / 卡住 → 电脑；歇着 → 坐一会儿去沙发 / 窗边 / 零食架 / 饮水机（占了的不去）再回来；完成 → 去前台结账（HTML 小票弹出，
  `data-phase="pay"`）几秒后出门，过了门洞缩没；新来的（场景已经有人之后才出现的）从门外走进来。换区（排序变了）直接瞬移。
- 镜头：`goal` / `cur` 两份轨道参数指数缓动；`focus(i)` 飞到那一排（target 在排和前台之间，网管也在画面里），`focus(-1)` 整个网吧；
  `fit()` 扣掉左栏 / 右卡片（`setViewOffset`）。
- 循环：rAF；`step()` 返回 0 静止 / 1 只有环境动（呼吸、霓虹）/ 2 真在动（镜头、走路、打字、挥手、淡入淡出）：2 每帧画，1 限 24 fps，0 不画；
  `visible` 假或 `document.hidden` 不画；reduced motion 时一步到位、不走路（歇着的就在电脑前、完成的停在前台）、不晃、不闪。
- HTML 叠层：`[data-anchor="zone:i" | "bot:<id>"]`，每帧投影 `translate3d`；人的按钮还带 `data-phase`（walk / sit / stand / pay / room）。
- `pick(x,y)`：先射线打人（包间机器是一个不可见的盒子），再打每排的包围盒（含前台那一段）→ `{ bot }` / `{ zone }`。

## 外壳

- `office/Office.tsx`（文件夹名没改，还是 `office/`；类名 `office-*` 也没改，ui-smoke 和 readme-shots 用它们）：胶囊、左栏「各区」、卡片、面包屑
  「整个网吧 › A区 名字」、「看这一区」、缩放 ±、昼夜（设置 `office.light`，存 meta.json）、角色库。拿不到 WebGL → 按区分组的列表。
- `office/OfficePanel.tsx`：右侧面板 extra 标签（panel id 仍是 `cafe`，标题「网吧」，图标 cafe），compact，跟着当前对话那一区。
- 挂载点：`BackgroundPage` 顶上一大块（`lazy()`，three.js 独立 chunk）。样式 `styles/office.css`（`.ob-receipt` 小票、`.ob-bang` 感叹号、区签居中在锚点上方）。
- **角色库保留**（`server/src/characters/`、`character_*` 工具、cafe-character skill、`cafe/state.ts`、`cafe/bake.ts`、`cafe/CharacterLibrary.tsx`）；
  只有非内置角色才贴成 billboard（内置小章鱼 = 默认 3D 小章鱼）。
- **旧的 Canvas 网吧引擎** `cafe/sim.ts / render.ts / map.ts / path.ts / iso.ts / money.ts` **留着**：官网 `site/src/hero/` 经 `@cafe/*` 用它，别删。

## 调试

- `window.__cwBackground.inject(session)` + `open(sid)` 造场景；`window.__cwCafe` 是当前的 `CafeScene`（`frames`、`focus(i)`、`setNight()`、`dims`）。
- 截图：`scripts/shot.cjs` + `SHOT_JS_FILE`；演示数据和脚本在本机 `%TEMP%\office-shots\demo.js`、`%TEMP%\cafe3d-shots\shot.sh`
  （`shot.sh <名字> day|night [区的 sid] [人名前缀]`，`EXTRA=` 追加 JS，比如几秒后 inject 新客人拍走进门的样子）。自己起 server 用临时 HOME /
  `CLAUDE_WEB_DIR`、`PORT=3197`，去掉继承的 `CLAUDE_*` / `ANTHROPIC_*` / `ELECTRON_RUN_AS_NODE`；server 用 run_in_background 起。
  截图的 console 不进 log，要看运行时的值就往页面里插一个 div 再拍。裁细节用 `sharp`（`extract`）。
- ui-smoke background 段：`.office-bot` ≥ 6（网管 + 5）、`aria-label^="网管"`、A区的区签（`data-anchor="zone:0"` 的 aria-label 以「A区 · 」开头）、
  `__cwCafe.frames > 2`、画布不是一片纯色、点客人开卡片、卡片「打开对话」开抽屉、角色库、右侧面板 compact 带区卡片；A3 滚轮三条照旧。

## 踩过的坑

- **一个 NaN 的灯会让所有受光材质全黑**（地面也是受光的，看起来像整个画布黑了，只剩霓虹 / 屏幕这些 Basic 材质）：排灯强度用了
  `mats.dim`，而 `dims[i]` 还是 `undefined`。`dims` 每帧先写成数再比。
- three r18x 去掉了 `PCFSoftShadowMap` → 用 `PCFShadowMap` + `shadow.radius`。
- 设计令牌测试不许 CSS 用 `font-weight: 500`。
- 后台页 `.bg-body` 是 flex 列，外框要 `flex: none` + 固定高度。页面在后台时 rAF 不跑，截图前页面要可见。
- 坐着的客人背对镜头（屏幕要朝镜头才看得见），所以椅背做矮、显示器做高；网管朝 +z 站，镜头看得见脸。
- 在 bash 里写 heredoc 改文件会吃引号 / 反斜杠；改代码用 Edit，或者用 Write 写一个 .mjs 再 `node` 跑。

## 2026-10-24：滚轮只缩放，页面不跟着滚（stage A 的 A3）

- React 的 `onWheel` 是被动监听，`preventDefault()` 没用 → 画布上挂原生 `addEventListener('wheel', fn, { passive: false })`，用共用的
  `web/src/ui/wheel-zoom.ts` 的 `wheelZoom(scale, e, { min, max, step })`（返回 `null` = 交给页面：Shift、只有横向、到上下限还往那边滚）；范围 0.45–3.5、每格 1.2 倍。
- 验证：`wheel-zoom.test.ts`；ui-smoke `parity-a` 段（画布上滚四下页面不动、Shift 不拿、页面别处照滚）。
