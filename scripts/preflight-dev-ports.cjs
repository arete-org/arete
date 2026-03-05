#!/usr/bin/env node

/**
 * @description: Preflight cleanup for local startup that frees stale Footnote node listeners on configured dev ports.
 * @footnote-scope: utility
 * @footnote-module: DevPortPreflight
 * @footnote-risk: medium - Overly broad matching could terminate unrelated local development tasks.
 * @footnote-ethics: low - Process cleanup only; no user data handling.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

/**
 * Parse an env-like value into a valid TCP port.
 */
const parsePort = (value) => {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        return undefined;
    }
    return parsed;
};

/**
 * Extract an explicit port from a URL string (for example WEB_BASE_URL).
 */
const portFromUrl = (value) => {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (!url.port) {
            return undefined;
        }
        return parsePort(url.port);
    } catch {
        return undefined;
    }
};

// Canonical dev ports from .env with local defaults.
const backendPort = parsePort(process.env.PORT) ?? 3000;
const webhookPort = parsePort(process.env.WEBHOOK_PORT) ?? 3001;
const webPort = portFromUrl(process.env.WEB_BASE_URL) ?? 8080;

// Scope allows per-service preflight in start:backend/start:web/start:bot.
// Supported: all, backend, web, bot.
const scope = (process.argv[2] || 'all').toLowerCase();

/**
 * Resolve which ports to check for the requested startup scope.
 */
const getPortsForScope = (value) => {
    if (value === 'all') {
        return [backendPort, webhookPort, webPort];
    }
    if (value === 'backend') {
        return [backendPort];
    }
    if (value === 'web') {
        return [webPort];
    }
    if (value === 'bot') {
        return [webhookPort];
    }
    return null;
};

const portsForScope = getPortsForScope(scope);
if (!portsForScope) {
    console.error(
        `[preflight] Unknown scope "${scope}". Expected one of: all, backend, web, bot.`
    );
    process.exit(1);
}

const uniquePorts = [...new Set(portsForScope)].sort((a, b) => a - b);

const run = (command, args) =>
    spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

/**
 * Parse Windows netstat output and return PIDs listening on a specific port.
 */
const findListeningPidsWindows = (port) => {
    const result = run('netstat', ['-ano', '-p', 'tcp']);
    if (result.status !== 0) {
        return [];
    }

    const lines = result.stdout.split(/\r?\n/);
    const found = new Set();
    for (const line of lines) {
        if (!line.includes('LISTENING')) {
            continue;
        }

        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) {
            continue;
        }

        const localAddress = cols[1] ?? '';
        if (!localAddress.endsWith(`:${port}`)) {
            continue;
        }

        const pid = Number(cols[4]);
        if (Number.isInteger(pid) && pid > 0) {
            found.add(pid);
        }
    }

    return [...found];
};

/**
 * Query process name + command line on Windows for safety filtering.
 */
const getProcessInfoWindows = (pid) => {
    const result = run('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
    ]);
    if (result.status !== 0 || !result.stdout.trim()) {
        return null;
    }
    try {
        return JSON.parse(result.stdout.trim());
    } catch {
        return null;
    }
};

/**
 * Enumerate node processes on Windows so we can find stale bot workers that do
 * not necessarily hold a local TCP port.
 */
const listNodeProcessesWindows = () => {
    const result = run('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
    ]);
    if (result.status !== 0 || !result.stdout.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(result.stdout.trim());
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return [];
    }
};

/**
 * Query listening PIDs on Unix-like systems with lsof.
 */
const findListeningPidsUnix = (port) => {
    const result = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    if (result.status !== 0) {
        return [];
    }

    return result.stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
};

/**
 * Query process name + command line on Unix-like systems for safety filtering.
 */
const getProcessInfoUnix = (pid) => {
    const result = run('ps', ['-p', String(pid), '-o', 'comm=', '-o', 'args=']);
    if (result.status !== 0 || !result.stdout.trim()) {
        return null;
    }

    const line = result.stdout.trim();
    const firstSpace = line.indexOf(' ');
    if (firstSpace === -1) {
        return { name: line, commandLine: line };
    }
    return {
        name: line.slice(0, firstSpace),
        commandLine: line.slice(firstSpace + 1),
    };
};

/**
 * Enumerate node processes on Unix-like systems.
 */
const listNodeProcessesUnix = () => {
    const result = run('ps', ['-eo', 'pid=', '-o', 'comm=', '-o', 'args=']);
    if (result.status !== 0 || !result.stdout.trim()) {
        return [];
    }

    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const processes = [];
    for (const line of lines) {
        const trimmed = line.trim();
        const firstSplit = trimmed.search(/\s+/);
        if (firstSplit < 0) {
            continue;
        }
        const pidText = trimmed.slice(0, firstSplit).trim();
        const rest = trimmed.slice(firstSplit).trim();
        const secondSplit = rest.search(/\s+/);
        if (secondSplit < 0) {
            continue;
        }
        const name = rest.slice(0, secondSplit).trim();
        const commandLine = rest.slice(secondSplit).trim();
        const pid = Number(pidText);
        if (!Number.isInteger(pid) || pid <= 0) {
            continue;
        }
        processes.push({ ProcessId: pid, Name: name, CommandLine: commandLine });
    }

    return processes.filter((proc) =>
        String(proc.Name || '')
            .toLowerCase()
            .includes('node')
    );
};

const isWindows = process.platform === 'win32';
const repoPathLower = repoRoot.toLowerCase();

// Platform adapter keeps the main flow linear and easy to scan.
const platform = isWindows
    ? {
          listListeningPids: findListeningPidsWindows,
          getProcessInfo: getProcessInfoWindows,
          listNodeProcesses: listNodeProcessesWindows,
          kill: (pid) =>
              run('taskkill', ['/PID', String(pid), '/T', '/F']).status === 0,
      }
    : {
          listListeningPids: findListeningPidsUnix,
          getProcessInfo: getProcessInfoUnix,
          listNodeProcesses: listNodeProcessesUnix,
          kill: (pid) => {
              try {
                  process.kill(pid, 'SIGTERM');
                  return true;
              } catch {
                  return false;
              }
          },
      };

/**
 * Only allow termination when the process is clearly a Footnote node process.
 */
const shouldKillProcess = (info) => {
    if (!info || typeof info !== 'object') {
        return false;
    }

    const name = isWindows
        ? String(info.Name || '').toLowerCase()
        : String(info.name || '').toLowerCase();
    const commandLine = isWindows
        ? String(info.CommandLine || '').toLowerCase()
        : String(info.commandLine || '').toLowerCase();

    const isNode = name === 'node.exe' || name === 'node' || name.includes('node');
    return isNode && commandLine.includes(repoPathLower);
};

/**
 * Detect stale bot-related node processes that may still be connected to
 * Discord even when they are not holding a local TCP port.
 */
const listStaleBotPids = () => {
    if (scope !== 'bot' && scope !== 'all') {
        return [];
    }

    const matchesBotProcess = (commandLine) => {
        const value = String(commandLine || '').toLowerCase();
        return (
            value.includes(repoPathLower) &&
            (value.includes('packages\\discord-bot') ||
                value.includes('packages/discord-bot') ||
                value.includes('@footnote/discord-bot'))
        );
    };

    const processes = platform.listNodeProcesses();
    return processes
        .map((proc) => {
            const pid = Number(proc.ProcessId);
            return {
                pid,
                commandLine: String(proc.CommandLine || ''),
            };
        })
        .filter(
            (proc) =>
                Number.isInteger(proc.pid) &&
                proc.pid > 0 &&
                proc.pid !== process.pid &&
                matchesBotProcess(proc.commandLine)
        )
        .map((proc) => proc.pid);
};

// Step 1: collect listeners on target ports.
const pidsByPort = new Map();
for (const port of uniquePorts) {
    const pids = platform.listListeningPids(port);
    pidsByPort.set(port, pids);
}

// Step 2: dedupe PIDs so we handle each process once.
const staleBotPids = listStaleBotPids();
const staleBotPidSet = new Set(staleBotPids);
const allPids = [...new Set([...pidsByPort.values()].flat().concat(staleBotPids))];
if (allPids.length === 0) {
    console.log(
        `[preflight] No listeners found on ${scope} port(s): ${uniquePorts.join(', ')}`
    );
    process.exit(0);
}

// Step 3: stop only safe matches and report every decision.
let killed = 0;
let skipped = 0;
for (const pid of allPids) {
    const info = platform.getProcessInfo(pid);
    const isKnownStaleBotPid = staleBotPidSet.has(pid);

    if (!isKnownStaleBotPid && !shouldKillProcess(info)) {
        skipped += 1;
        const name = isWindows
            ? info?.Name || 'unknown'
            : info?.name || 'unknown';
        console.log(
            `[preflight] Skipping PID ${pid} (${name}); not a Footnote node dev process.`
        );
        continue;
    }

    if (platform.kill(pid)) {
        killed += 1;
        if (isKnownStaleBotPid) {
            console.log(`[preflight] Stopped stale bot process PID ${pid}.`);
        } else {
            console.log(`[preflight] Stopped stale process PID ${pid}.`);
        }
    } else {
        skipped += 1;
        console.warn(`[preflight] Failed to stop PID ${pid}.`);
    }
}

console.log(
    `[preflight] Checked ${scope} scope. Ports: ${uniquePorts.join(', ')}. Killed ${killed}, skipped ${skipped}.`
);
