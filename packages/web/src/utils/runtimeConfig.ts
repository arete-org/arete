/**
 * @description: Loads runtime configuration for the web app from the backend.
 * @arete-scope: utility
 * @arete-module: RuntimeConfigLoader
 * @arete-risk: low - Config fetch failures only disable optional client features.
 * @arete-ethics: low - Exposes only non-sensitive configuration to the client.
 */
export interface RuntimeConfig {
  turnstileSiteKey: string;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  turnstileSiteKey: ''
};

let cachedConfig: RuntimeConfig | null = null;
let inFlightConfig: Promise<RuntimeConfig> | null = null;

const normalizeConfig = (payload: unknown): RuntimeConfig => {
  if (!payload || typeof payload !== 'object') {
    return DEFAULT_CONFIG;
  }

  const raw = payload as { turnstileSiteKey?: unknown };
  return {
    turnstileSiteKey: typeof raw.turnstileSiteKey === 'string' ? raw.turnstileSiteKey : ''
  };
};

export const loadRuntimeConfig = async (): Promise<RuntimeConfig> => {
  if (cachedConfig) {
    return cachedConfig;
  }

  if (!inFlightConfig) {
    inFlightConfig = fetch('/config.json', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Runtime config fetch failed: ${response.status}`);
        }
        return normalizeConfig(await response.json());
      })
      .catch(() => DEFAULT_CONFIG)
      .then((config) => {
        cachedConfig = config;
        return config;
      });
  }

  return inFlightConfig;
};
