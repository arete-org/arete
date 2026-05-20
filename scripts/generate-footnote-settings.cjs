#!/usr/bin/env node
/* eslint-env node */
/* global __dirname, process, console */

/**
 * @description: Generates deterministic canonical footnote.yaml defaults for server runtime settings.
 * @footnote-scope: utility
 * @footnote-module: GenerateFootnoteSettings
 * @footnote-risk: medium - Wrong defaults here can mislead first-run setup behavior.
 * @footnote-ethics: low - Developer/operator bootstrap helper only.
 */

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const defaultOutputPath = path.join(repoRoot, 'footnote.yaml');
const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';

const templateLines = [
    '# Footnote canonical settings',
    '#',
    '# Rule of thumb:',
    '# - normal runtime settings live in this file',
    '# - secrets stay in environment variables / Fly secrets',
    '# - for discord-bots credentials, put env var NAMES here, never secret values',
    '',
    'version: 1',
    '',
    '# Backend HTTP runtime',
    'server:',
    '  host: "::"',
    '  port: 3000',
    '  trust-proxy: false',
    '  data-dir: "/data"',
    '',
    '# Browser-facing policy defaults',
    'web:',
    '  allowed-origins:',
    '    - "http://localhost:8080"',
    '    - "http://localhost:3000"',
    '  frame-ancestors:',
    '    - "\'self\'"',
    '    - "http://localhost:8080"',
    '    - "http://localhost:3000"',
    '',
    '# Discord bots supervised by the server process.',
    '# Most users can keep this empty at first.',
    'discord-bots: []',
    '',
    '# Example (uncomment and fill env key names only):',
    '# discord-bots:',
    '#   - id: "main-discord"',
    '#     enabled: true',
    '#     required: false',
    '#     credentials:',
    '#       discord-token-env: "DISCORD_TOKEN"',
    '#       discord-client-id-env: "DISCORD_CLIENT_ID"',
    '#       discord-guild-ids-env: "DISCORD_GUILD_IDS"',
    '#       discord-user-id-env: "DISCORD_USER_ID"',
    '#       incident-secret-env: "INCIDENT_PSEUDONYMIZATION_SECRET"',
    '#     profile:',
    '#       id: "default"',
    '#       display-name: "Footnote"',
    '#       overlay-path: ""',
    '#       mention-aliases: []',
];

const renderTemplate = () => `${templateLines.join(lineEnding)}${lineEnding}`;

const parseArgs = () => {
    const args = process.argv.slice(2);
    let outputPath = defaultOutputPath;
    let ifMissing = false;

    for (let index = 0; index < args.length; index += 1) {
        const current = args[index];
        if (current === '--output') {
            const next = args[index + 1];
            if (!next || next.startsWith('--')) {
                throw new Error('Missing value for --output');
            }
            outputPath = path.resolve(process.cwd(), next);
            index += 1;
            continue;
        }
        if (current === '--if-missing') {
            ifMissing = true;
            continue;
        }
    }

    return { outputPath, ifMissing };
};

const main = () => {
    const { outputPath, ifMissing } = parseArgs();
    if (ifMissing && fs.existsSync(outputPath)) {
        console.log(
            `[settings:init] Found existing ${outputPath}; leaving as-is.`
        );
        return;
    }

    const parentDir = path.dirname(outputPath);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(outputPath, renderTemplate(), 'utf8');
    console.log(`[settings:init] Wrote ${outputPath}`);
};

main();
