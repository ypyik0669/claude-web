# 05 · 视觉语言调研：字体 / 颜色 / 形状 / 图标 / 动效

调研日期 2026-10-10。只读，没有改仓库。

**可信度标记**

- **VERIFIED（来源）**：我今天直接读到的一手材料——产品线上的 CSS、MDN browser-compat-data（main 分支）、npm registry、GitHub API、Fontsource / Iconify 的数据接口、官方文档。
- **INFERRED**：推断、行业共识或我凭记忆写的，没有在今天核对到一手来源。
- **未核实**：找过但没拿到可靠来源，用之前要再查。

**两个前提（都已核实）**

- 桌面端的渲染内核：Electron 44.7.0 = **Chromium 152**（VERIFIED：releases.electronjs.org）。下面凡是「Chrome ≥ 1xx 支持」的特性在桌面版都能直接用，手机上的 Safari 才需要回退。
- React：仓库用的是 `^19.2.8`；**React 19.3.0（2026-09-09 发布）才导出 `ViewTransition` 和 `addTransitionType`**，19.2.8 没有（VERIFIED：unpkg 上两个版本的 `cjs/react.production.js`）。

**一个局限**：按要求没有用浏览器工具，所以我没有看到应用的实际画面。「为什么显得方」的判断来自 `web/src/styles.css` 的统计（见第 3 节），不是看图得出的。

---

## 1. 字体

### 1.1 一线产品实际在用什么（读线上 CSS）

| 产品 | 界面无衬线 | 等宽 | 标题 / 正文的特别处理 | 中文怎么办 | 来源 |
| --- | --- | --- | --- | --- | --- |
| Claude（claude.ai） | `"Anthropic Sans", system-ui, "Segoe UI", Roboto, Helvetica, Arial` | `"Anthropic Mono", ui-monospace` | 回答正文用衬线：`--font-claude-response: var(--font-anthropic-serif)`；标题用 `"opsz" 20 / 28` | 衬线栈里直接接系统黑体：`… "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC" …, serif`（拉丁衬线 + 中文黑体） | VERIFIED：assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c6a992d55-CGuUmOei.css |
| ChatGPT | **默认是系统字体**：`ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica…`，Windows 上另有一条 `Segoe UI Variable Text` 打头的规则；`OpenAI Sans` 只用在 `.font-oai`（字标、营销位） | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas` | 每档字号带 `font-variation-settings: "opsz" <字号>`；`text-wrap: pretty / balance` | `:lang(zh)` 时 `.font-oai` 换成 `OpenAI Sans SC`；正文走系统 | VERIFIED：chatgpt.com/cdn/assets/root-mhtfjdn4.css |
| Kimi | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Noto Sans", …, "PingFang SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC"`，14px | `"Geist Mono", Menlo, Consolas` | 另外加载了 `MiSans VF`（整份 ttf 可变字体，只用在个别位置） | 系统中文 | VERIFIED：kimi.com 首页 + statics.moonshot.cn 的 36 个 CSS |
| Linear | `"Inter Variable", "SF Pro Display", -apple-system, "Segoe UI", …` | `"Berkeley Mono"`（商业字体） | `--font-settings: "cv01", "ss03"`；`--font-variations: "opsz" auto`；字重 **400 / 510 / 590 / 680**；营销标题 `"Tiempos Headline"` | 无 | VERIFIED：linear.app + static.linear.app 的 CSS |
| Vercel / v0 | `GeistSans` + 度量对齐的 `GeistSans Fallback` | `Geist Mono` | `font-synthesis-weight: none`、`"tnum"`、`interpolate-size: allow-keywords` | 无 | VERIFIED：vercel.com、v0.app |
| Cursor（官网） | 自有 `CursorGothic` | `berkeleyMono` / `cursorMono` | 衬线 `EB Garamond`；图标是自有字体 `CursorIcons16` | 无 | VERIFIED：cursor.com |
| Notion | `NotionInter`（改过的 Inter）+ 系统栈 | `iA Writer Mono` | 衬线 `Lyon Text`；`"lnum" 1, "locl" 0` | 系统 | VERIFIED：notion.com |
| Raycast（官网） | `Inter` | `JetBrains Mono`、`GeistMono` | 点缀 `Instrument Serif`；Inter 开 `"ss03"` 等 | 无 | VERIFIED：raycast.com |
| Dia / Arc | `ABC Oracle`（商业） | `ABC Favorit Mono` | 标题 `Exposure VAR`（带曝光轴的衬线） | 无 | VERIFIED：diabrowser.com |
| Manus | 系统 `ui-sans-serif, system-ui` | 系统 | 标题 `Libre Baskerville` + **自托管切片的 `Noto Serif SC / TC / JP`**（各 200 多个 `@font-face` 分片） | 标题用思源宋，正文系统 | VERIFIED：manus.im |
| 豆包 | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans"` | `ui-monospace…` | 无自有字体 | 系统 | VERIFIED：doubao.com/chat |
| 腾讯元宝 | `-apple-system, "Segoe UI", "PingFang SC", …, "Microsoft YaHei UI", "Microsoft YaHei", "Source Han Sans CN"` | — | Markdown 正文前面加一个自有拉丁字体 `"YB Serif UI"` | 系统 | VERIFIED：yuanbao.tencent.com |
| 飞书 / 语雀 | 系统栈，飞书官网拉丁用 `"Lark Circular"` | — | **栈的最前面放一个只管引号的别名字体**：飞书 `LarkChineseQuote`、语雀 `Chinese Quote` | 系统 | VERIFIED：feishu.cn、yuque.com |
| Perplexity | FK Grotesk / FK Grotesk Neue | Berkeley Mono | Comet 落地页用 Editorial New | — | 未核实一手（站点 403）；来源是 fontsinuse.com/uses/72596/comet |

**读出来的三条规律**

1. **做中文产品的没有一家给正文打包中文字体**：Kimi、豆包、元宝、通义、飞书、语雀全是「拉丁（系统或自有）在前 + 系统中文在后」。只有 Manus 为标题切片托管了思源宋。
2. **有品牌感的地方不在正文无衬线**，而在三处：等宽字体（Kimi 用 Geist Mono，Linear / Cursor 用 Berkeley Mono）、标题字体（Claude 的衬线、Dia 的 Exposure、Manus 的 Baskerville）、以及拉丁字体的 OpenType 特性（Linear 的 `cv01 ss03`）。
3. **ChatGPT 和 Claude 都按字号设置光学尺寸**（`opsz`），这是「同一个字体在 12px 和 28px 都好看」的原因。

### 1.2 可以合法打包的拉丁字体

全部 SIL OFL 1.1（VERIFIED：api.fontsource.org 的 `license` 字段；Inter / Geist / JetBrains Mono / Mona Sans / Monaspace / Maple / IBM Plex 另经 GitHub API 核对）。OFL 允许随软件再分发、允许子集化；MIT 应用里带上各字体的 `OFL.txt` 即可。体积是 Fontsource 的 **latin 子集可变字体 woff2**（VERIFIED：HEAD 请求的 content-length）。

| 字体 | latin VF 体积 | 字重范围 | 气质 | 评价 |
| --- | --- | --- | --- | --- |
| **Inter** | 47 KB（只有 wght）/ 73 KB（带 opsz）；rsms 官方完整版 352 KB（+ 斜体 388 KB） | 100–900 + opsz | 中性、为屏幕设计、x 高度大 | 和苹方 / 雅黑搭配最稳；有 `tnum`、`zero`、`cv05/cv08`（消歧 I l 1）、`cv11`（单层 a）、`ss03`（圆引号逗号）可以调出自己的味道。缺点是「到处都是」 |
| **Geist** | 29 KB（npm 完整版 70 KB） | 100–900 | 几何、略窄、更现代 | 个性比 Inter 强；和 Geist Mono 是一家 |
| Mona Sans / Hubot Sans | 39 / 47 KB | 200–900（原版还有宽度轴） | GitHub 味，稍宽 | 标题好看，小字号一般 |
| Figtree | 20 KB | 300–900 | 圆润友好 | 能明显减轻「方」的感觉，但偏消费级 |
| Onest | 33 KB | 100–900 | 圆润、几何 | 同上，西里尔字母好 |
| Manrope | 24 KB | 200–800 | 半圆角几何 | 数字漂亮；小字号偏松 |
| Plus Jakarta Sans | 27 KB | 200–800 | 圆、宽 | 营销页气质 |
| DM Sans | 36 KB | 100–900 + opsz | 几何低对比 | 可用，个性弱于 Geist |
| Instrument Sans | 29 KB | 400–700 | 精致、略紧 | 字重少 |
| Hanken Grotesk / Public Sans / Source Sans 3 | 34 / 26 / 28 KB | 全 | 朴素 | 稳但没有记忆点 |
| IBM Plex Sans | 45 KB | 100–700 | 工程感、方 | 会让界面更「方」，不建议 |
| Outfit / Schibsted Grotesk | 32 / 46 KB | — | 展示向 | 不适合 13–14px 密集界面 |
| Atkinson Hyperlegible Next | 33 KB | 200–800 | 为可读性设计 | 可以做成「高可读性」可选项（ChatGPT 提供的是 OpenDyslexic 和 Atkinson Hyperlegible Mono，VERIFIED） |

等宽：

| 字体 | 体积 | 许可 | 评价 |
| --- | --- | --- | --- |
| **JetBrains Mono** | 40 KB（VF） | OFL | 12–13px 最清楚，x 高度大；连字要关（`font-variant-ligatures: none`），否则 `!=` 会变形 |
| **Geist Mono** | 23 KB（VF；npm 完整版 71 KB） | OFL | 更轻更现代，Kimi 在用；小字号略细 |
| Commit Mono | 47 KB（静态 400） | 仓库 LICENSE 是 MIT（GitHub API），Fontsource 标 OFL——两处不一致，用前看原文 | 中性、无连字 |
| Monaspace（Neon 等） | 43 KB（静态 400） | OFL | 「纹理修复」需要开特性；五个子家族可以区分人 / AI 的代码，但是花活 |
| Cascadia Code | 48 KB（VF） | OFL（仓库 LICENSE 未被 GitHub 识别，以原文为准） | Windows 11 自带，现在的栈里它排第一，所以不同机器上代码字体不一样 |
| Maple Mono | 72 KB（静态 400） | OFL | 圆润手写感；有带中文的 CN 版（中英 2:1 对齐），但体积是十几 MB 级（体积为 INFERRED） |
| IBM Plex Mono | 14 KB（静态 400） | OFL | 打字机味 |
| Sarasa Gothic 更纱黑体 | 不在 Fontsource | OFL（INFERRED：社区清单；仓库 LICENSE 未被 GitHub 识别） | 中英严格 2:1 的等宽，但整套上百 MB，只适合让用户自己装后在栈里点名 |

标题衬线（可选）：Instrument Serif（21 KB，只有 400，有斜体 22 KB）、Newsreader（57 KB，带 opsz 是 132 KB）、Fraunces（36 KB）、Source Serif 4（50 KB）。**注意**：仓库的 CLAUDE.md 写着首页标题「不按时间问候、不用衬线」，这是已有的决定；而且「今天想做点什么？」是中文，拉丁衬线对它不起作用——要让中文也是宋体，只能像 Manus 那样带思源宋（见 1.3 的子集化）。

### 1.3 难点：中文

#### 许可——哪些真的能随 MIT 应用再分发

| 字体 | 许可 | 能随软件分发 | 能改 / 能子集化 | 结论 |
| --- | --- | --- | --- | --- |
| **思源黑体 / Noto Sans SC** | SIL OFL 1.1（VERIFIED：Fontsource） | 能 | 能 | **真开源，唯一推荐打包的黑体** |
| 思源宋体 / Noto Serif SC | SIL OFL 1.1（VERIFIED） | 能 | 能 | 真开源 |
| 霞鹜文楷 LXGW WenKai | SIL OFL 1.1（VERIFIED：GitHub API） | 能 | 能 | 真开源；楷体，适合阅读不适合界面 |
| 得意黑 Smiley Sans | SIL OFL 1.1（VERIFIED：GitHub API） | 能 | 能 | 真开源；斜体窄标题字，只能做点缀 |
| 霞鹜新晰黑 LXGW Neo XiHei | **IPA Font License 1.0**（VERIFIED：github.com/lxgw/LxgwNeoXiHei），不是 OFL | 能，但嵌入有附加要求 | 能，衍生名不能带 IPA | 可用但合规成本高 |
| 更纱黑体 Sarasa | OFL（INFERRED） | 能 | 能 | 体积太大 |
| HarmonyOS Sans | 华为自有协议：`royalty-free, revocable` | 只允许把**未修改**的副本随软件分发，软件里要有显著声明 | **不许修改**（子集化是否算修改没有说明） | 不是开源，**可撤销**；不建议打包（VERIFIED 于二手转录：blog.xinshijiededa.men/font-license） |
| MiSans | 小米《MiSans 字体知识产权许可协议》 | 可以，须「在软件中特别注明使用了 MiSans」 | 不许改编 / 二次开发，不许单独分发字体文件 | 同上，可撤销；Kimi 是直接挂了整份可变字体 ttf（VERIFIED：Kimi 的 CSS；协议要点来自 hyperos.mi.com 的 FAQ 与二手转录） |
| OPPO Sans 4.0 | OPPO 自有声明 | 「不得提供其它下载渠道」——把字体文件放进安装包算不算，没有官方说法 | 不许改编 / 二次开发 | 未核实一手；不建议 |
| 阿里巴巴普惠体 3.0 | 阿里自有法律声明 | 可免费商用 | 禁止对字库「仿制、转换、翻译、反编译、拆分」——**cn-font-split 式的切片正好踩在「转换 / 拆分」上** | 未核实一手（只有第三方转载）；不建议 |
| 微软雅黑 / 苹方 | 系统字体 | **不能分发** | — | 只能在栈里点名 |

npm 上的 `misans`（标 Apache-2.0）、`harmonyos-sans-sc-webfont-splitted`（标 Unlicense）这类包的许可标签和字体本身的协议不符（VERIFIED：npm registry 的标签；字体协议见上），**不要因为包的标签就认为可以用**。

#### 体积与可变字体

- Noto Sans SC 可变字体，按 Google Fonts 的 unicode-range 方案切成 101 片：`@fontsource-variable/noto-sans-sc` 整包解压 **4.7 MB**（112 个文件，VERIFIED：npm registry）。单个 400 字重整份简体子集是 1.14 MB（VERIFIED：HEAD）。
- 霞鹜文楷的切片 webfont 包：18.8–28.5 MB（VERIFIED：npm `lxgw-wenkai-screen-webfont` / `lxgw-wenkai-webfont`）。
- 相比之下 Inter + JetBrains Mono 两个拉丁可变字体合计不到 0.5 MB。

#### 雅黑在 Windows 13–15px 的问题，以及国内产品的做法

1. **只有三个字重**（Light / Regular / Bold）。按 CSS 的字重匹配规则，`font-weight: 500` 落到 Regular（看不出加粗），`600` 直接跳到 Bold（比 Inter 的 600 重得多）。苹方有六个字重，所以 Mac 上 500 / 600 是对的。（VERIFIED：MDN font-weight 的回退规则；现象见 blog.zengrong.net/post/font-weight-500。）仓库的 CSS 里 `font-weight: 500` 出现 32 次、`600` 出现 33 次——**在 Windows 上，那 32 处「中等」对中文完全无效**。
2. **微软给 Windows 推了 Noto CJK 可变字体，Chromium 的回退表把它排在雅黑前面，结果在 100% 缩放（96 DPI）下发虚**。微软自己的更新说明把它列为已知问题，影响 Edge、Chrome 和其它 Chromium 应用，临时建议是把缩放调到 125% / 150%（VERIFIED：KB5055523、KB5063060 的 known issue；Chromium issue 409486609、415261549）。原因是雅黑带针对 ClearType 的 hinting，Noto 可变字体没有。**对我们的含义**：必须在栈里明确写出 `"Microsoft YaHei UI"`，不能指望 `sans-serif` 回退；而把 Noto Sans SC 打包成 Windows 上的默认中文字体，会在最常见的 1080p / 100% 屏幕上招来同样的「发虚」投诉。
3. **`Microsoft YaHei UI` 和 `Microsoft YaHei` 字形相同、行高不同**（UI 版的上下留白更小，控件里更容易垂直居中）。（INFERRED；微信文档、元宝、Kimi 都把 UI 版排在前面，VERIFIED 于各自 CSS。）
4. **小数字号**：雅黑的 hinting 是按整数 ppem 调的，13.5px / 12.5px / 11.5px 这种尺寸在 100% 缩放下笔画粗细会不均。（INFERRED。）仓库里 `12.5px` 出现 58 次、`11.5px` 40 次、`13.5px` 19 次。
5. **中文小于 12px 基本不可读**。仓库里 `11px` 37 次、`11.5px` 40 次、`10.5px` 5 次，`--fs-micro` 是 10px。
6. **引号和破折号**：拉丁字体在前时，`“ ” ‘ ’ … —` 会用拉丁字形（半宽、省略号贴底），夹在中文里不协调。飞书和语雀的解法是在栈的最前面放一个只覆盖这几个码位、指向本地中文字体的别名 `@font-face`（VERIFIED：两家 CSS 里的 `LarkChineseQuote` / `Chinese Quote`）。
7. 国内产品的共同做法就是上面这些：拉丁在前、点名 `PingFang SC` 和 `Microsoft YaHei UI`、不打包中文、正文 14px 起、强调只用 400 和 Bold 两档。

#### 拉丁 webfont + 系统中文的写法（可直接粘贴）

```css
/* 1. 拉丁：Inter 可变字体。用 unicode-range 把中文里也要用的标点让给中文字体 */
@font-face {
  font-family: "Inter Variable";
  src: url("./fonts/InterVariable.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  /* 不含 U+00B7 · U+2014 — U+2018/2019 ‘ ’ U+201C/201D “ ” U+2026 …  */
  unicode-range: U+0000-00B6, U+00B8-024F, U+0259, U+02B0-036F, U+1E00-1EFF,
    U+2000-2013, U+2015-2017, U+201A-201B, U+201E-2025, U+2027-206F,
    U+2070-209F, U+20A0-20CF, U+2100-215F, U+2190-21FF, U+2200-22FF;
}
@font-face {
  font-family: "Inter Variable";
  src: url("./fonts/InterVariable-Italic.woff2") format("woff2");
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
  unicode-range: U+0000-00B6, U+00B8-024F, U+1E00-1EFF, U+2000-2013, U+2015-2017, U+2027-206F;
}

:root {
  --font-cjk: "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei",
    "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC";
  --font: "Inter Variable", -apple-system, "Segoe UI Variable Text", "Segoe UI",
    var(--font-cjk), system-ui, sans-serif;
  --mono: "JetBrains Mono Variable", "Cascadia Code", "SF Mono", Menlo, Consolas,
    var(--font-cjk), monospace;
}

html {
  font-family: var(--font);
  font-optical-sizing: auto;                 /* Inter 的 opsz 轴跟着字号走 */
  font-feature-settings: "cv11", "ss03", "calt";  /* 单层 a、圆引号逗号 */
  font-synthesis: none;                      /* 不要伪粗体、伪斜体（中文伪斜体很难看） */
  text-autospace: normal;                    /* 中英、中数之间自动加间距 */
  -webkit-font-smoothing: antialiased;       /* 只对 macOS 有效 */
  text-rendering: optimizeLegibility;
}
code, pre, kbd, .mono, textarea.code {
  font-family: var(--mono);
  font-variant-ligatures: none;
  font-feature-settings: "zero", "calt" 0;   /* 斜杠零 */
  text-autospace: no-autospace;
}
.num, .clock, .stat { font-variant-numeric: tabular-nums; }
.prose  { text-wrap: pretty; }
h1, h2, .title { text-wrap: balance; }
```

逐项的支持情况（VERIFIED：MDN browser-compat-data）：

| 特性 | Chrome | Safari | Firefox | 说明 |
| --- | --- | --- | --- | --- |
| `text-autospace: normal` | 140 | 18.4 | 145 | 桌面版（Chromium 152）直接可用。MDN 说初始值是 `normal`，但目前三家默认都还是不加间距，要显式写（后半句来自搜索到的二手说明，未核实一手）。Chrome 只认 `normal` / `no-autospace` |
| `text-spacing-trim` | 123 | 不支持 | 不支持 | Chrome 默认值 `normal` 已经会挤压相邻的全角标点，不用写 |
| `font-synthesis-weight` | 97 | 16.4 | 111 | |
| `@font-face size-adjust` | 92 | 17 | 92 | 调回退字体的视觉大小 |
| `@font-face ascent-override` | 87 | 仅预览版 | 89 | **Safari 不能用**，别依赖它对齐基线 |
| `font-size-adjust` | 127 | 16.4 | 3 | |
| `text-wrap: pretty` | 130（`text-wrap-style`） | 26 | 不支持 | 不支持时就是普通换行 |
| `text-box-trim` | 133 | 18.2 | 154 | 去掉文字上下的半行距，按钮里的文字能真正垂直居中 |
| `unicode-range` | 1 | 3.1 | 36 | |

补充说明：

- **`size-adjust` 在这里用不上**：它只对 `@font-face` 声明的字体生效，而中文是系统字体。Inter 和苹方 / 雅黑在 14px 下的视觉大小本来就接近，不需要调。（INFERRED。）
- **基线**：拉丁在前时行框由 Inter 的度量决定，中文字形略偏下是正常的；按钮里要严格居中就用 `text-box-trim: trim-both; text-box-edge: cap alphabetic`（桌面版可用）。
- **字重策略**（解决雅黑没有 500 / 600）：把「中等强调」从字重改成颜色或底色，字重只留两档有意义的——`400` 和 `600`。在 Windows 上 `600` 对中文是 Bold，所以 `600` 只给标题和真正要强调的地方；标签、选中的行、tab 用 `--ink-1` 对 `--ink-2` 的颜色差，不用 500。拉丁文字可以继续享受 500（`font-weight: 500` 对 Inter 有效、对雅黑无害）。
- **中文的强调（Markdown 的 `*斜体*`）**：`font-synthesis: none` 之后中文保持正体。建议 `.prose em { font-style: italic; font-weight: 600 }` 太重，折中是 `em:lang(zh)` 不变形、只换成 `--ink-1` 加下划点（`text-emphasis: dot` 是传统着重号，但界面里少见）。这一条是取舍，没有标准答案。（INFERRED。）
- `<html lang="zh-CN">` 已经有（VERIFIED：`web/index.html`），它决定汉字回退到简体字形而不是日文字形，别丢。

#### 如果以后要打包中文：子集化策略

1. **Google Fonts 式的 unicode-range 切片**：直接用 `@fontsource-variable/noto-sans-sc`（101 片、共 4.7 MB、带现成的 CSS）。离线可用，浏览器只加载页面上出现的字所在的片。安装包增加不到 5 MB。
2. **cn-font-split**（Apache-2.0，VERIFIED：GitHub API）：基于 HarfBuzz，Rust / WASM，自动识别可变字体字重，README 称「2 MB 字体只需要 50 ms」，有 `vite-plugin-font`。适合对任意 OFL 字体自己切（比如只切 GB2312 的 6763 字）。
3. **固定字符串子集**：如果只是首页标题要一个有性格的中文字体（思源宋、得意黑），用 `pyftsubset` / `fonttools` 只留那几句文案里的字，十几到几十 KB。OFL 字体若声明了保留字体名，子集要换个家族名（比如 `"CW Display"`）。
4. **按屏幕密度启用**（这是我给的方案，INFERRED）：发虚只在 96 DPI 出现，所以可以只在高分屏用打包的 Noto Sans SC，低分屏继续用带 hinting 的雅黑：

```css
@media (resolution >= 1.5dppx) {
  html.win { --font-cjk: "Noto Sans SC Variable", "Microsoft YaHei UI", "Microsoft YaHei"; }
}
```

这样高分屏的 Windows 用户能得到真正的 500 / 600 字重和更接近苹方的观感。代价是多 4.7 MB 和两种渲染要各验一遍。

### 1.4 字号表（中英混排）

参照物（VERIFIED）：ChatGPT 的文本档位是 12/18、14/20、16/24、18/29；Linear 是 11–12（micro）、12–13（mini）、13–14（small）、15–16（regular）、20 / 24 / 36（title）；Kimi 界面 14、Markdown 14–16。

**桌面（密集）**

| 令牌 | 字号 / 行高 | 字重 | 字距 | 用在哪 |
| --- | --- | --- | --- | --- |
| `--fs-display` | 28 / 36 | 600 | 拉丁 −0.02em；含中文时 0 | 首页「今天想做点什么？」 |
| `--fs-title` | 20 / 28 | 600 | −0.01em / 0 | 页面标题、对话框标题 |
| `--fs-heading` | 16 / 24 | 600 | 0 | 卡片标题、设置分节 |
| `--fs-prose` | 15 / 26（1.73） | 400 | 0 | 对话正文 |
| `--fs-base` | 14 / 20 | 400（强调用颜色） | 0 | 列表、控件、菜单 |
| `--fs-sm` | 13 / 18 | 400 | 0 | 次要信息、工具行、tab |
| `--fs-meta` | 12 / 16 | 400 | 0 | 时间、计数、分节小标题（**中文的下限**） |
| `--fs-micro` | 11 / 14 | 500 | +0.01em，`tabular-nums` | **只给拉丁和数字**：徽标里的数、键帽 |
| `--fs-code` | 13 / 20 | 400 | 0 | 代码块；行内代码用 `0.92em` |

**手机**

| 令牌 | 字号 / 行高 | 说明 |
| --- | --- | --- |
| display | 24 / 32 | |
| prose | 16 / 28 | |
| base | 16 / 22 | 输入框必须 ≥ 16px，否则 iOS Safari 聚焦时会放大页面（VERIFIED：vercel.com/design/guidelines） |
| sm | 14 / 20 | |
| meta | 12 / 16 | |
| 点击目标 | ≥ 44px | 同上来源 |

规则：全部用整数 px；中文不做负字距；`letter-spacing` 只在拉丁标题上收紧；行高中文正文 1.7–1.75、界面 1.4–1.5、标题 1.25–1.3。

### 建议

**推荐**：打包 **Inter Variable（rsms 完整版，带 opsz）+ JetBrains Mono Variable**，中文继续用系统字体，按上面的栈点名 `PingFang SC` / `Microsoft YaHei UI`。同时做五件事：开 `text-autospace: normal`；`font-synthesis: none`；把 500 字重的「中等强调」改成用颜色表达；字号全部改成整数并把中文下限提到 12px；首页标题用 Inter 的 opsz 大号 + 600，不用衬线（符合已有的决定）。这是改动最小、在 Windows 100% 缩放下最稳的方案，新增体积约 0.8 MB。

**备选**：想要更强的辨识度，把拉丁换成 **Geist + Geist Mono**（合计 140 KB，同一家族），并在高分屏的 Windows 上按 `@media (resolution >= 1.5dppx)` 启用打包的 **Noto Sans SC 可变字体切片**（+4.7 MB），换来真正的中文 500 / 600 字重。不要打包 MiSans / HarmonyOS Sans / OPPO Sans / 阿里普惠体。

---

## 2. 颜色

### 2.1 各家的中性色、层级和强调色（读线上 CSS）

| 产品 | 亮色 | 暗色 | 强调色怎么用 | 来源 |
| --- | --- | --- | --- | --- |
| Claude | **暖色中性**：`--bg-100: hsl(48 33.3% 97.1%)`（#faf9f5）、`--bg-200: hsl(53 28.6% 94.5%)`、`--bg-300: hsl(48 25% 92.2%)`；描边 `hsl(51 16.5% 84.5%)`；灰阶色相 40–60°、饱和度 2–14% | `--bg-000: hsl(60 2.1% 18.4%)`（#30302e，最亮的面）→ `--bg-100` #262624 → `--bg-200` #1f1e1d → `--bg-300` #141413 | 品牌色 clay `hsl(14.8 63.1% 59.6%)` = **#d97757，和本应用现在的 `--accent` 完全相同**；但交互强调（`--accent-000…`）是**蓝色** `hsl(210 70.9% 51.6%)`，Pro 用紫色 | VERIFIED：claude.ai CSS |
| ChatGPT | **纯中性**：主区 #fff，侧栏 #f9f9f9，三级 #f3f3f3；文字 #0d0d0d / #5d5d5d / #8f8f8f；描边全是透明度 `#0000000d / 1a / 26` | 主区 #212121，侧栏 #181818，浮层和输入框 #303030，三级 #414141；描边 `#ffffff0d / 1a / 26` | 主按钮是墨色（亮 #0d0d0d、暗 #fff）；链接蓝 #2964aa / #7ab7ff；没有品牌强调色 | VERIFIED：chatgpt.com CSS |
| Kimi | **暖底 + 白面板**：`--Bg-GroundPC: #fbfaf9`，`--Bg-Primary: #fff`，`--Bg-Secondary: #f5f5f5` | `--Bg-GroundPC: #181817`，`--Bg-Primary: #121212`，二三四级 #1f1f1f / #292929 / #4d4d4d；另有 70% / 90% 透明度的同色令牌配 `backdrop-filter: blur(15px / 30px)` | 蓝色 `--Colors-KMBlue` | VERIFIED：Kimi CSS |
| Linear | 层级 0–3：#fff / #f8f8f8 / #f4f4f4 / #f0f0f0；描边 #e9e8ea 或 `#0000000d` | **很深的冷色**：#08090a / #0f1011 / #141516 / #191a1b；描边 `#ffffff14 / 1f / 26` | 靛蓝 #5e6ad2 / #7170ff；主题由「底色、强调色、对比度」三个变量在 **LCH** 里生成 | VERIFIED：linear.app CSS；linear.app/now/how-we-redesigned-the-linear-ui |
| Vercel Geist | 背景 `hsl(0 0% 100%)` / `98%`；每个色阶 100–1000，同时给 hex、lab、**oklch** 三种写法 | 背景 `hsl(0 0% 4%)` / `0%` | 黑白为主；描边用阴影环 `0 0 0 1px #00000014`（暗 `#ffffff25`） | VERIFIED：vercel.com/geist/colors 的 CSS |
| Tailwind v4 | 全部 OKLCH。中性色现在有 **9 套**：slate、gray、zinc、neutral、stone，以及新增的 **mauve、olive、mist、taupe**。色度都很低：stone 0.001–0.013、taupe 0.002–0.021（色相 35–45，暖）、olive 0.003–0.031（色相 107，黄绿）、mist 0.002–0.021（色相 197–229，青）、mauve 0.003–0.034（色相 320–326，紫） | 同一条色阶的 800–950 | — | VERIFIED：tailwindlabs/tailwindcss 的 `packages/tailwindcss/theme.css` |
| Radix Colors | 12 级色阶，每级有固定用途：1–2 背景，3–5 组件底色（常态 / 悬停 / 选中），6–8 描边，9–10 实色，11–12 文字；中性色按强调色配对（橙 / 棕配 sand，绿配 olive / sage，蓝配 slate） | 同结构 | — | INFERRED（凭记忆，文档在 radix-ui.com/colors） |
| Material 3 | 表面是 5 级 surface container（lowest → highest），靠色调而不是阴影表达层级 | 暗色里层级越高越亮 | 一个主色派生整套 | INFERRED |
| Apple HIG | 系统背景三级 + 分组背景三级；标签四级用透明度 | 暗色有 base 和 elevated 两套，浮起来的面更亮 | 一个 tint 色 | INFERRED |

把几个关键面换算成 OKLCH 的明度（我自己算的）：

| | 主区 | 侧栏 / 底 | 浮层 |
| --- | --- | --- | --- |
| 本应用暗色（现在） | #1a1a19 → **21.7%** | #151514 → 19.5% | #252524 |
| ChatGPT 暗色 | #212121 → **24.8%** | #181818 → 20.9% | #303030 → 30.9% |
| Claude 暗色 | #262624 → **26.8%** | #1f1e1d → 23.6% | #30302e → 30.8% |
| Kimi 暗色 | #121212 | #181817 → 20.9% | #1f1f1f |
| Linear 暗色 | #08090a → **13.9%** | #0f1011 → 17.2% | #191a1b |

### 2.2 从中归纳的做法

1. **中性色带一点色相**：Claude 暖、Linear 冷、ChatGPT 纯灰。带色相的那两家更有辨识度；色度很低（OKLCH 的 C 在 0.002–0.012），肉眼看是「灰」，但和强调色放在一起不会脱节。Vercel 的规范里有一条：在非中性底上，描边、阴影、文字要往同一个色相偏（VERIFIED：vercel.com/design/guidelines）。
2. **用 OKLCH 定色阶**：同一个 L 看起来一样亮，所以「每级只改 L、色度和色相基本不动」就能得到均匀的台阶。Tailwind、Geist、Linear（LCH）都这么做。本应用已经用 `color-mix(in oklab, …)` 派生语义层，底层原色改成用 OKLCH 定义是顺的。
3. **暗色的层级靠「更亮」而不是阴影**：ChatGPT #181818 → #212121 → #303030，每级差 4–6% 明度；阴影在暗色里几乎看不见，换成 1px 的白色透明描边（`#ffffff14`）和内侧顶部高光。
4. **描边用透明度**：ChatGPT、Linear、Vercel 的描边全是 `rgba(0,0,0,.05–.15)` / `rgba(255,255,255,.05–.15)`，不是实色。透明描边压在任何底色上都协调。
5. **一个品牌色 + 墨色主按钮**：ChatGPT 和 Claude 的主按钮都是墨色，Claude 把品牌橙和交互蓝分开。本应用「橙色只给品牌、焦点环、选中指示；主按钮用墨色」和它们一致，不用改方向。
6. **语义色**：亮色里要在所有表面上 ≥ 4.5:1，L 要压到 50–53%；暗色里 L 在 74–84%。GitHub Primer 的做法见 2.4。
7. **对比度量法**：Vercel 建议用 APCA 而不是 WCAG 2（VERIFIED：同上）；仓库现有的测试是 WCAG 比值，下面的候选色都按现有测试的阈值验过。

### 2.3 三套候选（都以暖橙为品牌色）

三套都按仓库 `contrast.test.ts` 的口径自算过：正文在 `--bg / --bg-1 / --bg-2 / --bg-elev` 四种底上 ≥ 7:1，`--fg-1 / --fg-2` 和四个状态色 ≥ 4.5:1，`--fg-3` ≥ 3:1——**全部通过**（脚本在 scratchpad 的 `research-scripts/calc.cjs`）。hex 是从 OKLCH 换算的。

#### A · 暖纸（推荐）

色相 85（偏暖的石色），色度 0.002–0.008。主区几乎是白的，底（侧栏 / 外壳）带一点暖。和 Claude、Kimi 是同一个方向，但比 Claude 的米色淡得多，不会像现有的 `paper` 主题那样发黄。

| 令牌 | 亮色 hex | 亮色 oklch | 暗色 hex | 暗色 oklch |
| --- | --- | --- | --- | --- |
| `--bg`（主面板） | #fefdfc | 99.4% 0.002 85 | #1b1a18 | 21.8% 0.004 85 |
| `--bg-1`（外壳、侧栏） | #f7f6f2 | 97.2% 0.005 85 | #12110f | 17.8% 0.004 85 |
| `--bg-2` | #f0eeea | 95.0% 0.006 85 | #252321 | 25.8% 0.005 85 |
| `--bg-3` | #e6e4df | 91.8% 0.007 85 | #302f2c | 30.5% 0.006 85 |
| `--bg-elev`（菜单、输入框） | #ffffff | 100% 0 0 | #272623 | 26.8% 0.005 85 |
| `--fg` | #1c1917 | 21.5% 0.006 60 | #eeedea | 94.5% 0.004 85 |
| `--fg-1` | #47433f | 38.5% 0.008 60 | #c4c2be | 81.5% 0.006 85 |
| `--fg-2` | #67625f | 50.0% 0.008 60 | #a5a39e | 71.5% 0.007 85 |
| `--fg-3` | #7f7b77 | 58.5% 0.008 60 | #868480 | 61.5% 0.007 85 |
| `--accent` | #d97956 | 67.5% 0.13 40 | #e68964 | 72.0% 0.125 42 |
| 橙色文字（新增 `--accent-text`） | #aa4b27 | 53.0% 0.135 40 | #f39e77 | 77.5% 0.115 45 |
| `--green` | #12773d | 50.0% 0.125 152 | #69d98d | 80.0% 0.15 152 |
| `--red` | #be2a27 | 52.5% 0.185 27 | #ff8179 | 74.5% 0.155 25 |
| `--yellow` | #8a5d0b | 51.5% 0.105 75 | #f0c464 | 84.0% 0.125 85 |
| `--blue` | #1c63bf | 51.0% 0.16 257 | #80b6fb | 76.5% 0.115 255 |
| `--primary` / `--primary-fg` | #1c1917 / #fefdfc | | #eeedea / #1b1a18 | |

实测最低对比度：亮色 `--fg-3` 在 `--bg-2` 上 3.63、绿色在 `--bg-2` 上 4.89、橙色文字在 `--bg-2` 上 4.84；暗色 `--fg-3` 在 `--bg-elev` 上 4.08。白字压在 `--accent` 上只有 3.09（亮）/ 2.59（暗）——**橙色底上要用墨色字**（#1c1917 压在 #d97757 上是 5.60），或者继续不把橙色当按钮底色。

想让暗色更柔和（向 ChatGPT / Claude 靠），把暗色四个面的 L 各加 3%（主区到约 25%）；想要更沉稳就保持现在这组。

#### B · 石墨

几乎纯中性（色相 70、色度 0.002），主区纯白，暗色抬到 ChatGPT 的明度。是「现在的配色，校准一遍」。

| 令牌 | 亮色 | 暗色 |
| --- | --- | --- |
| `--bg` | #ffffff（100% 0 0） | #21201f（24.5% 0.002 70） |
| `--bg-1` | #f8f7f7（97.8% 0.0015 70） | #181716（20.5% 0.002 70） |
| `--bg-2` | #f1f0ef（95.5% 0.002 70） | #2b2a29（28.5% 0.002 70） |
| `--bg-3` | #e6e4e2（92.0% 0.003 70） | #363534（33.0% 0.003 70） |
| `--bg-elev` | #ffffff | #2e2e2d（30.0% 0.002 70） |
| `--fg` / `-1` / `-2` / `-3` | #171615 / #444240 / #656361 / #7d7b79 | #f1f0ef / #c8c7c5 / #aaa9a7 / #8d8c8a |
| `--accent` / 橙色文字 | #d97956 / #aa4b27 | #e68964 / #f6a47f |
| 绿 / 红 / 黄 / 蓝 | 同 A 亮色 | #6cdc90 / #ff8880 / #f3c767 / #87bafd |

#### C · 雾蓝

冷色中性（色相 255–260、色度 0.004–0.014），橙色和蓝灰是互补色，所以同样的橙在这套里最跳。气质接近 Linear，更「专业工具」。

| 令牌 | 亮色 | 暗色 |
| --- | --- | --- |
| `--bg` | #fdfdfe（99.5% 0.001 255） | #131519（19.5% 0.008 260） |
| `--bg-1` | #f4f6f8（97.2% 0.004 255） | #0b0d10（15.8% 0.008 260） |
| `--bg-2` | #ebeef2（94.8% 0.006 255） | #1c1e22（23.5% 0.009 260） |
| `--bg-3` | #dfe3e8（91.5% 0.008 255） | #272a2f（28.5% 0.010 260） |
| `--bg-elev` | #ffffff | #1f2126（24.8% 0.009 260） |
| `--fg` / `-1` / `-2` / `-3` | #15181e / #3f444b / #5f646b / #777c84 | #edeff1 / #babec4 / #9a9fa6 / #7c8188 |
| `--accent` / 橙色文字 | #dd764d / #ac4923 | #ee8c5e / #f69f72 |
| 绿 / 红 / 黄 / 蓝 | #007742 / #be292d / #8a5d0b / #2360c5 | #61da92 / #ff7d7c / #f0c464 / #7cb4fc |

**关于橙色本身**：现在的 #d97757 就是 Anthropic 的品牌色 clay（VERIFIED）。如果想要自己的识别度，把色相从 39 往 48–52 挪（更「橙」、少一点「陶土」）：亮色 #eb7f3b（70.5% 0.155 50），橙色文字 #b34e00（在 #fefdfc 上 5.18，在 #f0eeea 上 4.54），暗色 #f5914f。这是品牌决定，我只给数值。

### 2.4 diff 与语法高亮

GitHub Primer 的 diff 色（VERIFIED：unpkg.com/@primer/primitives 的 light.css / dark.css）：亮色新增行 #dafbe1、新增词 #aceebb，删除行 #ffebe9、删除词 #ffcecb；暗色用透明度——新增词 `#2ea04366`、行号 `#3fb9504d`，删除词 `#f8514966`、行号 `#f851494d`。

配合 A 套的版本（从状态色的色相派生，行底色很淡、词底色深一档）：

```css
:root {                                   /* 亮 */
  --diff-add-line: #dbf9e2;  /* oklch(95.5% 0.045 152) */
  --diff-add-word: #aeecbe;  /* oklch(89%   0.09  152) */
  --diff-del-line: #ffe9e6;  /* oklch(95.5% 0.03   25) */
  --diff-del-word: #ffc8c2;  /* oklch(88.5% 0.07   25) */
}
:root[data-theme="dark"] {
  --diff-add-line: #193521;  /* oklch(30% 0.05 152) */
  --diff-add-word: #17552e;  /* oklch(40% 0.09 152) */
  --diff-del-line: #41211e;  /* oklch(29% 0.05  25) */
  --diff-del-word: #742e2b;  /* oklch(40% 0.10  25) */
}
/* 更省事的写法：从状态色混出来，六个主题自动跟着走 */
.diff .add  { background: color-mix(in oklab, var(--green) 14%, var(--bg)); }
.diff .add mark { background: color-mix(in oklab, var(--green) 32%, var(--bg)); }
.diff .del  { background: color-mix(in oklab, var(--red) 12%, var(--bg)); }
.diff .del mark { background: color-mix(in oklab, var(--red) 30%, var(--bg)); }
```

语法高亮：现在亮 / 暗两套 `--hl-*` 是 GitHub 和 Material Palenight 的颜色拼的，和界面的中性色没有关系。建议六个色都放在同一个明度和色度上，只换色相，看起来才是「一套」：

| 角色 | 亮色（L≈48–55%，C≈0.10–0.15） | 暗色（L≈78–82%，C≈0.09–0.12） |
| --- | --- | --- |
| 关键字 `--hl-kw` | #724aab（色相 300） | #c3a5f9 |
| 字符串 `--hl-str` | #206b38（150） | #89da9b |
| 数字 `--hl-num` | #b0540e（50，呼应品牌橙） | #f6ab6b |
| 函数 `--hl-fn` | #0e5caf（255） | #80bdfb |
| 类型 `--hl-type` | #00747a（200） | #78d7d6 |
| 注释 `--hl-cmt` | #7d7a74（中性，跟着 `--fg-3`） | #83807a |

### 2.5 渐变、噪点、玻璃：现在什么显得高级，什么显得过时

- **显得过时**：大面积的蓝紫「AI 渐变」、发光描边、整页的毛玻璃、彩虹色的思考动画。
- **显得高级**（INFERRED，除标注外）：
  - 只在**浮起来的东西**上用半透明 + 模糊：菜单、粘在顶部的会话头、toast。Kimi 的做法是底色 70–90% 不透明度 + `backdrop-filter: blur(15px)`（VERIFIED）。配方：`background: color-mix(in oklab, var(--bg-elev) 82%, transparent); backdrop-filter: blur(16px) saturate(1.5);`
  - 渐变只当**遮罩**用：滚动区域上下边缘的渐隐、输入框上方内容淡出。
  - 品牌渐变只出现在一两个「时刻」：首页标题背后一团很淡（≤ 8% 不透明度）的暖色光晕，或者思考中的文字扫光。
  - 噪点：大面积纯色渐变上叠 2–3% 的颗粒可以消除色带，但会让上面的文字变糊，这个应用不需要。
- 性能：`backdrop-filter` 在长列表里每个元素都用会掉帧，只给固定位置的少数几个元素。

### 建议

**推荐**：采用 **A · 暖纸**，并配合「外壳带色、主面板近白」的内嵌布局（第 3 节）。原色改用 OKLCH 书写，语义层继续由 `color-mix(in oklab)` 派生；描边一律用透明度；暗色的层级用明度台阶 + 白色透明描边表达；新增 `--accent-text`（橙色文字专用，保证 4.5:1）和 `--diff-*`；语法高亮换成同明度的六色。其余四个主题（paper / dracula / nord / tokyo-night）只需照同样的结构补 `--accent-text`。

**备选**：**C · 雾蓝**——如果希望和 Claude 自己的界面拉开距离、要更冷静的「专业工具」气质。橙色在这套里最醒目。B 只在「不想让用户感觉到变化」时选。

---

## 3. 形状

### 3.1 为什么显得「方」

从 `web/src/styles.css` 统计到的（VERIFIED：本地 grep）：

- **实线描边 177 处**（`border: 1px solid …` 及四个方向的变体）。区域之间主要靠线分开，线多了每个区域都是一个框。
- 圆角用得最多的是 `--r-md`（8px，70 处）和 `--r-lg`（10px，44 处），`--r-xl`（14px）27 处，`--r-2xl`（22px）只有 5 处。也就是说**绝大多数元素的圆角在 8–10px**，大的面（卡片、面板）和小的控件用的是差不多的圆角，没有层次。
- 主区是纯白整块铺满，侧栏、主区、右侧面板之间是直线相接。
- 整个文件只有 39 处 `transition`（见第 5 节），状态变化是「跳」的，这也会加重生硬的感觉。

对照组（VERIFIED）：

| | 控件 | 行 / 菜单项 | 卡片 / 浮层 | 对话框 | 输入框 | 其它 |
| --- | --- | --- | --- | --- | --- | --- |
| ChatGPT | 令牌 4 / 6 / 8 / 10 / 12 / 16 / 20–24 / 32 / full | 侧栏按钮 8 | 16–24 | 24–32 | **24–28**（`--composer-border-radius` 缺省 24；内部附件圆角 = 外圆角 − 2×间距 − 1px） | 输入框里的按钮 36px、**全圆**；建议词是胶囊 |
| Kimi | 用得最多的是 8（108 处）、12（105 处）、10（82 处） | 8 | 12–16（47 处 16） | `--km-modal-radius: 20px` | `--chat-input-radius: 24px` | 图标按钮 20（全圆）、圆形 59 处 |
| Linear | 令牌 4 / 6 / 8 / 12 / 16 / 24 / 32 / 圆 | 6–8 | 12–16 | 16–24 | — | |
| Claude | Tailwind 标准档：6 / 8 / 10 / 12 / 16 / 全圆 | 8 | 12–16 | 16 | 输入框阴影是 `0 .25rem 1.25rem` 黑 7.5% + 0.5px 描边环 | |
| Vercel | `--geist-radius: 6px`、营销 8px | | | | | 偏硬朗，是有意的 |

### 3.2 怎么改

**(1) 拉开圆角的层次。** 小的东西小圆角，大的东西大圆角，输入框和气泡最圆。

| 令牌 | 现在 | 建议 | 用在哪 |
| --- | --- | --- | --- |
| `--r-xs`（新增） | — | 4 | 行内标记、键帽 |
| `--r-sm` | 4 | 6 | 小徽标、复选框、tab 里的关闭钮 |
| `--r-md` | 8 | 10 | 按钮（32 高）、输入框、图标按钮 |
| `--r-lg` | 10 | 12 | 菜单、浮层、代码块、工具卡、tooltip |
| `--r-xl` | 14 | 16 | 卡片、主面板、右侧面板 |
| `--r-2xl` | 22 | 24 | 输入框、底部抽屉的上边、对话框（20–24） |
| `--r-pill` | 999 | 999 | 芯片、分段控件、输入框里的圆按钮 |
| 行（新增 `--r-row`） | 用的是 `--r-lg` 10 | 8 | 侧栏行、菜单项、列表行 |

只改这几个变量的值，70 + 44 + 27 处用法自动生效，是性价比最高的一步。

**(2) 嵌套规则：内圆角 = 外圆角 − 内边距。** 菜单外圆角 12、内边距 4 → 菜单项 8；对话框 20、内边距 8 → 里面的卡片 12；输入框 24、内边距 8 → 里面的附件缩略图 16、按钮全圆。ChatGPT 的输入框就是这么算的（VERIFIED：`calc(var(--composer-border-radius) - var(--spacing)*2 - 1px)`）；Vercel 规范写的是「子圆角 ≤ 父圆角，并且同心」（VERIFIED）。内边距大于外圆角时，里面用最小档（4–6）即可。

**(3) 胶囊还是圆角矩形。** 胶囊给「可以随手点掉 / 切换的小东西」：芯片、筛选、分段控件、建议词、输入框里的发送 / 停止。圆角矩形给「表单里的按钮、输入框、菜单项」。经验值：圆角 ≈ 高度 × 0.3（28 高 → 8，32 高 → 10，36 高 → 10–12，40 高 → 12）。

**(4) 用三种办法代替实线描边。**

- **底色差**：选中行、悬停、卡片用 `--layer-*`（墨色 4% / 7% / 10%）而不是描边。
- **透明细线**：必须有线的地方用 `color-mix(in oklab, var(--fg) 8%, transparent)`，不要实色。
- **阴影环**：浮起来的元素不写 `border`，把 1px 的环写进 `box-shadow` 的第一层（Vercel 的 `--ds-shadow-border-base: 0 0 0 1px #00000014`，VERIFIED）。好处是不占盒子尺寸，圆角处也不会出现描边和背景之间的缝。

目标：把 177 处实线砍到 60 处以内——面板之间靠底色差和间距，列表行之间不画线，卡片用阴影环。

**(5) 多层柔和阴影。** 至少两层：一层近而实（接触阴影），一层远而虚（环境光）。阴影颜色往中性色的色相偏，不用纯黑。（原则 VERIFIED：joshwcomeau.com/css/designing-shadows、vercel.com/design/guidelines。）几个线上的实物：

- ChatGPT 输入框：`0 0 0 1px #0000000a, 0 2px 8px 0 #0000000a, 0 4px 80px 8px #00000006`；暗色只有 `inset 0 0 1px 0 #fff3`（VERIFIED）。
- Linear 的低层堆叠：`0 8px 2px 0 #0000, 0 5px 2px 0 #00000003, 0 3px 2px 0 #0000000a, 0 1px 1px 0 #00000012, 0 0 1px 0 #00000014`，按钮上再加一层 `0 -1px 1px 0 #0000001c inset`（VERIFIED）。
- Vercel 的大阴影：`0 2px 2px #0000000a, 0 8px 16px -4px #0000000a`，全屏层 `0 1px 1px #00000005, 0 8px 16px -4px #0000000a, 0 24px 32px -8px #0000000f`（VERIFIED）。
- Kimi 的浮层：`0 4px 16px #0000001a`，或者 `inset 0 0 0 .5px 分隔线色, 0 4px 16px 0 #0000001a`（VERIFIED）。

给本应用的配方（A 套；`--shade` 是 R G B 三个数）：

```css
:root {                         /* 亮色：阴影带一点暖 */
  --shade: 40 30 20;
  --ring: 0 0 0 1px rgb(var(--shade) / 0.07);
  --elev-1: var(--ring), 0 1px 2px -1px rgb(var(--shade) / 0.08), 0 2px 6px rgb(var(--shade) / 0.04);
  --elev-2: var(--ring), 0 4px 8px -2px rgb(var(--shade) / 0.08), 0 12px 24px -6px rgb(var(--shade) / 0.10);
  --elev-3: var(--ring), 0 8px 16px -4px rgb(var(--shade) / 0.08), 0 24px 56px -12px rgb(var(--shade) / 0.18);
  --elev-composer: 0 0 0 1px rgb(var(--shade) / 0.06), 0 2px 8px rgb(var(--shade) / 0.04), 0 12px 40px rgb(var(--shade) / 0.05);
  --inner-hi: inset 0 1px 0 rgb(255 255 255 / 0.6);      /* 实色按钮顶部的高光 */
}
:root[data-theme="dark"] {      /* 暗色：环和内高光是主角，阴影只是垫底 */
  --shade: 0 0 0;
  --ring: 0 0 0 1px rgb(255 255 255 / 0.08);
  --inner-hi: inset 0 1px 0 rgb(255 255 255 / 0.06);
  --elev-1: var(--ring), var(--inner-hi), 0 1px 2px rgb(0 0 0 / 0.4);
  --elev-2: var(--ring), var(--inner-hi), 0 8px 24px -4px rgb(0 0 0 / 0.5);
  --elev-3: var(--ring), var(--inner-hi), 0 24px 64px -12px rgb(0 0 0 / 0.65);
  --elev-composer: var(--ring), var(--inner-hi), 0 8px 32px rgb(0 0 0 / 0.35);
}
```

**(6) 内嵌外壳。** 窗口底色用 `--bg-1`（带色），侧栏直接画在底上、没有自己的框；主区是一张圆角 16 的面板（`--bg`），四周留 8px；右侧面板是另一张面板，和主面板之间隔 8px 而不是一条线。Kimi 的令牌结构正是「`Bg-GroundPC` #fbfaf9 + `Bg-Primary` #fff」（VERIFIED；它在布局上是不是内嵌面板是 INFERRED）。ChatGPT 是平铺（侧栏 #f9f9f9 贴着主区 #fff）。

```css
.app { background: var(--bg-1); padding: 8px 8px 8px 0; gap: 8px; }      /* 侧栏那一侧不留边 */
.sidebar { background: transparent; }
.center, .rpanel {
  background: var(--bg);
  border-radius: var(--r-xl);
  box-shadow: var(--elev-1);
  overflow: clip;
}
.app.mobile { padding: 0; }                    /* 手机上铺满 */
.app.mobile .center { border-radius: 0; box-shadow: none; }
```

要注意的地方：桌面版顶部的拖动区和系统窗口按钮（Windows 右上 150px）现在画在各栏的第一行里，内嵌后面板的上边距要和它们对齐；分屏时每个窗格是一张小面板还是共用一张，要在原型里定。这一步改动面最大，值得先做一个原型看。

**(7) 超椭圆圆角（squircle）。** `corner-shape` 只有 Chromium 支持：Chrome 139+；Safari 和 Firefox 只在预览版（VERIFIED：MDN browser-compat-data；Smashing 2026-03 的文章说法一致）。桌面版是 Chromium 152，可以直接用；手机 Safari 会忽略它，回到普通圆角，所以是无风险的渐进增强。`superellipse(1)` 是普通圆角，`2` 是标准 squircle。**ChatGPT 线上就在用，取值很克制：`superellipse(0.98)`、`1.1`、`1.25`**（VERIFIED：它的 CSS 里有这三个工具类）。它会作用在背景、描边、outline 和阴影上（VERIFIED：Smashing）；`overflow` 裁剪是否跟随，未核实。同样的 `border-radius` 下超椭圆看起来更小，要把半径放大一些（Smashing 的例子从 16 → 20、12 → 40 不等，没有固定倍数）。

```css
@supports (corner-shape: squircle) {
  .center, .rpanel, .card, .composer, .modal, .menu, .msg.user .bubble {
    corner-shape: superellipse(1.3);
  }
  .center, .rpanel, .card { border-radius: calc(var(--r-xl) * 1.2); }
  .composer, .modal       { border-radius: calc(var(--r-2xl) * 1.15); }
  /* 10px 以下的小圆角看不出差别，不用加 */
}
```

**(8) 其它具体数值。**

- **侧栏行**：高 32（手机 40），左右内缩 8，圆角 8；悬停墨色 5%，选中墨色 8% 且文字 `--ink-1`，不加描边、不加左侧色条。
- **输入框**：圆角 24；内边距上 12、左右 14、下 10；最小高度约 100；按钮行高 36；发送是 32–36 的圆（ChatGPT 是 36，VERIFIED）；阴影用 `--elev-composer`，聚焦时把环加深到墨色 14%，不要换成橙色粗框。
- **按钮**：默认高 32、左右内边距 12、圆角 10；小号 28 / 8；大号 36 / 12。图标按钮正方形，悬停底色的圆角和按钮一致或全圆。
- **卡片**：圆角 16、内边距 14–16、卡片之间 12；工具卡和代码块 12。
- **用户气泡**：圆角 20，左右内边距 14–16，最大宽度 75–80%。
- **头像和 Agent 标志**：人是圆；Agent / 供应商标志用圆角方（squircle，圆角 = 边长 × 0.28）。
- **间距**：4 的倍数。控件内 8 / 12，组内 12 / 16，分节 24 / 32。同一层级的间距只用一个值。

### 建议

**推荐**：分两步。第一步只改令牌和描边——圆角 6 / 10 / 12 / 16 / 24、行 8，按嵌套规则核对菜单、对话框、输入框；把实线描边换成底色差、透明细线和阴影环；换上多层阴影；桌面版加 `corner-shape: superellipse(1.3)` 渐进增强。第二步做**内嵌外壳**（带色的底 + 圆角主面板 + 独立的右侧面板）。

**备选**：不做内嵌外壳，保持平铺（ChatGPT 式），只做第一步，并把面板之间的分隔线换成底色差（侧栏 `--bg-1`、主区 `--bg`、右侧面板 `--bg`，中间一条 8% 透明度的线）。改动小、风险低，但「方」的感觉只能去掉六七成。

---

## 4. 图标

### 4.1 各套对比

数量是 Iconify 数据包里的条目数（含各字重 / 风格），「概念数」是去掉后缀后的近似值；覆盖情况是我用正则在各套的名字表里查的（VERIFIED：cdn.jsdelivr.net/npm/@iconify-json/<集合>/icons.json）。许可和包体积来自 npm registry / GitHub API（VERIFIED）。查的概念：terminal、git branch / commit / PR / merge、diff、fork / 树、robot、sparkles、brain、plug、shield、workflow、分栏、侧栏。

| 图标集 | 许可 | 条目（≈概念） | 网格 / 线宽 | 气质 | 填充 / 双色 | 开发概念缺什么 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Lucide** | ISC | 1 941（≈1 934） | 24，线宽 2（可调），圆头圆角 | 中性、干净 | 没有填充版 | **不缺** | shadcn 的默认；`lucide-react` 1.54，可摇树；仓库 2026-10-09 还在更新 |
| **Phosphor** | MIT | 9 161（≈1 531 × 6） | 256 网格，6 档：thin / light / regular / bold / fill / duotone | 圆润、友好 | **有 fill 和 duotone** | 只缺 workflow（有 flow-arrow、tree-structure 可代替） | 路径是轮廓不是描边，线宽只能在 6 档里选；React 包里每个图标带全部 6 档 |
| **Tabler** | MIT | 6 286（≈5 210） | 24，线宽 2（可调） | 中性偏工程 | 约一千个有 filled 版 | **不缺** | 数量最多的描边集 |
| **Hugeicons（免费）** | MIT | 6 091 | 24，线宽 1.5，圆角 | 现代、细 | 免费只有 Stroke Rounded；其它 8 种风格收费 | **不缺** | `@hugeicons/react` + `@hugeicons/core-free-icons`；`@hugeicons/static` 的条款据说更严（未核实） |
| Remix Icon | **Remix Icon License 1.0**（2026-01 起，4.9.0+；之前是 Apache-2.0） | 3 229（≈1 689） | 24，line / fill 成对 | 中性 | 每个都有 fill | 缺 diff | 新许可禁止转售、禁止做竞品图标库；Debian 已经移除，Red Hat 的项目把版本锁在 4.9 以下（VERIFIED：Remix-Design/RemixIcon#1069 等）。**避开，或锁 4.8** |
| Iconoir | MIT | 1 682 | 24，线宽 1.5 | 细、优雅 | 少量 solid | 缺 robot、workflow | |
| Solar | **CC BY 4.0**（要署名）；npm 的 `solar-icon-set` 标 GPL-3.0 | 8 859（≈1 520 × 6） | 24，6 种风格含 duotone | 圆润、有装饰感 | 有 | 缺 workflow | 许可麻烦，仓库 2025-06 后没更新 |
| Heroicons | MIT | 1 288（≈326） | 24 outline（1.5）、24 solid、20 mini、16 micro | 中性 | 有 solid | **缺全部 git 概念、diff、robot、brain、workflow、sidebar** | 太少 |
| Radix Icons | MIT | 342 | **15×15** | 细、锐 | 无 | 缺 terminal、git、diff、robot、brain、plug、shield、workflow | 太少 |
| Fluent System Icons | MIT | 20 265（≈3 531） | 16 / 20 / 24 / 28 / 32 / 48 各自绘制，regular / filled | Windows 味 | **每个都有 filled，每个尺寸单独画** | 缺 git-commit | 光学尺寸做得最好；npm 包 166 MB；在 Mac 上有点「Windows」 |
| Material Symbols | Apache-2.0 | 16 442（≈4 164） | 可变字体：FILL 0–1、wght 100–700、GRAD、opsz 20–48 | Google 味 | FILL 轴可以做填充过渡动画 | 缺 git-branch、PR | 用字体才有四个轴；气质和本应用不搭 |
| MingCute | Apache-2.0 | 3 336（≈1 668） | 24，线宽 2，line / fill 成对 | 圆润 | 每个都有 fill | **不缺** | 国内团队做的，圆润风格里最全的免费选择 |
| IconPark | Apache-2.0 | 2 658 | 48，4 种主题 | 偏装饰 | 有 | 缺 git-commit、workflow、sidebar | 仓库 2023-02 后没动 |
| Carbon | Apache-2.0 | 2 776 | 32（另有 16 / 20 / 24） | IBM，方、硬 | 部分 | **不缺** | 会让界面更「方」 |
| Octicons / Codicons | MIT / CC-BY-4.0 | 953 / 659 | 16、24 / 16 | GitHub / VS Code | 部分 | Octicons 缺 robot、brain；Codicons 缺 brain | git 概念最地道，可以借形 |
| Untitled UI Icons | npm 包 `@untitledui/icons` 标 MIT | 约 1 100（INFERRED） | 24，线宽 2 | 中性圆润 | 免费版只有线性 | 未核实 | |
| Central Icons | 商业（npm 标「SEE LICENSE」） | — | 可配圆角 / 线宽 / 填充 | 很精致 | 有 | — | 付费 |
| Nucleo | 商业 | — | — | — | — | — | 付费，npm 上没有同名公开包 |
| SF Symbols | Apple 协议，只能用于 Apple 平台上的应用界面（INFERRED） | — | — | — | — | — | **不能用在 Windows / 网页** |

**一线产品用什么**：

- Vercel 用自己的 Geist Icons，官方回复说不开放给外部（VERIFIED 于二手：community.vercel.com 的回帖）。
- Cursor 最早用 VS Code 的 Codicons 加零散的自绘，后来花一年重做了一套自己的，理由是现成图标库没有「agent、并行执行」这类概念（VERIFIED 于二手：minoradventures.co/blog/the-making-of-cursors-icons）；官网 CSS 里有图标字体 `CursorIcons16`（VERIFIED）。
- ChatGPT：自有图标，OpenAI 的 Apps SDK UI 里带了一套 React 包装的 SVG（INFERRED）。
- Linear：自有（设计系统 Orbiter 不对外，INFERRED）。Kimi：自有（INFERRED）。
- Claude：搜索没有找到可靠来源；我记得它早期用 Phosphor，**未核实**。

结论：头部产品几乎都是自绘，开源集里它们的衍生生态（shadcn、v0）默认是 Lucide。

### 4.2 光学尺寸和线宽

- 描边图标缩小时线宽也跟着缩：24 网格、线宽 2 的图标画在 16px 上是 1.33px，画在 20px 上是 1.67px。要让各尺寸看起来一样粗，按尺寸给不同的线宽（Lucide 的 `absoluteStrokeWidth` 就是干这个的）。
- 现在自绘的 175 个图标是 24 网格、线宽 1.75、`currentColor`——和 Lucide 的结构完全一样，只是线宽不同。
- 建议的线宽：**16px → 1.5 绝对像素**（即 24 网格下 2.25）、**18–20px → 1.5–1.6**、**24px → 1.75**。一个规则概括：屏幕上的线宽恒定在 1.5px 左右，大图标略粗。
- 对齐：图标和文字放在一行时，图标的盒子用 `1em × 1em` 的 1.15–1.25 倍，`vertical-align: -0.125em`；16px 图标配 13–14px 文字，20px 图标配 15–16px 文字。

### 4.3 选中 / 填充状态

Lucide 没有填充版。三个办法，按代价从低到高：

1. **柔填充**（推荐）：选中时给闭合路径加一层很淡的同色填充，描边不变。

```css
.icon { fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
[aria-selected="true"] > .icon, .icon-btn.active > .icon {
  fill: color-mix(in oklab, currentColor 16%, transparent);
}
```

2. 少数几个确实需要实心的（发送箭头、停止方块、播放、置顶、收藏、好评 / 差评的已选态）手绘实心版，放进现有的 `PATHS` 表，命名 `xxx-fill`。
3. 整套换成自带 fill / duotone 的集（Phosphor 或 MingCute）。

状态规则：默认 `--ink-3`，悬停 `--ink-1`，选中 `--ink-1` + 柔填充；不要用橙色表示选中（橙色留给品牌和焦点）。

### 4.4 动画图标值不值

- **lucide-animated（pqoqubbw/icons）**：MIT，8 千多星，仍在更新；每个图标是一个依赖 Motion 的 React 组件，shadcn 式复制粘贴（VERIFIED：GitHub API、npm）。引入它等于引入 Motion。
- **Lottie**：`lottie-web` 解压 24 MB，运行时也重；dotLottie 用 WASM。为图标引入不值得。
- **react-useanimations**：基于 Lottie，同上。
- 结论：**整套做成动画是噱头**，但在 6–8 个关键时刻有价值，而且纯 CSS 就能做：复制 → 对勾（描边绘制）、发送 ⇄ 停止、侧栏开合、箭头旋转、加载圈 → 对勾、好评弹一下、置顶、下载完成。写法见第 5 节。

### 建议

**推荐**：以 **Lucide 的几何**为主（ISC，允许复制），但**不加运行时依赖**——写一个生成脚本从 `lucide-static` 的 SVG 抽出路径，填进现有的 `web/src/ui/icons.tsx` 的 `PATHS` 表，替换掉自绘的通用图标；附上 Lucide 的许可声明。线宽按尺寸给（16px 用 1.5 绝对像素，24px 用 1.75）。选中态用「柔填充」，再手绘 8–10 个实心图标。**保留手绘的**：品牌标志、各 Agent / 供应商的标志（可以参考 MIT 的 `@lobehub/icons-static-svg`，注意那些是别人的商标）、以及 Lucide 没有的本应用专属概念（独立副本、深度编排、交接）。动画只做 6–8 个，用 CSS。

**备选**：整套换成 **Phosphor**（regular 为主，选中用 fill，空状态插图用 duotone）。它更圆润，能直接减轻「方」的感觉，而且选中态是真正的实心版。代价是线宽只有固定几档（16px 下 regular 偏细，要用 bold）、每个图标带 6 档路径体积更大、和现有图标的结构不一样需要整体替换。

---

## 5. 动效与微交互

### 5.1 现状和能用的平台能力

现状：20 万字符的样式表里只有 39 处 `transition`；时长令牌 0.1 / 0.16 / 0.24 / 0.32 s；一条缓出曲线 `cubic-bezier(0.21, 0.47, 0.32, 0.98)`；`data-reduce-motion` 时把所有动画和过渡关掉（VERIFIED：本地 grep）。

各特性的支持情况（VERIFIED：MDN browser-compat-data，2026-10-10）：

| 特性 | Chrome | Safari | Firefox | 桌面版（Chromium 152） | 手机 Safari 的回退 |
| --- | --- | --- | --- | --- | --- |
| `linear()` 缓动 | 113 | 17.2 | 112 | 可用 | 17.2 以下退回 `cubic-bezier` |
| `@starting-style` | 117 | 17.5 | 129 | 可用 | 没有入场动画，直接出现 |
| `transition-behavior: allow-discrete` | 117 | 17.4 | 129 | 可用 | 同上 |
| `overlay` 属性（顶层元素的退场） | 117 | 不支持 | 不支持 | 可用 | popover 退场是瞬间的 |
| `interpolate-size: allow-keywords` | 129 | **不支持** | 不支持 | 可用 | 用 `grid-template-rows: 0fr ⇄ 1fr` |
| `calc-size()` | 129 | 不支持 | 不支持 | 可用 | — |
| `document.startViewTransition`（同文档） | 111 | 18 | 144 | 可用 | 18 以下直接切换 |
| `view-transition-class` | 125 | 18.2 | 144 | 可用 | |
| 嵌套的 `view-transition-group` | 140 | 不支持 | 不支持 | 可用 | |
| 滚动驱动动画 `animation-timeline` | 115 | 26 | 仅预览 | 可用 | 26 以下没有效果 |
| `scroll-state()` 容器查询（吸顶、可滚动状态） | 133 | 不支持 | 不支持 | 可用 | |
| 锚点定位 `anchor-name` / `position-area` | 125 / 129 | 26 | 147 | 可用 | 现有的 JS 定位 |
| `popover` 属性 | 114 | 17 | 125 | 可用 | |
| `field-sizing: content`（输入框随内容长高） | 123 | 26.2 | 152 | 可用 | 现有的 JS 自适应高度 |
| `corner-shape` | 139 | 仅预览 | 仅预览 | 可用 | 普通圆角 |
| `sibling-index()`（列表错开延迟） | 138 | 26.2 | 154 | 可用 | 用内联 `--i` |
| `Element.moveBefore()`（移动节点不丢状态和动画） | 133 | 不支持 | 144 | 可用 | |
| `navigator.vibrate` | 32 | **不支持** | 16 | — | iOS 上没有震动 |
| `backdrop-filter`（无前缀） | 76 | 18 | 103 | 可用 | 更早的 Safari 要 `-webkit-` |

React：`<ViewTransition>` 在 **19.3.0** 才是稳定导出（VERIFIED）；仓库是 19.2.8，要么升级，要么手写 `document.startViewTransition(() => flushSync(…))`。两种写法不要混用（混用会丢动画，来源是二手文章，未核实一手）。

### 5.2 令牌

时长（参照：Linear 0.1 / 0.18 / 0.25 s，并且**高亮淡入 0 s、淡出 0.15 s**；Vercel 浮层 0.2 s、遮罩层 0.3 s 且从 0.96 放大；M3 短 50–200、中 250–400、长 450–600 ms——都 VERIFIED）：

```css
:root {
  --dur-instant: 80ms;    /* 按下反馈 */
  --dur-fast:    120ms;   /* 悬停淡出、tooltip、颜色变化 */
  --dur-base:    180ms;   /* 菜单、浮层、芯片 */
  --dur-slow:    240ms;   /* 折叠、面板、列表移动 */
  --dur-slower:  320ms;   /* 对话框、抽屉 */
  --dur-page:    480ms;   /* 首页入场、共享元素 */

  --ease-out:    cubic-bezier(0.23, 1, 0.32, 1);     /* 进场、退场：起步快 */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* 已经在屏幕上的东西移动 */
  --ease-in:     cubic-bezier(0.4, 0, 1, 1);         /* 只给「加速离开」 */
  --ease-sheet:  cubic-bezier(0.32, 0.72, 0, 1);     /* 抽屉，iOS 味 */
}
```

`cubic-bezier(.23,1,.32,1)` 是 Kimi 用得最多的一条（46 处，VERIFIED），也是 Linear 令牌里的 `ease-out-quint`；`cubic-bezier(.77,0,.175,1)` 是 Linear 的 `ease-in-out-quart`（VERIFIED）。`--ease-sheet` 来自 Vaul（INFERRED）。规则（VERIFIED：emilkowal.ski 的几篇）：进出屏幕用缓出；屏幕上的移动用缓入缓出；常规界面动画不超过 300 ms；**键盘触发的操作不加动画**（一天要重复几百次）；只动 `transform` 和 `opacity`；入场缩放从 0.9 以上开始，不要从 0。

弹簧（`linear()`）。下面四条是我用阻尼弹簧方程算出来、再用折线简化的（脚本在 scratchpad 的 `research-scripts/calc.cjs`）。时长要和曲线配套使用：

```css
:root {
  /* 柔：临界阻尼，无回弹。面板、折叠、布局移动。配 400ms */
  --spring-gentle: linear(0, 0.004 1%, 0.0188 2.3%, 0.0788 5%, 0.4652 17%, 0.638 23.5%,
    0.7065 26.8%, 0.7677 30.3%, 0.8176 33.8%, 0.8601 37.5%, 0.8991 42%, 0.9291 46.8%,
    0.9532 52.3%, 0.9711 58.5%, 0.9833 65.5%, 0.9914 73.8%, 1);
  --spring-gentle-dur: 400ms;

  /* 利落：阻尼比 0.8，过冲 1.5%。菜单、浮层、芯片、发送按钮。配 380ms */
  --spring-snappy: linear(0, 0.0053 1.3%, 0.024 2.8%, 0.0983 6%, 0.5326 18.8%, 0.718 25.3%,
    0.7856 28.2%, 0.8461 31.5%, 0.8944 34.8%, 0.932 38%, 0.9639 41.8%, 0.9872 45.8%,
    1.0031 50.2%, 1.012 55.3%, 1.0147 64.8%, 1);
  --spring-snappy-dur: 380ms;

  /* 弹：阻尼比 0.58，过冲 10.7%。只给小而有趣的东西：好评、对勾、徽标数字。配 560ms */
  --spring-bouncy: linear(0, 0.0072 1%, 0.034 2.3%, 0.1332 4.8%, 0.6629 13.8%, 0.869 18%,
    1.0078 22.3%, 1.0544 24.5%, 1.0847 26.8%, 1.1049 30%, 1.1031 33.8%, 1.0884 37%,
    1.0173 48.8%, 1.0005 53.3%, 0.9912 58%, 0.9887 64.3%, 0.9999 84.5%, 1);
  --spring-bouncy-dur: 560ms;

  /* 抽屉：阻尼比 0.9，几乎无过冲。底部抽屉、右侧面板滑入。配 500ms */
  --spring-sheet: linear(0, 0.0051 1.3%, 0.0231 2.8%, 0.0936 6%, 0.4939 18.8%, 0.6705 25.5%,
    0.7381 28.7%, 0.7947 32%, 0.8446 35.5%, 0.8843 39%, 0.9211 43.3%, 0.9504 48%,
    0.9719 53.3%, 0.9863 59%, 0.9952 65.5%, 0.9999 73.5%, 1);
  --spring-sheet-dur: 500ms;
}
```

线上的实物对照：ChatGPT 的 CSS 里有 `--spring-fast`（0.667 s）、`--spring-common`（0.667 s）、`--spring-bounce`（0.833 s）、`--spring-fast-bounce`（1 s）和 `--easing-spring-elegant`（0.58 s，过冲约 4%），全是 `linear()`，并且在不支持时退回 `ease-in-out`（VERIFIED）。Kimi 也有 30 处 `linear()` 弹簧（VERIFIED）。Material 3 Expressive 的弹簧参数：空间类 默认 阻尼 0.8 / 刚度 380，快 0.6 / 800，慢 0.8 / 200；效果类（颜色、透明度）一律阻尼 1，刚度 1600 / 3800 / 800；标准方案的空间类是阻尼 0.9，刚度 700 / 1400 / 300（VERIFIED：androidx 的 `ExpressiveMotionTokens.kt` / `StandardMotionTokens.kt`）。要点和 M3 一致：**位置和大小可以回弹，颜色和透明度不回弹**。

### 5.3 交互清单（带可实现的规格）

**1. 流式文字的出现。** 新到的文字淡入。Vercel 的 Streamdown 2.2 的做法：把每个词包成一个带 `data-sd-animate` 的元素，默认 `fadeIn`、150 ms、`ease`、按词；`blurIn` 推荐给一批一批吐字的快模型；流结束后清掉这些包装（VERIFIED：streamdown.ai/docs/animation）。也有项目因为「每个词一个 span」的开销没开它（VERIFIED：LodyAI/Lody#1002）。给本应用的做法：只包**这一次渲染新增的那段文字**，一个 span 而不是每词一个，动画结束就拆掉。

```css
@keyframes token-in { from { opacity: 0; filter: blur(3px); } to { opacity: 1; filter: none; } }
.stream-new { animation: token-in 220ms var(--ease-out) both; }
```

光标：等第一个字时用一个 8px 的橙色圆点做呼吸（Claude 是 `scale(.75) ⇄ scale(1)`、1.5 s、ease-in-out，VERIFIED）；开始出字后不需要光标，淡入本身就在指示位置。

**2. 「思考中」的扫光文字。** 两家的实物（VERIFIED）：Claude 是 `@keyframes shimmertext { 0% { background-position: top right } 65%, to { background-position: top left } }`，2.25 s 无限循环（后 35% 是停顿）；ChatGPT 是 `--cot-shimmer-duration: 2s`，背景 `linear-gradient(次要文字色 0%, 高亮色 40%, 高亮色 60%, 次要文字色 100%)`，`background-size: 50% 200%`、不重复、`background-clip: text`。

```css
.shimmer {
  --base: var(--ink-3);
  --hi: var(--ink-1);
  background: var(--base) linear-gradient(90deg, var(--base) 0%, var(--hi) 40%, var(--hi) 60%, var(--base) 100%)
    no-repeat -100% 0 / 50% 100%;
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: shimmer 2.2s linear infinite;
}
@keyframes shimmer { to { background-position: 300% 0; } }   /* 最后一段留白就是停顿 */
```

**3. 工具步骤时间线。** 节点出现：`scale(0.6) → 1` + 透明度，`--spring-snappy`。连接线：`transform: scaleY(0 → 1)`，`transform-origin: top`，240 ms 缓出。转圈 → 对勾：同一个 20px 的 SVG，圆圈用 `stroke-dasharray` 画出缺口并旋转；完成时圆圈补满（200 ms），对勾用 `stroke-dashoffset` 从 1 画到 0（240 ms、延迟 80 ms）。失败时把对勾换成叉，颜色从 `--ink-3` 过渡到 `--err`，不要抖动。

```css
.check path { stroke-dasharray: 1; stroke-dashoffset: 1; }   /* path 上加 pathLength="1" */
.done .check path { stroke-dashoffset: 0; transition: stroke-dashoffset 240ms var(--ease-out) 80ms; }
```

**4. 回合完成后折叠。** 桌面版直接对 `height: auto` 做过渡；Safari 用网格行。Claude 的折叠就是网格行写法：`@keyframes timeline-collapse { 0% { grid-template-rows: 1fr; opacity: 1 } to { grid-template-rows: 0fr; opacity: 0 } }`（VERIFIED）。

```css
:root { interpolate-size: allow-keywords; }                 /* Chrome 129+，别处忽略 */
.fold-body { height: auto; overflow: clip; transition: height var(--spring-gentle-dur) var(--spring-gentle), opacity var(--dur-fast); }
.fold-body[hidden] { display: block; height: 0; opacity: 0; }   /* 配合现有的「折叠用 hidden、不卸载」 */

/* 跨浏览器的写法 */
.fold { display: grid; grid-template-rows: 1fr; transition: grid-template-rows var(--dur-slow) var(--ease-in-out); }
.fold.closed { grid-template-rows: 0fr; }
.fold > div { min-height: 0; overflow: clip; }
```

摘要行在折叠完成后淡入（延迟 120 ms），不要和正文的收起同时发生。

**5. 输入框长高与进入运行态。** 高度：`field-sizing: content` 让文本框自己随内容长高（Chrome 123、Safari 26.2），配合 `interpolate-size` 可以带过渡；其它情况保留现有的 JS。运行态：RunCard 从输入框上沿后面滑出来（`translateY(100%) → 0`，`--spring-gentle`），同时输入框的环从墨色 6% 变到 12%。

**6. 发送 ⇄ 停止。** 同一个 32–36px 的圆按钮，两个图标叠在一起：出去的那个 `scale(1 → 0.5)` + 淡出 + 旋转 −90°（120 ms），进来的那个 `scale(0.5 → 1)` + 淡入（`--spring-snappy`）；按钮底色从墨色到墨色不变，不要闪。按下时 `scale(0.94)`。

**7. 消息「飞上去」。** 两种做法：(a) 视图过渡——发送时给输入框里的文字和新气泡同一个 `view-transition-name`，浏览器自己做位置和大小的插值；(b) 手写 FLIP——气泡挂载时量出它和输入框的位置差，从那里用 `--spring-snappy` 动到位。时长 320–380 ms。输入框清空要在同一帧完成，否则会看到两份文字。

**8. 骨架屏和加载的时机。** 延迟 150–300 ms 才显示，一旦显示至少留 300–500 ms，避免闪一下（VERIFIED：vercel.com/design/guidelines）。骨架的扫光 1.4 s 线性，颜色是 `--bg-2 → --bg-3 → --bg-2`。

**9. 面板、抽屉、对话框。** 右侧面板现在是 240 ms 的列宽过渡（会触发整页重排，这也是 ui-smoke 里「要等列宽到位再点」的来源）。改成：列宽立即到位，面板自己 `translateX(24px → 0)` + 淡入（`--spring-sheet`）。底部抽屉：`translateY(100% → 0)`、`--spring-sheet` 500 ms，背板 200 ms 淡入；支持向下拖动关闭，松手时按距离或速度判断。对话框：`scale(0.96 → 1)` + 淡入 200 ms，背板 150 ms；退场 120 ms、不缩放只淡出（Vercel 的遮罩层是 0.96、0.3 s，VERIFIED）。

**10. 不用 JS 的进场和退场。**

```css
.menu, [popover], dialog {
  opacity: 1; transform: none;
  transition: opacity var(--dur-base) var(--ease-out), transform var(--spring-snappy-dur) var(--spring-snappy),
    display var(--dur-base) allow-discrete, overlay var(--dur-base) allow-discrete;
}
@starting-style { .menu, [popover]:popover-open, dialog[open] { opacity: 0; transform: scale(0.96) translateY(-4px); } }
.menu[hidden], [popover]:not(:popover-open), dialog:not([open]) { opacity: 0; transform: scale(0.98); }
```

本应用很多面板是「用 `hidden` 切换、不卸载」，正好适合这套写法（给 `[hidden]` 写 `display: none` 之外的过渡需要 `allow-discrete`）。

**11. 浮层从触发点长出来。** `transform-origin` 设在锚点那一侧（菜单在按钮下方就是 `top left` 或 `top right`），从 0.96 放大。Emil 的说法是下拉菜单应该看起来是从触发按钮长出来的，默认的 `center` 是错的（VERIFIED：emilkowal.ski/ui/good-vs-great-animations）。现有的 `placeMenu` / `placeFixed` 已经知道菜单开在哪一边，把结果写成 `data-side`，CSS 按它设原点即可。tooltip：125 ms、缓出、0.97；连续看第二个 tooltip 时时长为 0（同一来源的 7 条建议那篇）。

**12. 悬停和按下。** 悬停底色**进入 0 ms、离开 150 ms**（Linear 的 `--speed-highlightFadeIn: 0s` / `FadeOut: .15s`，VERIFIED）——密集列表里鼠标划过时不拖影。按下：按钮 `scale(0.97)`（VERIFIED：Emil），80 ms；大卡片 0.99；行不缩放、只加深底色。`@media (hover: hover)` 里才写悬停样式，触屏上没有悬停。

**13. 焦点环。** 2px、`--focus-ring`、偏移 2px，圆角跟随元素（`outline` 在新浏览器里会跟着 `border-radius` 走）。只在 `:focus-visible` 出现。可以加一个 100 ms 的 `outline-offset: 0 → 2px` 过渡，让键盘导航时看得出焦点「落」在哪。

**14. toast 堆叠（Sonner 的做法）。** 每个 toast 绝对定位；后面的每一层上移 14px、缩小 5%（`scale = 1 − 0.05 × 序号`），并且高度都压成最前面那个的高度；`transition: transform 400ms ease`；悬停时展开成列表，位移 = 前面各个的高度之和 + 间距；滑动关闭在位移超过阈值或速度 > 0.11 px/ms 时生效；标签页不可见时暂停计时；默认 4 秒（VERIFIED：emilkowal.ski/ui/building-a-toast-component）。

**15. 数字滚动。** 用量、费用、+N −M、计时器一律 `font-variant-numeric: tabular-nums`。变化时每一位上下滚动 200–300 ms（`@number-flow/react`，MIT，很小），或者简单做法：整个数字淡出淡入 120 ms。流式过程中每个 token 都在变的数字（计时器）不要加动画。

**16. 成功反馈。** 复制按钮图标变成对勾（描边绘制 240 ms），1.5 s 后变回；提交成功后那一行的底色闪一下绿（`--ok-soft` 淡入 120 ms、淡出 600 ms）。不要撒彩带。

**17. 拖放。** 拿起：`scale(1.02)`、`--elev-3`、可选旋转 1°，原位置留一个 40% 透明度的占位。可放置区域：`--accent-soft` 底色 + 2px 虚线变实线。插入位置：一条 2px 的橙色线，位置变化时用 `transform` 平移（120 ms）。放下：用 `--spring-snappy` 落到位。分屏的边缘 25% 判定区用半透明的橙色矩形预览，矩形的位置和大小之间做 160 ms 过渡。

**18. 列表重排和共享元素。** 置顶、归档、排序变化：给每一行一个稳定的 `view-transition-name`（`session-<id>`），在 `startViewTransition` 里更新列表，浏览器自动做位移。几百行的列表只给视口里的行命名。共享元素：侧栏的会话标题 → 会话头的标题；图片缩略图 → 查看器。

```css
::view-transition-group(*) { animation-duration: var(--spring-gentle-dur); animation-timing-function: var(--spring-gentle); }
::view-transition-old(root), ::view-transition-new(root) { animation: none; }   /* 不要整页交叉淡化 */
```

**19. 滚动驱动。** 会话头在内容滚到它下面时才出现底部的细线和轻微模糊；滚动区域上下边缘按滚动位置渐隐。

```css
@supports (animation-timeline: scroll()) {
  .sess-head { animation: head-shadow linear both; animation-timeline: scroll(nearest); animation-range: 0 48px; }
  @keyframes head-shadow { to { box-shadow: 0 1px 0 var(--edge-subtle); backdrop-filter: blur(12px); } }
}
```

**20. 触感。** `navigator.vibrate` 只有 Android 上的 Chrome 有，iOS Safari 没有（VERIFIED）。可以在「允许一次」、发送、长按菜单时 `navigator.vibrate?.(8)`，当作锦上添花，不要依赖。

**21. 减少动态效果。** 现在是全部关掉。更好的做法是保留不产生位移的反馈：

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-slow: 0.01ms; --dur-slower: 0.01ms; --dur-page: 0.01ms;
          --spring-gentle: ease; --spring-snappy: ease; --spring-bouncy: ease; --spring-sheet: ease;
          --spring-gentle-dur: 0.01ms; --spring-snappy-dur: 0.01ms; --spring-bouncy-dur: 0.01ms; --spring-sheet-dur: 0.01ms; }
  .shimmer, .skeleton, .pulse { animation: none; }
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
  /* 保留：颜色、透明度、焦点环的过渡（--dur-fast / --dur-base） */
}
```

应用里的 `ui.reduceMotion` 开关和系统设置取并集。Vercel 规范还有两条值得照做：动画必须能被用户输入打断；永远不要写 `transition: all`（VERIFIED）。

### 5.4 要不要引入动画库

| | 体积 | 得到什么 | 代价 |
| --- | --- | --- | --- |
| 只用 CSS + 平台 API | 0 | 上面清单里的全部（桌面版是 Chromium 152） | 弹簧是固定时长的曲线，中途打断时不继承速度；共享布局动画要自己用视图过渡或 FLIP 写；Safari 上有几项降级 |
| `motion` 的 `useAnimate` mini | 2.3 KB | 基于 WAAPI 的命令式动画、序列 | 仍然没有布局动画 |
| `m` + `LazyMotion` + `domAnimation` | 4.6 KB 初始 + 15 KB | 声明式动画、`AnimatePresence` 退场、手势 | |
| 同上 + `domMax` | 4.6 KB + 25 KB | 再加**布局动画**（`layout`、`layoutId`）和拖拽 | |
| 完整的 `motion` 组件 | 34 KB，无法摇树到更小 | 全部 | |

（体积 VERIFIED：motion.dev/docs/react-reduce-bundle-size；`motion` 现在是 v14，MIT。）

判断：这个应用的结构——面板用 `hidden` 不卸载、布局是纯函数 reducer、桌面内核固定且很新——让 CSS 方案的短板（退场动画、高度到 `auto`）正好被平台特性补上了。`motion` 真正不可替代的是可打断且继承速度的弹簧、跨组件的 `layoutId`、拖拽排序；目前只有「标签拖动重排」和「分屏拖动」沾边，而它们已经用原生拖放实现了。

值得读的公开材料：

- Emil Kowalski：7 Practical Animation Tips、Good vs Great Animations、Great Animations、Building a toast component（emilkowal.ski/ui/…）；课程 animations.dev。（VERIFIED）
- Vercel：Web Interface Guidelines（vercel.com/design/guidelines）。（VERIFIED）
- Josh Comeau：Designing Beautiful Shadows in CSS（VERIFIED）；Springs and Bounces in Native CSS（讲 `linear()`，INFERRED）。
- Linear：How we redesigned the Linear UI（VERIFIED）。
- Rauno Freiberg：Invisible Details of Interaction Design（rauno.me/craft/interaction-design）和他的课程 devouringdetails.com。（INFERRED，今天没有打开）
- Material 3 Expressive 的 motion physics（参数见上，VERIFIED 于 androidx 源码）；Apple HIG 的 Motion 一章和 SwiftUI 的 `.smooth / .snappy / .bouncy` 预设（INFERRED）。

### 建议

**推荐**：**只用 CSS，不引入库。** 先落令牌（6 档时长、4 条缓动、4 条 `linear()` 弹簧），再按价值顺序做：① 悬停 0 ms 进 / 150 ms 出、按下 0.97；② 菜单和浮层的 `@starting-style` 进退场 + 从锚点长出；③ 回合折叠和工具步骤（转圈 → 对勾）；④ 思考扫光和流式淡入；⑤ 发送 ⇄ 停止、消息飞上去；⑥ 右侧面板和抽屉的弹簧；⑦ 视图过渡做列表重排和共享元素（升级到 React 19.3 用 `<ViewTransition>`，或手写 `startViewTransition`）。减少动态效果时保留颜色和透明度的过渡。

**备选**：如果之后要做拖拽排序、可打断的手势（抽屉跟手、卡片甩出）、或者很多跨组件的共享布局动画，引入 **`motion` 的 `m` + `LazyMotion`**，按需加载 `domMax`（合计约 30 KB），只在那几个组件里用，其余继续用 CSS。

---

## 6. 一页纸设计语言草案（交给实现的人）

### 字体

```css
:root {
  --font-cjk: "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC";
  --font: "Inter Variable", -apple-system, "Segoe UI Variable Text", "Segoe UI", var(--font-cjk), system-ui, sans-serif;
  --mono: "JetBrains Mono Variable", "Cascadia Code", "SF Mono", Menlo, Consolas, var(--font-cjk), monospace;

  --fs-micro: 11px;  --lh-micro: 14px;   /* 只给拉丁和数字 */
  --fs-meta: 12px;   --lh-meta: 16px;    /* 中文下限 */
  --fs-sm: 13px;     --lh-sm: 18px;
  --fs-base: 14px;   --lh-ui: 20px;
  --fs-body: 15px;   --lh-body: 26px;    /* 对话正文；手机 16 / 28 */
  --fs-lg: 16px;     --lh-lg: 24px;
  --fs-xl: 20px;     --lh-xl: 28px;
  --fs-display: 28px; --lh-display: 36px; /* 手机 24 / 32 */
  --fs-code: 13px;   --lh-code: 20px;

  --fw-regular: 400; --fw-medium: 500;   /* 500 只对拉丁有效，不要靠它表达层级 */
  --fw-strong: 600;                       /* 标题和真正的强调 */
}
html { font-optical-sizing: auto; font-feature-settings: "cv11", "ss03", "calt"; font-synthesis: none; text-autospace: normal; }
code, pre, kbd { font-variant-ligatures: none; font-feature-settings: "zero", "calt" 0; text-autospace: no-autospace; }
```

规则：字号全用整数；中文不小于 12px；中文不加负字距；数字用 `tabular-nums`；强调优先用颜色（`--ink-1` 对 `--ink-2`），其次 600；打包 Inter Variable（正体 + 斜体）和 JetBrains Mono Variable，带上各自的 `OFL.txt`；不打包任何厂商中文字体。

### 颜色（A · 暖纸）

```css
:root, :root[data-theme="light"] {
  --bg: #fefdfc; --bg-1: #f7f6f2; --bg-2: #f0eeea; --bg-3: #e6e4df; --bg-elev: #ffffff;
  --fg: #1c1917; --fg-1: #47433f; --fg-2: #67625f; --fg-3: #7f7b77;
  --accent: #d97956; --accent-text: #aa4b27; --accent-fg: #1c1917;
  --accent-soft: color-mix(in oklab, var(--accent) 14%, transparent);
  --primary: #1c1917; --primary-fg: #fefdfc;
  --green: #12773d; --red: #be2a27; --yellow: #8a5d0b; --blue: #1c63bf;
  --shade: 40 30 20;
}
:root[data-theme="dark"] {
  --bg: #1b1a18; --bg-1: #12110f; --bg-2: #252321; --bg-3: #302f2c; --bg-elev: #272623;
  --fg: #eeedea; --fg-1: #c4c2be; --fg-2: #a5a39e; --fg-3: #868480;
  --accent: #e68964; --accent-text: #f39e77; --accent-fg: #1b1a18;
  --primary: #eeedea; --primary-fg: #1b1a18;
  --green: #69d98d; --red: #ff8179; --yellow: #f0c464; --blue: #80b6fb;
  --shade: 0 0 0;
}
```

规则：语义层继续用 `color-mix(in oklab, var(--fg) N%, transparent)` 派生；描边 = 墨色 6% / 10% / 16%；悬停 / 选中 / 按下 = 墨色 5% / 8% / 11%；暗色的层级靠更亮的面 + `rgb(255 255 255 / .08)` 的环；橙色只用于品牌、焦点环、选中指示、流式光点，橙色底上的字用墨色；橙色文字用 `--accent-text`；黄色只给「需要你」；主按钮是墨色。改原色前先跑 `contrast.test.ts`（这组数值按它的阈值自算通过）。

### 圆角、阴影、间距

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--r-xs` | 4 | 行内标记、键帽 |
| `--r-sm` | 6 | 小徽标、复选框 |
| `--r-row` | 8 | 侧栏行、菜单项、列表行 |
| `--r-md` | 10 | 按钮、输入框、图标按钮 |
| `--r-lg` | 12 | 菜单、浮层、代码块、工具卡 |
| `--r-xl` | 16 | 卡片、主面板、右侧面板 |
| `--r-2xl` | 24 | 输入框、对话框（20–24）、抽屉上边 |
| `--r-pill` | 999 | 芯片、分段控件、输入框里的圆按钮 |

- 嵌套：内圆角 = 外圆角 − 内边距（不小于 4）。
- 阴影：`--elev-1 / -2 / -3 / -composer` 用 3.2 节 (5) 的配方；浮起来的东西用阴影环，不写 `border`。
- 桌面增强：`@supports (corner-shape: squircle)` 里给大的面 `corner-shape: superellipse(1.3)`，圆角放大 15–20%。
- 间距：4 / 8 / 12 / 16 / 20 / 24 / 32 / 40。控件高 28 / 32 / 36 / 40；行高 32（手机 40）；外壳留边 8；卡片内边距 14–16；阅读列宽 720。
- 输入框：圆角 24，内边距 12 / 14 / 10，发送按钮 34 的圆。
- 实线描边的目标：从 177 处降到 60 处以内。

### 图标

- 几何取自 Lucide（ISC），生成进现有的 `PATHS` 表，不加运行时依赖；品牌和 Agent 标志保留手绘。
- 线宽：16px 图标 1.5 绝对像素，18–20px 1.5–1.6，24px 1.75；圆头圆角。
- 尺寸：行内 16，工具栏 18，空状态 24–32；点击区不小于 24（手机 44）。
- 颜色：默认 `--ink-3`，悬停和选中 `--ink-1`；选中加 16% 的柔填充；8–10 个需要实心的手绘 `-fill` 版。
- 动画图标只做：复制 → 对勾、发送 ⇄ 停止、转圈 → 对勾、箭头旋转、侧栏开合、好评。

### 动效

```css
:root {
  --dur-instant: 80ms; --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 240ms; --dur-slower: 320ms; --dur-page: 480ms;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);
  /* --spring-gentle / -snappy / -bouncy / -sheet 及各自的 -dur：见 5.2 */
  interpolate-size: allow-keywords;
}
```

| 场景 | 属性 | 时长 / 曲线 |
| --- | --- | --- |
| 悬停底色 | background | 进 0，出 150 ms |
| 按下 | transform: scale(0.97) | 80 ms，缓出 |
| 菜单、浮层进场 | opacity + scale(0.96 → 1)，原点在锚点 | 180 ms 缓出 / snappy 弹簧；退场 120 ms |
| tooltip | opacity + scale(0.97) | 125 ms；连续第二个 0 ms |
| 折叠 / 展开 | height（或网格行）+ opacity | gentle 弹簧 400 ms |
| 面板、抽屉 | transform | sheet 弹簧 500 ms；背板 200 ms |
| 对话框 | opacity + scale(0.96) | 200 ms 缓出；退场 120 ms |
| 流式文字 | opacity + blur(3px) | 220 ms 缓出，只包新增的那一段 |
| 思考扫光 | background-position | 2.2 s 线性循环 |
| 列表重排、共享元素 | 视图过渡 | gentle 弹簧 400 ms |
| toast | translateY + scale（每层 −14px、−5%） | 400 ms ease |
| 对勾绘制 | stroke-dashoffset | 240 ms 缓出 |

规则：位置和大小可以回弹，颜色和透明度不回弹；键盘触发的操作不加动画；只动 `transform` / `opacity`（高度用 `interpolate-size` 或网格行）；不写 `transition: all`；动画可以被输入打断；加载指示延迟 150–300 ms 才出现、至少显示 300–500 ms；减少动态效果时保留颜色和透明度的过渡、去掉位移和循环动画；不引入动画库。

---

## 来源

**产品线上的 CSS（今天读取）**：claude.ai（assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c6a992d55-CGuUmOei.css）、chatgpt.com（/cdn/assets/root-mhtfjdn4.css）、kimi.com（statics.moonshot.cn/kimi-web-seo/assets/*.css）、linear.app（static.linear.app/web/_next/static/css/*.css）、vercel.com 与 vercel.com/geist/colors、v0.app、cursor.com、notion.com、raycast.com、manus.im、doubao.com/chat、diabrowser.com、yuanbao.tencent.com、qianwen.com、feishu.cn、yuque.com。perplexity.ai 和 claude.ai 的页面本身返回 403；chat.deepseek.com、chatglm.cn 没读到有用的内容。

**数据接口**：github.com/mdn/browser-compat-data（main）；releases.electronjs.org；registry.npmjs.org；unpkg.com/react@19.3.0 与 @19.2.8；api.fontsource.org；cdn.jsdelivr.net/npm/@iconify-json/*；api.github.com；rsms.me/inter/font-files；unpkg.com/@primer/primitives；raw.githubusercontent.com/tailwindlabs/tailwindcss（theme.css）；raw.githubusercontent.com/androidx/androidx（Material 3 的 motion tokens）。

**文章和文档**：

- https://vercel.com/design/guidelines
- https://emilkowal.ski/ui/7-practical-animation-tips ・ https://emilkowal.ski/ui/good-vs-great-animations ・ https://emilkowal.ski/ui/great-animations ・ https://emilkowal.ski/ui/building-a-toast-component
- https://www.joshwcomeau.com/css/designing-shadows/
- https://linear.app/now/how-we-redesigned-the-linear-ui
- https://www.smashingmagazine.com/2026/03/beyond-border-radius-css-corner-shape-property-ui/
- https://motion.dev/docs/react-reduce-bundle-size
- https://streamdown.ai/docs/animation ・ https://vercel.com/changelog/streamdown-2-2
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-autospace
- https://issues.chromium.org/issues/409486609 ・ https://issues.chromium.org/issues/415261549（Windows 上的 Noto CJK 发虚）
- https://support.microsoft.com/en-us/topic/april-8-2025-kb5055523-os-build-26100-3775-277a9d11-6ebf-410c-99f7-8c61957461eb
- https://blog.xinshijiededa.men/font-license/hant/（HarmonyOS Sans / MiSans 的协议分析）・ https://hyperos.mi.com/font/zh/faq/
- https://github.com/lxgw/LxgwNeoXiHei ・ https://github.com/KonghaYao/cn-font-split
- https://github.com/Remix-Design/RemixIcon/issues/1069（Remix Icon 换许可）
- https://www.minoradventures.co/blog/the-making-of-cursors-icons
- https://fontsinuse.com/uses/72596/comet（Perplexity 的字体，二手）
- https://blog.zengrong.net/post/font-weight-500/

**没能核实、用之前要再查的**：阿里巴巴普惠体 3.0 和 OPPO Sans 的协议原文；Claude 用哪套图标；Perplexity 的线上字体；`corner-shape` 是否影响 `overflow` 裁剪；`text-autospace` 在各浏览器里的实际默认值；Commit Mono、Cascadia Code、Sarasa 的许可原文（各数据源标注不一致或未被识别）；Untitled UI 免费图标的数量和条款；Lucide 单个图标模块的体积。
