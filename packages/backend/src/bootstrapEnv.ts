/**
 * @description: Loads backend environment variables from the repo .env file before config-dependent modules initialize.
 * @footnote-scope: utility
 * @footnote-module: BackendEnvBootstrap
 * @footnote-risk: medium - Late env loading can leave the backend running with incorrect security or model defaults.
 * @footnote-ethics: medium - Incorrect startup configuration can weaken transparency and abuse-prevention safeguards.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './utils/bootstrapLogger.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoEnvPath = path.join(currentDirectory, '../../../.env');
const incidentSecretKey = 'INCIDENT_PSEUDONYMIZATION_SECRET';

const hasConfiguredIncidentSecret = (): boolean =>
    typeof process.env[incidentSecretKey] === 'string' &&
    process.env[incidentSecretKey]!.trim().length > 0;

const isLocalAutogenerationAllowed = (): boolean => {
    const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
    const isProduction = nodeEnv === 'production';
    const isTest = nodeEnv === 'test';
    const hasFlyAppName =
        typeof process.env.FLY_APP_NAME === 'string' &&
        process.env.FLY_APP_NAME.trim().length > 0;
    return !isProduction && !isTest && !hasFlyAppName;
};

const upsertIncidentSecretInEnvFile = (
    envFilePath: string,
    secret: string
): void => {
    const source = fs.readFileSync(envFilePath, 'utf8');
    const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
    const keyPattern = /^INCIDENT_PSEUDONYMIZATION_SECRET=.*$/m;
    const replacementLine = `${incidentSecretKey}=${secret}`;
    const updated = keyPattern.test(source)
        ? source.replace(keyPattern, replacementLine)
        : `${source}${source.endsWith(lineEnding) ? '' : lineEnding}${replacementLine}${lineEnding}`;

    fs.writeFileSync(envFilePath, updated, 'utf8');
};

/**
 * Fail-open local bootstrap helper.
 *
 * If local secret generation is not applicable (production/test/fly), .env is
 * unavailable, or write permissions fail, this function intentionally avoids
 * throwing. Callers can expect startup to continue with existing env values
 * and warning logs for visibility.
 */
const ensureLocalIncidentSecret = (envFilePath: string): void => {
    if (hasConfiguredIncidentSecret() || !isLocalAutogenerationAllowed()) {
        return;
    }

    if (!fs.existsSync(envFilePath)) {
        return;
    }

    try {
        const generatedSecret = crypto.randomBytes(32).toString('hex');
        upsertIncidentSecretInEnvFile(envFilePath, generatedSecret);
        process.env[incidentSecretKey] = generatedSecret;
        logger.warn(
            `[backendEnvBootstrap] Auto-generated ${incidentSecretKey} in .env for local boot. Rotate this value if it was exposed.`
        );
    } catch (error) {
        logger.warn(
            `[backendEnvBootstrap] Could not auto-generate ${incidentSecretKey}`,
            { error }
        );
    }
};

if (fs.existsSync(repoEnvPath)) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: repoEnvPath });
}

ensureLocalIncidentSecret(repoEnvPath);
