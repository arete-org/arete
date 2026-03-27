#!/usr/bin/env node
/* global fetch, process */

/**
 * @description: Looks up RefactoringGuru examples from GitHub repos for refactor and design decisions.
 * @footnote-scope: utility
 * @footnote-module: RefactorLookupScript
 * @footnote-risk: medium - Bad ranking can point contributors to weak examples and reduce code quality.
 * @footnote-ethics: low - Uses public example repositories and does not process user-sensitive data.
 */

require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const SUPPORTED_KINDS = new Set([
    'smell',
    'technique',
    'pattern',
    'typescript-design',
]);
const DEFAULT_LIMIT = 3;
const DEFAULT_FORMAT = 'json';
const DEFAULT_MAP_PATH = path.join(
    __dirname,
    '..',
    'docs',
    'ai',
    'refactor_lookup_map.json'
);

function normalizeWhitespace(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeKind(kind) {
    const normalizedKind = normalizeWhitespace(kind).toLowerCase();
    if (!SUPPORTED_KINDS.has(normalizedKind)) {
        throw new Error(
            `Unsupported --kind value "${kind}". Expected one of: ${Array.from(SUPPORTED_KINDS).join(', ')}`
        );
    }
    return normalizedKind;
}

function tokenize(value) {
    return normalizeWhitespace(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/[\s-]+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

function parseArgs(argv) {
    const parsed = {
        kind: '',
        query: '',
        limit: DEFAULT_LIMIT,
        format: DEFAULT_FORMAT,
        mapPath: DEFAULT_MAP_PATH,
        quietNotes: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }
        if (arg === '--quiet-notes') {
            parsed.quietNotes = true;
            continue;
        }
        if (!arg.startsWith('--')) {
            continue;
        }

        const [flag, inlineValue] = arg.split('=');
        const nextValue = inlineValue ?? argv[index + 1];

        if (flag === '--kind') {
            parsed.kind = nextValue;
            if (inlineValue === undefined) {
                index += 1;
            }
            continue;
        }

        if (flag === '--query') {
            parsed.query = nextValue;
            if (inlineValue === undefined) {
                index += 1;
            }
            continue;
        }

        if (flag === '--limit') {
            const limitValue = Number.parseInt(nextValue, 10);
            if (!Number.isFinite(limitValue) || limitValue <= 0) {
                throw new Error(
                    `Invalid --limit value "${nextValue}". Use a positive integer.`
                );
            }
            parsed.limit = limitValue;
            if (inlineValue === undefined) {
                index += 1;
            }
            continue;
        }

        if (flag === '--format') {
            const formatValue = normalizeWhitespace(nextValue).toLowerCase();
            if (formatValue !== 'json' && formatValue !== 'md') {
                throw new Error(
                    `Invalid --format value "${nextValue}". Use json or md.`
                );
            }
            parsed.format = formatValue;
            if (inlineValue === undefined) {
                index += 1;
            }
            continue;
        }

        if (flag === '--map') {
            parsed.mapPath = path.resolve(process.cwd(), nextValue);
            if (inlineValue === undefined) {
                index += 1;
            }
            continue;
        }
    }

    return parsed;
}

function printUsage() {
    process.stdout.write(
        [
            'Usage:',
            '  pnpm refactor:lookup --kind <smell|technique|pattern|typescript-design> --query "<text>" [--limit <n>] [--format <json|md>] [--map <path>] [--quiet-notes]',
            '',
            'Examples:',
            '  pnpm refactor:lookup --kind smell --query "long function"',
            '  pnpm refactor:lookup --kind pattern --query "strategy" --format md',
        ].join('\n') + '\n'
    );
}

function loadLookupMap(mapPathValue = DEFAULT_MAP_PATH) {
    const rawMap = fs.readFileSync(mapPathValue, 'utf8');
    const parsedMap = JSON.parse(rawMap);

    if (
        !parsedMap.aliases ||
        !parsedMap.repoRouting ||
        !parsedMap.confidenceRules
    ) {
        throw new Error(
            'Lookup map is missing required keys: aliases, repoRouting, confidenceRules.'
        );
    }

    return parsedMap;
}

function resolveCanonicalQuery(rawQuery, lookupMap) {
    const normalizedQuery = normalizeWhitespace(rawQuery).toLowerCase();
    const canonical = lookupMap.aliases[normalizedQuery] || normalizedQuery;
    const aliasUsed = canonical !== normalizedQuery;

    return {
        canonical,
        original: normalizedQuery,
        aliasUsed,
    };
}

function addUniqueNote(notes, note) {
    if (!notes.includes(note)) {
        notes.push(note);
    }
}

function buildSearchQuery(kind, canonicalQuery, lookupMap) {
    const intentTerms = lookupMap.intents?.[kind]?.canonicalTerms || [];
    const merged = [canonicalQuery, ...intentTerms]
        .flatMap((term) => tokenize(term))
        .filter(Boolean);

    const uniqueTokens = Array.from(new Set(merged));
    return uniqueTokens.join(' ');
}

function scoreCandidate(candidate, context) {
    const searchable = `${candidate.name} ${candidate.path}`.toLowerCase();
    const canonicalQuery = context.canonicalQuery;
    const originalQuery = context.originalQuery;
    const queryTokens = tokenize(canonicalQuery);
    const seedPaths = context.seedPaths || [];

    let score = 0;
    const reasons = [];

    if (canonicalQuery && searchable.includes(canonicalQuery)) {
        score += 70;
        reasons.push('exact canonical query match');
    }

    if (
        originalQuery &&
        originalQuery !== canonicalQuery &&
        searchable.includes(originalQuery)
    ) {
        score += 25;
        reasons.push('original query alias match');
    }

    const tokenHitCount = queryTokens.filter((token) =>
        searchable.includes(token)
    ).length;
    if (tokenHitCount > 0 && queryTokens.length > 0) {
        const tokenScore = Math.round(
            (tokenHitCount / queryTokens.length) * 30
        );
        score += tokenScore;
        reasons.push(`token overlap (${tokenHitCount}/${queryTokens.length})`);
    }

    for (const seedPath of seedPaths) {
        const normalizedSeedPath = seedPath.toLowerCase();
        const normalizedCandidatePath = candidate.path.toLowerCase();
        if (normalizedCandidatePath === normalizedSeedPath) {
            score += 20;
            reasons.push('seed path exact match');
            break;
        }
        if (normalizedCandidatePath.startsWith(`${normalizedSeedPath}/`)) {
            score += 12;
            reasons.push('seed path prefix match');
            break;
        }
    }

    if (candidate.repo === context.primaryRepo) {
        score += 5;
        reasons.push('primary repo preference');
    }

    return {
        ...candidate,
        score: Math.min(score, 100),
        whyRelevant: reasons.join('; ') || 'weak lexical match',
    };
}

function rankCandidates(candidates, context) {
    const uniqueByPath = new Map();

    for (const candidate of candidates) {
        const key = `${candidate.repo}::${candidate.path}`;
        if (!uniqueByPath.has(key)) {
            uniqueByPath.set(key, candidate);
        }
    }

    return Array.from(uniqueByPath.values())
        .map((candidate) => scoreCandidate(candidate, context))
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            const leftKey = `${left.repo}/${left.path}`;
            const rightKey = `${right.repo}/${right.path}`;
            return leftKey.localeCompare(rightKey);
        });
}

function deriveConfidence(topScore, confidenceRules) {
    if (topScore >= confidenceRules.highThreshold) {
        return 'high';
    }
    if (topScore >= confidenceRules.mediumThreshold) {
        return 'medium';
    }
    return 'low';
}

function createRepoUrl(repo, subPath = '') {
    const normalizedSubPath = normalizeWhitespace(subPath);
    if (!normalizedSubPath) {
        return `https://github.com/${repo}`;
    }
    return `https://github.com/${repo}/tree/master/${normalizedSubPath}`;
}

function createFallbackMatches(lookupMap, repositories, canonicalQuery, limit) {
    const fallbackMatches = [];

    for (const repo of repositories.filter(Boolean)) {
        const seeds = lookupMap.seedPaths?.[repo] || ['README.md'];
        for (const seedPath of seeds) {
            fallbackMatches.push({
                repo,
                path: seedPath,
                url: createRepoUrl(repo, seedPath),
                whyRelevant: `fallback link for "${canonicalQuery}"`,
                score: 10,
            });
            if (fallbackMatches.length >= limit) {
                return fallbackMatches;
            }
        }
    }

    if (fallbackMatches.length === 0) {
        return repositories
            .filter(Boolean)
            .slice(0, limit)
            .map((repo) => ({
                repo,
                path: 'README.md',
                url: createRepoUrl(repo, 'README.md'),
                whyRelevant: `fallback link for "${canonicalQuery}"`,
                score: 10,
            }));
    }

    return fallbackMatches;
}

function parseRepo(repo) {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
        throw new Error(`Invalid repo value "${repo}". Expected owner/name.`);
    }
    return { owner, name };
}

function generateGitHubAppJwt() {
    const appId = process.env.GITHUB_APP_ID;
    const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    if (!appId || !keyPath) {
        throw new Error(
            'Missing GitHub App env: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH are required for app auth.'
        );
    }

    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const now = Math.floor(Date.now() / 1000);

    return jwt.sign(
        {
            iat: now - 60,
            exp: now + 600,
            iss: appId,
        },
        privateKey,
        { algorithm: 'RS256' }
    );
}

async function getInstallationTokenForOwner(owner, fetchImpl = fetch) {
    const appJwt = generateGitHubAppJwt();

    const installationsResponse = await fetchImpl(
        'https://api.github.com/app/installations',
        {
            headers: {
                Authorization: `Bearer ${appJwt}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'Footnote-Refactor-Lookup',
            },
        }
    );

    if (!installationsResponse.ok) {
        throw new Error(
            `installation list failed (${installationsResponse.status} ${installationsResponse.statusText})`
        );
    }

    const installations = await installationsResponse.json();
    const installation = installations.find(
        (item) => item.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (!installation) {
        throw new Error(`app is not installed for owner ${owner}`);
    }

    const tokenResponse = await fetchImpl(
        `https://api.github.com/app/installations/${installation.id}/access_tokens`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${appJwt}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'Footnote-Refactor-Lookup',
            },
        }
    );

    if (!tokenResponse.ok) {
        throw new Error(
            `installation token failed (${tokenResponse.status} ${tokenResponse.statusText})`
        );
    }

    const tokenPayload = await tokenResponse.json();
    return tokenPayload.token;
}

async function resolveAuthHeader(owner, notes, fetchImpl = fetch) {
    if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
        try {
            const appToken = await getInstallationTokenForOwner(
                owner,
                fetchImpl
            );
            addUniqueNote(notes, `auth: github-app(${owner})`);
            return `token ${appToken}`;
        } catch (error) {
            addUniqueNote(
                notes,
                `auth warning: github app unavailable for ${owner}; ${error.message}`
            );
        }
    }

    if (process.env.GITHUB_TOKEN) {
        addUniqueNote(notes, 'auth: github-token');
        return `token ${process.env.GITHUB_TOKEN}`;
    }

    addUniqueNote(notes, 'auth: unauthenticated public search');
    return null;
}

async function searchRepoCode({
    repo,
    searchQuery,
    authHeader,
    perPage,
    fetchImpl = fetch,
}) {
    const encodedQuery = encodeURIComponent(`${searchQuery} repo:${repo}`);
    const url = `https://api.github.com/search/code?q=${encodedQuery}&per_page=${perPage}`;

    const headers = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Footnote-Refactor-Lookup',
    };

    if (authHeader) {
        headers.Authorization = authHeader;
    }

    const response = await fetchImpl(url, { headers });

    if (!response.ok) {
        let errorMessage = `${response.status} ${response.statusText}`;
        try {
            const payload = await response.json();
            if (payload?.message) {
                errorMessage = `${errorMessage} - ${payload.message}`;
            }
        } catch (_error) {
            // Keep status text fallback when response body is not JSON.
        }
        throw new Error(
            `GitHub code search failed for ${repo}: ${errorMessage}`
        );
    }

    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];

    return items.map((item) => ({
        repo,
        name: item.name || path.basename(item.path || ''),
        path: item.path || '',
        url: item.html_url || createRepoUrl(repo, item.path || ''),
    }));
}

async function fetchRepoTree({
    owner,
    name,
    branch,
    authHeader,
    fetchImpl = fetch,
}) {
    const headers = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Footnote-Refactor-Lookup',
    };

    if (authHeader) {
        headers.Authorization = authHeader;
    }

    const treeUrl = `https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`;
    const response = await fetchImpl(treeUrl, { headers });
    if (!response.ok) {
        return null;
    }

    return {
        branch,
        payload: await response.json(),
    };
}

async function searchRepoByTree({
    repo,
    searchQuery,
    authHeader,
    perPage,
    notes,
    fetchImpl = fetch,
}) {
    const { owner, name } = parseRepo(repo);
    const masterTree = await fetchRepoTree({
        owner,
        name,
        branch: 'master',
        authHeader,
        fetchImpl,
    });
    const mainTree =
        masterTree ||
        (await fetchRepoTree({
            owner,
            name,
            branch: 'main',
            authHeader,
            fetchImpl,
        }));

    if (!mainTree?.payload?.tree || !Array.isArray(mainTree.payload.tree)) {
        throw new Error(
            `GitHub tree search failed for ${repo}: could not load tree from master/main`
        );
    }

    const queryTokens = tokenize(searchQuery);
    const maxCandidates = Math.max(perPage, 50);

    const candidates = mainTree.payload.tree
        .filter(
            (entry) => entry.type === 'blob' && typeof entry.path === 'string'
        )
        .map((entry) => {
            const entryPath = String(entry.path);
            const lowerPath = entryPath.toLowerCase();
            const tokenHits = queryTokens.filter((token) =>
                lowerPath.includes(token)
            ).length;
            return {
                entryPath,
                tokenHits,
            };
        })
        .filter((entry) => entry.tokenHits > 0)
        .sort((left, right) => {
            if (right.tokenHits !== left.tokenHits) {
                return right.tokenHits - left.tokenHits;
            }
            return left.entryPath.localeCompare(right.entryPath);
        })
        .slice(0, maxCandidates)
        .map((entry) => ({
            repo,
            name: path.basename(entry.entryPath),
            path: entry.entryPath,
            url: `https://github.com/${repo}/blob/${mainTree.branch}/${entry.entryPath}`,
        }));

    addUniqueNote(
        notes,
        `search fallback: used git tree path matching for ${repo} (${mainTree.branch})`
    );
    return candidates;
}

async function searchRepoExamples({
    repo,
    searchQuery,
    authHeader,
    perPage,
    notes,
    fetchImpl = fetch,
}) {
    try {
        return await searchRepoCode({
            repo,
            searchQuery,
            authHeader,
            perPage,
            fetchImpl,
        });
    } catch (error) {
        const message = String(error?.message || '');
        const canFallback =
            message.includes('401') ||
            message.includes('403') ||
            message.includes('422');

        if (!canFallback) {
            throw error;
        }

        addUniqueNote(
            notes,
            `search warning: code search unavailable for ${repo}; falling back to tree search`
        );
        return searchRepoByTree({
            repo,
            searchQuery,
            authHeader,
            perPage,
            notes,
            fetchImpl,
        });
    }
}

async function lookupRefactorExamples(options) {
    const fetchImpl = options.fetchImpl || fetch;
    const lookupMap =
        options.lookupMap || loadLookupMap(options.mapPath || DEFAULT_MAP_PATH);
    const kind = normalizeKind(options.kind);
    const queryValue = normalizeWhitespace(options.query);
    const limit = Number.isFinite(options.limit)
        ? Math.max(1, options.limit)
        : DEFAULT_LIMIT;

    if (!queryValue) {
        throw new Error('Missing required --query value.');
    }

    const route = lookupMap.repoRouting[kind];
    if (!route?.primary) {
        throw new Error(`No repo routing configured for kind "${kind}".`);
    }

    const notes = [];
    const canonicalQuery = resolveCanonicalQuery(queryValue, lookupMap);
    if (canonicalQuery.aliasUsed) {
        addUniqueNote(
            notes,
            `query alias normalized: "${canonicalQuery.original}" -> "${canonicalQuery.canonical}"`
        );
    }

    const searchQuery = buildSearchQuery(
        kind,
        canonicalQuery.canonical,
        lookupMap
    );
    const primaryRepo = route.primary;
    const fallbackRepo = route.fallback;
    const confidenceRules = lookupMap.confidenceRules;

    const primaryOwner = parseRepo(primaryRepo).owner;
    const primaryAuthHeader = await resolveAuthHeader(
        primaryOwner,
        notes,
        fetchImpl
    );
    const primaryCandidates = await searchRepoExamples({
        repo: primaryRepo,
        searchQuery,
        authHeader: primaryAuthHeader,
        perPage: confidenceRules.maxPerRepo,
        notes,
        fetchImpl,
    });

    let rankedCombined = rankCandidates(primaryCandidates, {
        canonicalQuery: canonicalQuery.canonical,
        originalQuery: canonicalQuery.original,
        seedPaths: lookupMap.seedPaths?.[primaryRepo] || [],
        primaryRepo,
    });

    let fallbackUsed = false;
    const topPrimaryScore = rankedCombined[0]?.score || 0;

    if (fallbackRepo && topPrimaryScore < confidenceRules.fallbackTrigger) {
        fallbackUsed = true;
        addUniqueNote(
            notes,
            `fallback triggered: top score ${topPrimaryScore} below ${confidenceRules.fallbackTrigger}`
        );

        const fallbackOwner = parseRepo(fallbackRepo).owner;
        const fallbackAuthHeader = await resolveAuthHeader(
            fallbackOwner,
            notes,
            fetchImpl
        );
        const fallbackCandidates = await searchRepoExamples({
            repo: fallbackRepo,
            searchQuery,
            authHeader: fallbackAuthHeader,
            perPage: confidenceRules.maxPerRepo,
            notes,
            fetchImpl,
        });

        const rankedFallback = rankCandidates(fallbackCandidates, {
            canonicalQuery: canonicalQuery.canonical,
            originalQuery: canonicalQuery.original,
            seedPaths: lookupMap.seedPaths?.[fallbackRepo] || [],
            primaryRepo,
        });

        rankedCombined = rankCandidates(
            [...rankedCombined, ...rankedFallback],
            {
                canonicalQuery: canonicalQuery.canonical,
                originalQuery: canonicalQuery.original,
                seedPaths: [],
                primaryRepo,
            }
        );
    }

    let matches = rankedCombined.slice(0, limit).map((item) => ({
        repo: item.repo,
        path: item.path,
        url: item.url,
        whyRelevant: item.whyRelevant,
        score: item.score,
    }));

    let confidence = deriveConfidence(matches[0]?.score || 0, confidenceRules);

    if (matches.length === 0) {
        fallbackUsed = true;
        confidence = 'low';
        addUniqueNote(
            notes,
            'no strong code search results; returning broad fallback links'
        );
        matches = createFallbackMatches(
            lookupMap,
            [primaryRepo, fallbackRepo],
            canonicalQuery.canonical,
            limit
        );
    }

    return {
        intent: kind,
        query: canonicalQuery.canonical,
        confidence,
        matches,
        fallbackUsed,
        notes,
    };
}

function formatMarkdown(result) {
    const lines = [];
    lines.push(`# Refactor Lookup`);
    lines.push('');
    lines.push(`- intent: ${result.intent}`);
    lines.push(`- query: ${result.query}`);
    lines.push(`- confidence: ${result.confidence}`);
    lines.push(`- fallbackUsed: ${result.fallbackUsed ? 'yes' : 'no'}`);
    lines.push('');
    lines.push('## Matches');

    for (const match of result.matches) {
        lines.push(
            `- [${match.repo}/${match.path}](${match.url}) (score: ${match.score}) - ${match.whyRelevant}`
        );
    }

    if (result.notes.length > 0) {
        lines.push('');
        lines.push('## Notes');
        for (const note of result.notes) {
            lines.push(`- ${note}`);
        }
    }

    return lines.join('\n');
}

async function runCli(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        printUsage();
        return 0;
    }

    try {
        const result = await lookupRefactorExamples(args);
        const outputResult = args.quietNotes
            ? { ...result, notes: [] }
            : result;
        if (args.format === 'md') {
            process.stdout.write(`${formatMarkdown(outputResult)}\n`);
        } else {
            process.stdout.write(`${JSON.stringify(outputResult, null, 2)}\n`);
        }
        return 0;
    } catch (error) {
        process.stderr.write(`refactor-lookup failed: ${error.message}\n`);
        return 1;
    }
}

if (require.main === module) {
    runCli().then((code) => {
        process.exit(code);
    });
}

module.exports = {
    DEFAULT_MAP_PATH,
    buildSearchQuery,
    createFallbackMatches,
    deriveConfidence,
    formatMarkdown,
    loadLookupMap,
    lookupRefactorExamples,
    normalizeKind,
    parseArgs,
    rankCandidates,
    resolveCanonicalQuery,
    runCli,
    scoreCandidate,
    tokenize,
};
