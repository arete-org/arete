/**
 * @description: Centralizes backend runtime configuration defaults and env parsing.
 * @arete-scope: utility
 * @arete-module: BackendRuntimeConfig
 * @arete-risk: moderate - Misconfiguration can break API behavior or security controls.
 * @arete-ethics: moderate - Incorrect defaults can weaken abuse protections.
 */
type RuntimeConfig = {
  openai: {
    defaultModel: string;
    defaultReasoningEffort: string;
    defaultVerbosity: string;
    defaultChannelContext: { channelId: string };
  };
  cors: {
    allowedOrigins: string[];
  };
  csp: {
    frameAncestors: string[];
  };
};

// --- Helpers ---
const parseCsvEnv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value) {
    return [...fallback];
  }

  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  return entries.length > 0 ? entries : [...fallback];
};

// --- Defaults ---
const defaultAllowedOrigins = [
  'http://localhost:8080',
  'http://localhost:3000'
];
const defaultFrameAncestors = [
  "'self'",
  'https://arete-web.fly.dev',
  'https://ai.jordanmakes.dev',
  'https://jordanmakes.fly.dev',
  ...defaultAllowedOrigins
];

// --- Environment parsing ---
const allowedOrigins = parseCsvEnv(process.env.ARETE_ALLOWED_ORIGINS, defaultAllowedOrigins);
const frameAncestors = parseCsvEnv(process.env.ARETE_FRAME_ANCESTORS, defaultFrameAncestors);

// --- Runtime config ---
const runtimeConfig: RuntimeConfig = {
  openai: {
    defaultModel: process.env.ARETE_DEFAULT_MODEL || 'gpt-5-mini',
    defaultReasoningEffort: process.env.ARETE_DEFAULT_REASONING_EFFORT || 'low',
    defaultVerbosity: process.env.ARETE_DEFAULT_VERBOSITY || 'low',
    defaultChannelContext: {
      channelId: 'default'
    }
  },
  cors: {
    allowedOrigins
  },
  csp: {
    frameAncestors
  }
};

export { runtimeConfig };


