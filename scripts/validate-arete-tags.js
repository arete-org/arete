#!/usr/bin/env node

/**
 * Validates ARETE module annotations across the repository.
 * Checks for required tags and enforces canonical risk and ethics levels.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_TAGS = ['@arete-module', '@arete-risk', '@arete-ethics', '@arete-scope'];
const ALLOWED_LEVELS = new Set(['critical', 'high', 'moderate', 'low']);
const ALLOWED_SCOPES = new Set(['core', 'utility', 'interface', 'test']);
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp'
]);

const repoRoot = path.resolve(__dirname, '..');
let hasErrors = false;
let filesValidated = 0;

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name), onFile);
    } else if (entry.isFile()) {
      onFile(path.join(dir, entry.name));
    }
  }
}

function logError(filePath, message) {
  hasErrors = true;
  console.error(`ARETE tag error in ${filePath}: ${message}`);
}

function extractTagValue(block, tag) {
  const tagPattern = new RegExp(`${tag}:\\s*([^\\r\\n*]+)`);
  const match = block.match(tagPattern);
  return match ? match[1].trim() : null;
}

function validateFile(filePath) {
  if (!filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes('@arete-module')) {
    return;
  }

  const relativePath = path.relative(repoRoot, filePath);
  const blocks = content.match(/\/\*\*[\s\S]*?\*\//g);
  const headerBlock = blocks ? blocks.find((block) => block.includes('@arete-module')) : null;

  if (!headerBlock) {
    logError(relativePath, 'Found @arete-module reference but could not parse the JSDoc block.');
    return;
  }

  filesValidated += 1;

  const values = {};
  for (const tag of REQUIRED_TAGS) {
    const value = extractTagValue(headerBlock, tag);
    if (!value) {
      logError(relativePath, `Missing required ${tag} tag or value.`);
      continue;
    }
    values[tag] = value;
  }

  const riskLevel = values['@arete-risk'];
  if (riskLevel && !ALLOWED_LEVELS.has(riskLevel)) {
    logError(
      relativePath,
      `Invalid @arete-risk level "${riskLevel}". Expected one of: ${Array.from(ALLOWED_LEVELS).join(', ')}.`
    );
  }

  const ethicsLevel = values['@arete-ethics'];
  if (ethicsLevel && !ALLOWED_LEVELS.has(ethicsLevel)) {
    logError(
      relativePath,
      `Invalid @arete-ethics level "${ethicsLevel}". Expected one of: ${Array.from(ALLOWED_LEVELS).join(', ')}.`
    );
  }

  const scope = values['@arete-scope'];
  if (scope && !ALLOWED_SCOPES.has(scope)) {
    logError(
      relativePath,
      `Invalid @arete-scope value "${scope}". Expected one of: ${Array.from(ALLOWED_SCOPES).join(', ')}.`
    );
  }
}

walk(repoRoot, validateFile);

if (filesValidated > 0) {
  console.log(`Validated ${filesValidated} ARETE-tagged module${filesValidated === 1 ? '' : 's'}.`);
} else {
  console.log('No ARETE-tagged modules found to validate.');
}

if (hasErrors) {
  console.error('ARETE tag validation failed.');
  process.exit(1);
}

process.exit(0);

