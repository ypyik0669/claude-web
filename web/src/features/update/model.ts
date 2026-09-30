// The app's own updates, renderer side (desktop only): what the prompt says and when it shows. The main process
// decides how this build updates (desktop/src/update-policy.ts) and sends its state on `desktop:update`.

/** desktop/src/main.ts `UpdateState`. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';
  /** auto: the Windows installer downloads and installs; manual: macOS (unsigned), the portable exe — a download link */
  mode?: 'auto' | 'manual';
  version?: string;
  percent?: number;
  error?: string;
  notes?: string;
  /** the release notes carry 【必须更新】: no 稍后 */
  required?: boolean;
  /** the file for this machine (manual mode; also the fallback when a download fails) */
  url?: string;
  /** the release page */
  page?: string;
}

export interface Prompt {
  /** ready: downloaded, a restart installs it; download: the user downloads it (manual mode, or a required one whose download failed) */
  kind: 'ready' | 'download';
  version: string;
  required: boolean;
  notes?: string;
  url?: string;
  page?: string;
}

/** 稍后 puts a prompt off this long (and until the next start, which asks again). */
export const SNOOZE_MS = 24 * 60 * 60_000;

/** The prompt to show now, or null. `snoozed`: version → when 稍后 was pressed. */
export function promptFor(s: UpdateState | null | undefined, snoozed: Record<string, number>, now: number): Prompt | null {
  if (!s?.version) return null;
  let kind: Prompt['kind'] | null = null;
  if (s.mode === 'auto' && s.status === 'downloaded') kind = 'ready';
  else if (s.mode !== 'auto' && s.status === 'available') kind = 'download';
  // a failed automatic download is not worth a popup — the next check tries again — unless the release is required
  else if (s.required && s.status === 'error' && s.url) kind = 'download';
  if (!kind) return null;
  if (!s.required && now - (snoozed[s.version] ?? -Infinity) < SNOOZE_MS) return null;
  return { kind, version: s.version, required: !!s.required, notes: s.notes, url: s.url, page: s.page };
}

export interface PromptCopy {
  title: string;
  lead: string;
  primary: string;
  /** under the buttons: what 稍后 means */
  later?: string;
  /** after the download button: what to do with the file */
  after?: string;
  /** a restart ends running conversations */
  warn?: string;
}

/** The words, by kind and by what this build is. */
export function promptCopy(p: Prompt, o: { platform: string; mode?: UpdateState['mode']; portable?: boolean; running: number }): PromptCopy {
  const title = p.required ? `这一版必须更新：v${p.version}` : p.kind === 'ready' ? `新版本 v${p.version} 已准备好` : `有新版本 v${p.version}`;
  if (p.kind === 'ready') {
    return {
      title,
      lead: '已经在后台下载好了，重启一下就能用上。',
      primary: '立即重启更新',
      later: p.required ? undefined : '稍后：下次退出软件时会自动装好。',
      warn: o.running > 0 ? `有 ${o.running} 个对话正在运行，重启会中断它们（记录都在，重启后发消息就能继续）。` : undefined,
    };
  }
  if (o.platform === 'darwin') {
    return {
      title,
      lead: 'macOS 版没有 Apple 签名，不能自己安装更新：点下面的按钮下载新版。',
      primary: '下载新版本',
      later: p.required ? undefined : '稍后：明天或下次打开软件时再提醒。',
      after: '下载好以后：退出本软件，打开下载的 dmg，把 Claude Web 拖进「应用程序」，选「替换」。对话和设置都会保留。',
    };
  }
  if (o.portable) {
    return {
      title,
      lead: '免安装版不能自己更新：点下面的按钮下载新的免安装版。',
      primary: '下载新版本',
      later: p.required ? undefined : '稍后：明天或下次打开软件时再提醒。',
      after: '下载好以后：退出本软件，用新的 exe 替换现在这个。对话和设置不在 exe 里，不会丢。',
    };
  }
  return {
    title,
    lead: o.mode === 'auto' ? '自动下载没有成功：点下面的按钮手动下载安装包。' : '点下面的按钮下载新版本。',
    primary: '下载新版本',
    later: p.required ? undefined : '稍后：明天或下次打开软件时再提醒。',
    after: '下载好以后：退出本软件，运行下载的安装包覆盖安装。对话和设置都会保留。',
  };
}
