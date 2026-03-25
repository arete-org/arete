/**
 * @description: Builds backend VoltAgent observability config from environment variables.
 * @footnote-scope: utility
 * @footnote-module: BackendVoltAgentSection
 * @footnote-risk: low - Incorrect parsing here only affects optional VoltOps tracing enablement.
 * @footnote-ethics: medium - Observability configuration impacts operator visibility into model behavior.
 */

import { parseOptionalTrimmedString } from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

/**
 * Builds VoltAgent observability configuration. Tracing is enabled only when
 * both keys are present so partial configuration does not fail runtime setup.
 */
export const buildVoltAgentSection = (
    env: NodeJS.ProcessEnv,
    warn: WarningSink
): RuntimeConfig['voltagent'] => {
    const publicKey = parseOptionalTrimmedString(env.VOLTAGENT_PUBLIC_KEY);
    const secretKey = parseOptionalTrimmedString(env.VOLTAGENT_SECRET_KEY);
    const hasPublicKey = publicKey !== null;
    const hasSecretKey = secretKey !== null;

    if (hasPublicKey !== hasSecretKey) {
        warn(
            'VoltOps tracing remains disabled because VOLTAGENT_PUBLIC_KEY and VOLTAGENT_SECRET_KEY must both be set.'
        );
    }

    return {
        publicKey,
        secretKey,
        observabilityEnabled: hasPublicKey && hasSecretKey,
    };
};
