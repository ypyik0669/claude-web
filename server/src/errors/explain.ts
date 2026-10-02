// What an error means, in the user's words. One table for the server (a conversation's process failing) and the web
// app (every toast): the original text is kept underneath, so a screenshot or an issue still carries the real error.

interface Rule {
  /** matches the raw error text (case-insensitive patterns) */
  test: RegExp;
  /** one line: what happened, then what to do */
  say: string | ((m: RegExpMatchArray) => string);
}

// Status codes only count next to a word that makes them a status (a path or a line number with 404 in it is not one).
const status = (codes: string) => new RegExp(`(?:\\b(?:http|status|code|error|错误)\\b[^\\d\\n]{0,4}(?:${codes})\\b|\\b(?:${codes})\\s+(?:[A-Za-z][A-Za-z ]{2,30})?(?:error|not found|unauthorized|forbidden|too many requests|bad gateway|unavailable|timeout)|"status"\\s*:\\s*(?:${codes})\\b)`, 'i');

/** Most specific first: the first rule that matches explains the error. */
const RULES: Rule[] = [
  // ---- a program that did not start ----
  { test: /exists but failed to launch/i, say: '对话进程没能启动：程序文件在，但启动失败。最常见的原因是对话的项目文件夹已经不存在（被移动、改名或删除），其次是被杀毒软件拦截。换一个存在的项目文件夹新开对话，或把本软件加入杀毒软件的白名单。' },
  { test: /\bspawn\b[^\n]*\bENOENT\b|\bENOENT\b[^\n]*\bspawn\b/i, say: '没能启动程序：找不到要运行的程序，或者工作文件夹不存在。检查程序有没有装好（设置 → Agents 与子代理），以及项目文件夹还在不在。' },
  { test: /\bspawn\b[^\n]*\b(EACCES|EPERM)\b|\b(EACCES|EPERM)\b[^\n]*\bspawn\b/i, say: '没能启动程序：没有运行它的权限，常见是被杀毒软件或系统安全策略拦截。把本软件加入白名单后重试。' },
  { test: /\bcannot find module\b|\bMODULE_NOT_FOUND\b|\bERR_MODULE_NOT_FOUND\b/i, say: '程序文件缺失：安装可能不完整或被杀毒软件删掉了文件。重新安装本软件（从源码运行的话执行 npm install）。' },
  { test: /no conversation found with session id/i, say: '找不到这个对话的记录：它还没发过消息，或者记录文件被移动 / 删除了。新开一个对话再试。' },
  { test: /\bnot logged in\b|please run \/login|invalid x-api-key|oauth token (?:has )?expired/i, say: '没有登录或登录过期：终端里运行 claude auth login 重新登录，或者在 设置 → 供应商 接一个模型。' },

  // ---- files and the disk ----
  { test: /\bENOSPC\b|no space left on device/i, say: '磁盘空间不足：清理一些空间后重试。' },
  { test: /\bEMFILE\b|too many open files/i, say: '同时打开的文件太多：关掉一些对话或程序后重试。' },
  { test: /\bEBUSY\b|resource busy or locked|being used by another process/i, say: '文件被别的程序占用：关掉正在使用它的程序（编辑器、杀毒软件、其它 Agent）后重试。' },
  { test: /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|access is denied/i, say: '没有权限：文件或文件夹是只读的、属于别的用户，或者被杀毒软件拦截了。' },
  { test: /\bEISDIR\b/i, say: '这里需要一个文件，但给的是一个文件夹。' },
  { test: /\bENOTDIR\b/i, say: '这里需要一个文件夹，但给的是一个文件。' },
  { test: /\bEEXIST\b|already exists/i, say: '同名的文件或文件夹已经存在：换个名字，或者先处理掉已有的那个。' },
  { test: /\bENOENT\b|no such file or directory|cannot find the (?:path|file) specified/i, say: '找不到文件或文件夹：它可能被移动、改名或删除了。' },
  { test: /not a git repository/i, say: '这个文件夹不是 git 仓库：在 Git 视图里初始化一个，或者打开仓库所在的文件夹。' },

  // ---- the network ----
  { test: /\bEADDRINUSE\b|address already in use/i, say: '端口被占用：有另一个程序（或另一个本软件）正在用这个端口。关掉它，或换一个端口。' },
  { test: /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i, say: '域名解析失败：地址可能拼错了，或者网络 / DNS / 代理有问题。检查地址，开着梯子的话看看 设置 → 供应商 → 网络代理。' },
  { test: /\bECONNREFUSED\b|connection refused/i, say: '连接被拒绝：那个地址上没有服务在监听。检查地址和端口；如果是本机代理（如 127.0.0.1:7890），确认梯子开着。' },
  { test: /\bECONNRESET\b|socket hang up|connection reset|other side closed|\bEPIPE\b/i, say: '连接被中途断开：对方或代理断开了连接。重试一次；经常这样的话，检查网络代理设置。' },
  { test: /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|timed? ?out|timeout/i, say: '超时：网络不通、对方太慢，或者代理有问题。检查网络和代理后重试。' },
  { test: /self[- ]signed certificate|unable to verify the first certificate|certificate has expired|\bUNABLE_TO_VERIFY_\w+|\bDEPTH_ZERO_SELF_SIGNED_CERT\b|\bSELF_SIGNED_CERT_IN_CHAIN\b|\bCERT_[A-Z_]+\b|\bERR_TLS_|ssl routines|wrong version number/i, say: 'HTTPS 证书校验失败：地址的证书有问题，或者代理在拦截 HTTPS。检查地址是不是 https 开头写对了，以及代理设置。' },
  { test: /\bfetch failed\b|network error|failed to fetch/i, say: '请求没发出去：网络、代理或地址有问题。' },

  // ---- what the API answered ----
  { test: /unsupported_country|access from this region|(?:region|country|territory|location)\b[^\n]{0,40}\b(?:not supported|unsupported|not available|restricted|not allowed)|not available in your (?:location|area|region|country)/i, say: '地区限制：这个服务不对你当前所在的地区开放。在 设置 → 供应商 → 网络代理 里走代理，或换一个中转。' },
  { test: /insufficient(?:[_ ]\w+)?[_ ](?:balance|quota|funds|credit)|credit balance is too low|quota exceeded|exceeded your (?:current )?quota|billing|余额不足|额度不足/i, say: '余额或额度不足：去供应商那里充值，或者换一个供应商。' },
  { test: /prompt is too long|context[_ ]length|maximum context|context window|too many tokens/i, say: '对话太长，超过了模型能处理的上下文：发送 /compact 压缩，或从某条消息分叉一个新对话。' },
  { test: /model[_ ]not[_ ]found|model .{0,40}(?:does not exist|not found|not supported|is not available)|no such model|invalid model/i, say: '模型不存在：这个供应商没有这个模型名。在 设置 → 供应商 里点「测试连接」看看它支持哪些模型。' },
  { test: new RegExp(`${status('401').source}|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|authentication[_ ](?:error|failed)`, 'i'), say: 'API Key 不对或已经失效：在 设置 → 供应商 里重新填 Key 并测试连接。' },
  { test: new RegExp(`${status('403').source}|forbidden`, 'i'), say: '没有权限访问：这个 Key 没开通该模型，或被供应商 / 中转拒绝了。' },
  { test: new RegExp(`${status('404').source}`, 'i'), say: '地址不对：接口不存在。检查 设置 → 供应商 里的地址（Base URL）有没有填错。' },
  { test: new RegExp(`${status('429').source}|rate[_ ]limit|too many requests`, 'i'), say: '请求太频繁，被限流了：等一会儿再试。' },
  { test: new RegExp(`${status('5\\d\\d').source}|overloaded|internal server error|bad gateway|service unavailable|gateway timeout`, 'i'), say: '对方服务出错或过载（5xx）：通常稍后重试就好。' },
  { test: /unexpected token .{0,20}in json|unexpected end of json|is not valid json|<!doctype html/i, say: '收到的内容不是接口数据：地址可能指向了网页而不是 API。检查 Base URL（通常以 /v1 结尾或是中转给的接口地址）。' },

  // ---- last: the process died and nothing above says why ----
  // The message carries what the CLI printed before exiting (「（CLI 输出：…）」), so a rule above that recognizes that
  // output (not logged in, not a git repository, 401…) explains it better than the bare exit code.
  { test: /process exited with code (\d+)|exited with code (\d+)/i, say: (m) => `对话进程退出了（退出码 ${m[1] ?? m[2]}）。日志 server.log 里以 [claude …] 开头的几行是它退出前打印的内容；反馈问题时请一起附上。` },
];

/** The marker the explained text carries; explaining twice keeps one explanation. */
const RAW = '原文：';

/** A one-line Chinese explanation of `raw`, or null when it is not one we know (shown as it is, never guessed). */
export function explainError(raw: string): string | null {
  if (!raw) return null;
  for (const r of RULES) {
    const m = raw.match(r.test);
    if (m) return typeof r.say === 'function' ? r.say(m) : r.say;
  }
  return null;
}

/** `raw` with its explanation on top and the original underneath — what conversations and toasts show. */
export function withExplanation(raw: string): string {
  if (!raw || raw.includes(RAW)) return raw;
  const say = explainError(raw);
  return say ? `${say}\n${RAW}${raw}` : raw;
}
