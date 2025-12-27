/**
 * @description: Delegates to the compiled backend server entrypoint.
 * @arete-scope: backend
 * @arete-module: BackendServerShim
 * @arete-risk: medium - Missing build output prevents backend startup.
 * @arete-ethics: low - Shim only impacts availability, not data handling.
 */
const fs = require('node:fs');
const path = require('node:path');

const entryPath = path.join(__dirname, 'packages', 'backend', 'dist', 'server.js');

if (!fs.existsSync(entryPath)) {
  console.error('Backend build output not found. Run: npm run build --workspace=@arete/backend');
  process.exit(1);
}

require(entryPath);
