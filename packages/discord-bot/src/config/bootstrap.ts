/**
 * @description: Loads Discord bot environment variables during startup without depending on runtime config.
 * @footnote-scope: utility
 * @footnote-module: ConfigBootstrap
 * @footnote-risk: medium - Loading the wrong env file can hide local setup mistakes.
 * @footnote-ethics: low - This only affects startup wiring, not user-facing behavior directly.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bootstrapLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resolveEnvPath = (): string | null => {
    const candidatePaths = [
        path.resolve(__dirname, '../../../../.env'),
        path.resolve(__dirname, '../../../../../.env'),
    ];

    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    return null;
};

const envPath = resolveEnvPath();

// Load the repo-level .env file when it is present. Production deploys usually
// inject environment variables instead, so missing this file is expected there.
if (envPath) {
    bootstrapLogger.debug(`Loading environment variables from: ${envPath}`);
    const { error, parsed } = dotenv.config({ path: envPath });

    if (error) {
        bootstrapLogger.warn(`Failed to load .env file: ${error.message}`);
    } else if (parsed) {
        bootstrapLogger.debug(
            `Loaded environment variables: ${Object.keys(parsed).join(', ')}`
        );
    }
} else {
    bootstrapLogger.debug(
        'No repo-level .env file found in the source or dist locations; relying on injected environment variables.'
    );
}
