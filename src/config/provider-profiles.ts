/**
 * Provider profiles for the Claude Code adapter: vendors offering official
 * Anthropic-compatible `/v1/messages` endpoints (verified 2026-09). Selecting
 * a provider makes the adapter inject the vendor's base URL + key env into
 * the spawned `claude` process, so one adapter covers every vendor.
 *
 * Unset / `anthropic` = no injection — claude uses the user's own login.
 *
 * Model ids and endpoints move; `agent.model` always wins over the
 * suggestions here, and the suggestions are defaults, not gospel.
 */
export interface ProviderProfile {
  id: string;
  displayName: string;
  /** Anthropic-compatible base URL (国内端点优先). */
  baseUrl: string;
  /** Env var this provider expects the API key in. */
  tokenEnvVar: string;
  /** Where to obtain the API key (shown in /config). */
  keyHint: string;
  /** Default model suggestions; `agent.model` overrides. */
  suggestedModels: string[];
  /** Model mapped to the haiku/small-fast tier when `agent.model` is set. */
  haikuModel?: string;
  /** Static extra env injected verbatim. */
  extraEnv?: Record<string, string>;
  /** Known quirk worth surfacing to the user. */
  note?: string;
}

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'platform.deepseek.com/api_keys',
    suggestedModels: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
    haikuModel: 'deepseek-v4-flash',
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
    note: 'prompt cache (cache_control) 不生效，长会话成本偏高；MCP 需走本地 stdio',
  },
  zhipu: {
    id: 'zhipu',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'bigmodel.cn 控制台（Coding Plan 或按量 Key）',
    suggestedModels: ['glm-5.3[1m]', 'glm-5.3-flash[1m]'],
    haikuModel: 'glm-5.3-flash[1m]',
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    note: 'Coding Plan 额度只在官方支持的工具内生效',
  },
  moonshot: {
    id: 'moonshot',
    displayName: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'platform.kimi.com 控制台（按量 Key）',
    suggestedModels: ['kimi-k3[1m]', 'kimi-k2.7-code'],
    haikuModel: 'kimi-k2.7-code',
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    note: 'Kimi Code 订阅版走 api.kimi.com/coding/ 且 Key 变量是 ANTHROPIC_API_KEY，与按量 Key 不通用',
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen 百炼',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'bailian.console.aliyun.com（Model Studio）',
    suggestedModels: ['qwen3-coder-plus'],
    note: '模型 id 以百炼控制台为准；国际站基址为 coding-intl.dashscope.aliyuncs.com',
  },
  volc: {
    id: 'volc',
    displayName: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'console.volcengine.com/ark（API Key 管理）',
    suggestedModels: ['doubao-seed-2-1-pro-260628'],
    note: '按量端点为 /api/compatible；Coding Plan 订阅改用 /api/coding；模型 id 带日期，以控制台为准',
  },
  minimax: {
    id: 'minimax',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/anthropic',
    tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    keyHint: 'platform.minimaxi.com 控制台（注意订阅 Key 与按量 Key 不通用）',
    suggestedModels: ['MiniMax-M3[1m]'],
    haikuModel: 'MiniMax-M3[1m]',
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    note: '国内端点 api.minimax.cn；国际站为 api.minimax.io',
  },
};

export function getProviderProfile(id: string | undefined): ProviderProfile | undefined {
  if (!id || id === 'anthropic') return undefined;
  return PROVIDER_PROFILES[id];
}

/** Keystore id for a provider API key. */
export function secretKeyForProvider(providerId: string): string {
  return `provider-${providerId}`;
}
