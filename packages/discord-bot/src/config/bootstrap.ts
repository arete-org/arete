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
const envPath = path.resolve(__dirname, '../../../../.env');

bootstrapLogger.debug(`Loading environment variables from: ${envPath}`);

// Load the repo-level .env file when it is present. Production deploys usually
// inject environment variables instead, so missing this file is expected there.
if (fs.existsSync(envPath)) {
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
        'No .env file found; relying on injected environment variables.'
    );
}
