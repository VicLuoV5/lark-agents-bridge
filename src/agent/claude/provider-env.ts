import { getProviderProfile } from '../../config/provider-profiles';

/**
 * Env for the spawned claude process when a provider profile is active.
 * ANTHROPIC_BASE_URL + the profile's token env are the officially supported
 * gateway overrides; model mapping mirrors vendor docs (all DEFAULT_* tiers
 * point at the chosen model unless the profile names a haiku-class one).
 * Returns {} for the default anthropic login — nothing is injected.
 */
export function applyProviderEnv(
  providerId: string | undefined,
  apiKey: string | undefined,
  model: string | undefined,
): NodeJS.ProcessEnv {
  const profile = getProviderProfile(providerId);
  if (!profile) return {};
  const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: profile.baseUrl };
  if (apiKey) env[profile.tokenEnvVar] = apiKey;
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.haikuModel ?? model;
  }
  if (profile.extraEnv) Object.assign(env, profile.extraEnv);
  return env;
}
