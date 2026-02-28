/**
 * @description: Loads backend environment variables from the repo .env file before config-dependent modules initialize.
 * @arete-scope: utility
 * @arete-module: BackendEnvBootstrap
 * @arete-risk: moderate - Late env loading can leave the backend running with incorrect security or model defaults.
 * @arete-ethics: moderate - Incorrect startup configuration can weaken transparency and abuse-prevention safeguards.
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
