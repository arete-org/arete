/**
 * @description: Loads backend environment variables from the repo .env file before config-dependent modules initialize.
 * @footnote-scope: utility
 * @footnote-module: BackendEnvBootstrap
 * @footnote-risk: medium - Late env loading can leave the backend running with incorrect security or model defaults.
 * @footnote-ethics: medium - Incorrect startup configuration can weaken transparency and abuse-prevention safeguards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoEnvPath = path.join(currentDirectory, '../../../.env');

if (fs.existsSync(repoEnvPath)) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: repoEnvPath });
}

