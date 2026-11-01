// Every text the site shows, in one place: each is a tr('中文') (the Chinese is the key, the English is in
// i18n/en.ts). .astro files take their words from here and hold none of their own (i18n/text.test.ts).
import { makeTr, type Locale } from './i18n';

export interface Chapter {
  id: string;
  title: string;
  body: string;
  /** The README walkthrough step that explains it: the start of its English heading ("3. "). */
  readme: string;
}

export function copy(locale: Locale) {
  const tr = makeTr(locale);
  const chapters: Chapter[] = [
    { id: 'agents', title: tr('派活，它们自己去干'), body: tr('一句话交代下去，Claude 会分出子代理并行干活。每个子代理是网吧里的一位客人：进门、找座位、开机。'), readme: '11. ' },
    { id: 'turns', title: tr('一回合折成一行'), body: tr('读了哪些文件、改了什么、跑了哪条命令，折成一行摘要；想看细节，点开就是完整的时间线。'), readme: '2. ' },
    { id: 'permission', title: tr('要你点头的时候，它举手'), body: tr('改文件、跑命令之前先问你。权限卡停在输入框上方，一键允许或拒绝，不会被新消息冲走。'), readme: '3. ' },
    { id: 'review', title: tr('改了什么，当场看'), body: tr('每一回合改过的文件都有一张卡，点开就是逐行对比；在哪一行留句话，它接着改。'), readme: '4. ' },
    { id: 'checkout', title: tr('干完了，结账'), body: tr('每个子代理干完到前台结账：用了多久、多少 token、大约多少钱，一目了然。'), readme: '11. ' },
    { id: 'elsewhere', title: tr('不止这台电脑'), body: tr('另一台电脑上的对话、手机上的远程，都在这里：打开、续聊、审批，像在本机一样。'), readme: '9. ' },
  ];
  return {
    meta: {
      title: tr('Claude Web：Claude Code，有了界面'),
      description: tr('Claude Code 的桌面版和网页版：对话、审阅、分屏、手机远程。底下跑的就是官方 Claude Code。免费开源。'),
      sceneAlt: tr('Claude Web 的网吧：每个子代理是一位坐在电脑前的客人'),
    },
    nav: {
      skip: tr('跳到正文'),
      label: tr('网站导航'),
      footer: tr('页脚链接'),
      features: tr('功能'),
      themes: tr('主题'),
      download: tr('下载'),
      changelog: tr('更新内容'),
    },
    hero: {
      title: tr('Claude Code，有了界面。'),
      sub: tr('桌面版和网页版：对话、审阅、分屏、手机远程。底下跑的就是官方 Claude Code。'),
      fine: tr('免费开源 · Windows、macOS 和网页 · 不用注册'),
      hint: tr('滚动看它们干活'),
    },
    dl: {
      win: tr('下载 Windows 版'),
      mac: tr('下载 macOS 版'),
      macIntel: tr('Intel 芯片的 Mac'),
      source: tr('从源码跑'),
      other: tr('其它下载方式'),
    },
    chapters,
    chapterMore: tr('详细说明'),
    showcase: {
      title: tr('十套皮，换着穿'),
      sub: tr('同一个应用、同一回合，在每套字符画主题下各录一段。拖动画面看任意一秒，打开「对比」左右对照。'),
      home: tr('首页'),
      turn: tr('跑一回合'),
      waiting: tr('等你批准'),
      describe: tr('描述'),
      trial: tr('试跑'),
      apply: tr('换上新主题'),
      describeNew: tr('描述一个新的'),
      describeNote: tr('这是 Claude Web 自己生成的；你也可以描述一个'),
      compare: tr('对比'),
      play: tr('播放'),
      pause: tr('暂停'),
      light: tr('浅色'),
      dark: tr('深色'),
      pick: tr('选一套主题'),
      timeline: tr('时间轴'),
      stage: tr('主题录像'),
      unavailable: tr('录像暂时看不了'),
    },
    stats: {
      label: tr('数字'),
      stars: tr('GitHub 星标'),
      releases: tr('发布的版本'),
    },
    install: {
      title: tr('装上就能用'),
      body: tr('桌面版自带运行环境，不用另装 Node.js；网页版从源码跑，几条命令。'),
    },
    scene: {
      labels: {
        agents: tr('网吧全景：三个子代理进门、找座位、开机干活'),
        turns: tr('api 的座位：一回合折成一行，点开是时间线'),
        permission: tr('api 举手了：它要运行一条命令，等你允许'),
        review: tr('tests 的座位：改了 2 个文件，点开看逐行对比'),
        checkout: tr('前台：tests 干完了，正在结账'),
        elsewhere: tr('门口：另一台电脑上的 lint 进来了'),
      } as Record<string, string>,
      turn: { summary: tr('干了 52 秒 · 读 1 个文件 · 改 2 个 · 跑 1 条命令'), run: tr('运行') },
      permission: {
        badge: tr('需要你'),
        title: tr('{name} 想运行一条命令', { name: 'api' }),
        allow: tr('允许'),
        deny: tr('拒绝'),
        allowed: tr('好，接着干'),
        denied: tr('好吧，换个办法'),
      },
      review: { card: tr('改了 2 个文件') },
      receipt: { title: tr('结账 · {name}', { name: 'tests' }), took: tr('用了 {time}', { time: '0:21' }), tab: tr('网费 {yuan}', { yuan: '¥0.03' }) },
      elsewhere: { other: tr('其它电脑'), phone: tr('手机上的远程') },
      doing: {
        work: tr('在干活'), game: tr('在打游戏'), eat: tr('在吃泡面'), drink: tr('在喝饮料'), toilet: tr('上厕所'), smoke: tr('在吸烟区'),
        power: tr('在借充电宝'), chat: tr('在聊天'), stand: tr('在闲逛'), checkin: tr('在开机'), checkout: tr('在结账'), leave: tr('下机了'), other: tr('在路上'),
      },
      sound: { on: tr('声音：开'), off: tr('声音：关') },
      debug: { title: tr('调试面板'), speed: tr('速度'), seed: tr('种子'), reseed: tr('换种子') },
    },
    footer: {
      notice: tr('社区项目，与 Anthropic 无关。“Claude” 和 “Claude Code” 是 Anthropic 的商标。'),
      license: tr('© Claude Web 贡献者 · MIT 许可'),
    },
    download: {
      title: tr('下载 Claude Web'),
      version: (version: string, date: string) => tr('版本 {version} · {date}', { version, date }),
      allReleases: tr('所有版本'),
      installer: tr('安装版'),
      portable: tr('便携版（免安装，单个 exe）'),
      arm64: tr('Apple 芯片（M 系列）'),
      x64: tr('Intel 芯片'),
      macNote: tr('第一次打开时 macOS 可能会拦下，处理办法见'),
      warnings: tr('安装包的提示'),
      sourceNeeds: tr('需要 Node.js 22.13+ 和 Git。装好后打开 http://127.0.0.1:3090。'),
      copy: tr('复制'),
      copied: tr('已复制'),
      missing: tr('这个版本没有这个安装包'),
    },
  };
}

export type Copy = ReturnType<typeof copy>;
