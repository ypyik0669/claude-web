import { describe, expect, it } from 'vitest';
import { explainError, withExplanation } from './explain.js';

// Real error texts (from user reports, the SDK, Node, relays and providers) → what the explanation must say.
const SEEN: [string, RegExp][] = [
  ['Claude Code executable at D:\\Claude Web\\resources\\app.asar.unpacked\\node_modules\\claude-code-best\\dist\\cli-node.js exists but failed to launch.', /对话进程没能启动.*项目文件夹已经不存在/],
  ['spawn C:\\nvm4w\\nodejs\\node.exe ENOENT', /没能启动程序：找不到要运行的程序，或者工作文件夹不存在/],
  ['spawn EPERM', /没能启动程序：没有运行它的权限/],
  ["Error: Cannot find module 'C:\\x\\cli-node.js'", /程序文件缺失/],
  ['Claude Code process exited with code 1', /对话进程退出了（退出码 1）/],
  // the CLI's own last words ride along after the exit code; what they say beats the bare exit code
  ['Claude Code process exited with code 1（CLI 输出：fatal: not a git repository (or any of the parent directories): .git）', /不是 git 仓库/],
  ['Claude Code process exited with code 1（CLI 输出：Not logged in · Please run /login）', /没有登录或登录过期/],
  ['Claude Code process exited with code 1（CLI 输出：API Error: 401 {"error":{"message":"Invalid API key"}}）', /API Key 不对或已经失效/],
  ['Not logged in · Please run /login', /没有登录或登录过期/],
  ['Claude Code returned an error result: No conversation found with session ID: 24f2b165-07d7-4b68-ae3c-a76fee4326e5', /找不到这个对话的记录/],
  ['ENOSPC: no space left on device, write', /磁盘空间不足/],
  ["EBUSY: resource busy or locked, rename 'C:\\Users\\x\\config.toml'", /文件被别的程序占用/],
  ["EPERM: operation not permitted, open 'C:\\Program Files\\x'", /没有权限/],
  ["ENOENT: no such file or directory, open 'C:\\x\\a.ts'", /找不到文件或文件夹/],
  ['fatal: not a git repository (or any of the parent directories): .git', /不是 git 仓库/],
  ['listen EADDRINUSE: address already in use 127.0.0.1:3090', /端口被占用/],
  ['getaddrinfo ENOTFOUND api.example.invalid', /域名解析失败/],
  ['connect ECONNREFUSED 127.0.0.1:7890', /连接被拒绝.*127\.0\.0\.1:7890/s],
  ['read ECONNRESET', /连接被中途断开/],
  ['socket hang up', /连接被中途断开/],
  ['connect ETIMEDOUT 104.18.0.1:443', /超时/],
  ['Request timed out.', /超时/],
  ['self-signed certificate in certificate chain', /HTTPS 证书校验失败/],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /HTTPS 证书校验失败/],
  ['TypeError: fetch failed', /请求没发出去/],
  ['403 {"error":{"type":"forbidden","message":"Access from this region requires trusted account access"}}', /地区限制/],
  ['unsupported_country_region_territory', /地区限制/],
  ['402 {"error":{"message":"Insufficient balance"}}', /余额或额度不足/],
  ['API Error: 403 {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}', /余额或额度不足/], // a word in between, and a 403
  ['API Error: 403 status code (no body)', /没有权限访问/],
  ['You exceeded your current quota, please check your plan and billing details.', /余额或额度不足/],
  ['prompt is too long: 215000 tokens > 200000 maximum', /对话太长/],
  ["This model's maximum context length is 128000 tokens.", /对话太长/],
  ['404 {"error":{"code":"model_not_found","message":"The model `gpt-9` does not exist"}}', /模型不存在/],
  ['API Error: 401 {"error":{"message":"Invalid API key"}}', /API Key 不对或已经失效/],
  ['Incorrect API key provided: sk-…', /API Key 不对或已经失效/],
  ['HTTP 403 Forbidden', /没有权限访问/],
  ['HTTP 404 Not Found', /地址不对：接口不存在/],
  ['API Error: 429 Too Many Requests', /被限流/],
  ['rate_limit_error', /被限流/],
  ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', /对方服务出错或过载/],
  ['502 Bad Gateway', /对方服务出错或过载/],
  ['Unexpected token < in JSON at position 0', /不是接口数据/],
];

describe('explainError', () => {
  it.each(SEEN)('%s', (raw, want) => {
    expect(explainError(raw)).toMatch(want);
  });

  it('does not guess: unknown text, our own Chinese messages and numbers that are not statuses stay unexplained', () => {
    for (const raw of [
      '',
      '这个对话正在处理中',
      'something odd happened',
      "ENOENTX is a variable name", // not the code
      'C:\\work\\404-page\\index.ts was edited', // a path with 404 in it
      'line 429 of parser.ts', // a line number
      'region-picker component', // a word, not a restriction
    ]) expect(explainError(raw), raw).toBeNull();
  });
});

describe('withExplanation', () => {
  it('puts the explanation on top and keeps the original exactly, once', () => {
    const raw = 'connect ECONNREFUSED 127.0.0.1:7890';
    const told = withExplanation(raw);
    expect(told.split('\n')).toEqual([explainError(raw), `原文：${raw}`]);
    expect(withExplanation(told)).toBe(told); // explaining twice keeps one explanation (server, then the window)
  });

  it('leaves what it does not know as it is', () => {
    expect(withExplanation('停止失败：没有这个对话')).toBe('停止失败：没有这个对话');
  });

  it('a toast that already has a Chinese prefix keeps it in the original line', () => {
    expect(withExplanation('停止失败：read ECONNRESET')).toBe(`${explainError('read ECONNRESET')}\n原文：停止失败：read ECONNRESET`);
  });
});
