// The built-in provider descriptors (P2). Data only: ids, names, how to sign in, where the docs are, whether a free
// tier exists, and where model ids come from. Credentials never live here — the wizard's result is an account row in
// upstreams/ (logins) or a provider profile in providers/ (keys), exactly like the existing catalog entries.
import { tr } from '../../i18n/index.js';
import type { ProviderDescriptor } from './types.js';

const browser = (provider: string) => tr('在浏览器里登录 {provider}，授权后自动回来。', { provider });
const device = (provider: string) => tr('在 {provider} 页面输入一次性代码完成登录。', { provider });
const keyHint = (provider: string) => tr('粘贴 {provider} 的 API Key。', { provider });

/** An API-key preset: a base URL + a key, and the vendor's own /models list. */
function apiKey(
  id: string,
  name: string,
  docsUrl: string,
  free: boolean | 'some',
  vendor = name,
): ProviderDescriptor {
  return { id, name, kind: 'api-key', auth: 'api-key', loginHint: keyHint(vendor), docsUrl, free, modelSource: 'live' };
}

const subscription = (d: Omit<ProviderDescriptor, 'kind' | 'modelSource'>): ProviderDescriptor => ({ ...d, kind: 'subscription', modelSource: 'account' });

const builtins: ProviderDescriptor[] = [
  // ---- subscription sign-ins (the wizard's first tab) ----
  subscription({ id: 'codex', name: 'Codex', auth: 'oauth-loopback', loginHint: browser('ChatGPT'), docsUrl: 'https://developers.openai.com/codex/', free: true }),
  subscription({ id: 'gemini', name: 'Gemini', auth: 'oauth-loopback', loginHint: browser('Google'), docsUrl: 'https://github.com/google-gemini/gemini-cli', free: true }),
  subscription({
    id: 'antigravity', name: 'Antigravity', auth: 'oauth-loopback',
    loginHint: tr('用 Google 账号登录 Antigravity；Google 可能限制账号在 Antigravity 之外使用。'),
    docsUrl: 'https://antigravity.google/', free: true,
  }),
  subscription({ id: 'kimi', name: 'Kimi', auth: 'oauth-loopback', loginHint: tr('用 Kimi 账号登录，或改用 Kimi API Key。'), docsUrl: 'https://platform.moonshot.cn/', free: 'some' }),
  subscription({ id: 'grok', name: 'Grok', auth: 'paste-token', loginHint: tr('粘贴 grok.com 的 sso cookie。'), docsUrl: 'https://grok.com/', free: 'some' }),
  subscription({ id: 'devin', name: 'Devin', auth: 'paste-token', loginHint: tr('在 Devin 里连接账号后，把浏览器里的会话令牌粘贴到这里。'), docsUrl: 'https://devin.ai/', free: false }),
  subscription({ id: 'copilot', name: 'GitHub Copilot', auth: 'device-code', loginHint: device('GitHub'), docsUrl: 'https://github.com/features/copilot', free: true }),
  subscription({ id: 'kiro', name: 'Kiro', auth: 'device-code', loginHint: device('AWS'), docsUrl: 'https://kiro.dev/', free: true }),
  subscription({ id: 'cline', name: 'Cline', auth: 'oauth-loopback', loginHint: browser('Cline'), docsUrl: 'https://cline.bot/', free: 'some' }),
  subscription({ id: 'qoder', name: 'Qoder', auth: 'device-code', loginHint: tr('用 Qoder 账号登录；每天签到领额度。'), docsUrl: 'https://qoder.com/', free: true }),
  subscription({ id: 'trae', name: 'Trae', auth: 'local-credential', loginHint: tr('读取已安装 Trae 的登录态；每天签到领额度。'), docsUrl: 'https://www.trae.ai/', free: true }),
  subscription({ id: 'workbuddy', name: 'WorkBuddy', auth: 'paste-token', loginHint: tr('粘贴 WorkBuddy 的登录凭据；每天签到领额度。'), docsUrl: 'https://www.workbuddy.ai/', free: true }),
  subscription({ id: 'zcode', name: 'ZCode', auth: 'device-code', loginHint: device('Z.ai'), docsUrl: 'https://zcode.z.ai/', free: 'some' }),
  subscription({ id: 'factory', name: 'Factory', auth: 'local-credential', loginHint: tr('读取本机已登录的 Factory / Droid 凭据。'), docsUrl: 'https://factory.ai/', free: 'some' }),
  // Keyless gateway: no account and no key, but it belongs with the widgets people add first.
  { id: 'kilo', name: 'Kilo', kind: 'api-key', auth: 'none', loginHint: tr('不需要账号或密钥，直接使用免费模型。'), docsUrl: 'https://kilocode.ai/', free: true, modelSource: 'live' },
  subscription({ id: 'mimo', name: 'Xiaomi MiMo', auth: 'paste-token', loginHint: tr('粘贴小米 MiMo Token Plan 的令牌。'), docsUrl: 'https://platform.xiaomimimo.com/', free: 'some' }),
  subscription({ id: 'opencode', name: 'OpenCode', auth: 'local-credential', loginHint: tr('从 OpenCode 的 auth.json 读取登录态。'), docsUrl: 'https://opencode.ai/', free: 'some' }),

  // ---- API-key presets (the second tab) ----
  apiKey('anthropic', 'Anthropic API', 'https://docs.anthropic.com/en/api/getting-started', false, 'Anthropic'),
  apiKey('openai', 'OpenAI API', 'https://platform.openai.com/api-keys', false, 'OpenAI'),
  apiKey('google', 'Google Gemini API', 'https://aistudio.google.com/apikey', 'some', 'Google Gemini'),
  apiKey('deepseek', 'DeepSeek', 'https://platform.deepseek.com/api_keys', false),
  apiKey('xai', 'xAI API', 'https://console.x.ai/', false, 'xAI'),
  apiKey('kimi-api', 'Kimi API', 'https://platform.moonshot.cn/console/api-keys', false, 'Kimi'),
  apiKey('zhipu', 'Zhipu GLM', 'https://open.bigmodel.cn/usercenter/apikeys', false),
  apiKey('zai', 'Z.ai', 'https://z.ai/', false),
  apiKey('minimax', 'MiniMax', 'https://platform.minimaxi.com/', false),
  apiKey('stepfun', 'StepFun', 'https://platform.stepfun.com/', false),
  apiKey('qwen', 'Alibaba Qwen', 'https://bailian.console.aliyun.com/', 'some', 'Alibaba Qwen'),
  apiKey('openrouter', 'OpenRouter', 'https://openrouter.ai/keys', 'some'),
  apiKey('groq', 'Groq', 'https://console.groq.com/keys', true),
  apiKey('mistral', 'Mistral', 'https://console.mistral.ai/', 'some'),
  apiKey('together', 'Together AI', 'https://api.together.ai/', false),
  apiKey('fireworks', 'Fireworks', 'https://fireworks.ai/', false),
  apiKey('siliconflow', 'SiliconFlow', 'https://cloud.siliconflow.cn/account/ak', 'some'),
  apiKey('nvidia', 'NVIDIA NIM', 'https://build.nvidia.com/', true),
  apiKey('modelscope', 'ModelScope', 'https://modelscope.cn/', true),
  apiKey('cerebras', 'Cerebras', 'https://cloud.cerebras.ai/', true),

  // ---- local programs (the third tab) ----
  { id: 'local', name: tr('本机模型'), kind: 'local', auth: 'none', loginHint: tr('填本机服务的地址，不需要密钥。'), docsUrl: 'https://ollama.com/', free: true, modelSource: 'local' },
  { id: 'ollama', name: 'Ollama', kind: 'local', auth: 'none', loginHint: tr('连接本机的 Ollama，不需要密钥。'), docsUrl: 'https://ollama.com/', free: true, modelSource: 'local' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', auth: 'none', loginHint: tr('连接本机的 LM Studio，不需要密钥。'), docsUrl: 'https://lmstudio.ai/', free: true, modelSource: 'local' },

  // ---- custom endpoint (the fourth tab) ----
  { id: 'custom', name: tr('自定义端点'), kind: 'custom', auth: 'api-key', loginHint: tr('填兼容 OpenAI 或 Anthropic 的地址和密钥。'), docsUrl: 'https://platform.openai.com/docs/api-reference', free: false, modelSource: 'live' },

  // ---- gateways: another machine's Magpie, or a CLIProxyAPI endpoint ----
  { id: 'remote-magpie', name: tr('远程 Magpie'), kind: 'remote', auth: 'api-key', loginHint: tr('填另一台 Magpie 的地址和网关密钥。'), docsUrl: 'https://usemagpie.ai/', free: false, modelSource: 'upstream' },
  { id: 'cpa', name: 'CLIProxyAPI', kind: 'custom', auth: 'api-key', loginHint: tr('填本机或另一台 CLIProxyAPI 的地址和访问密钥。'), docsUrl: 'https://github.com/router-for-me/CLIProxyAPI', free: false, modelSource: 'upstream' },
];

export const PROVIDERS: readonly ProviderDescriptor[] = Object.freeze(builtins.map((provider) => Object.freeze(provider)));

/** Alias used by callers that prefer the explicit name. */
export const BUILTIN_PROVIDERS = PROVIDERS;
