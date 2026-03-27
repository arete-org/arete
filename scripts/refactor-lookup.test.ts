/**
 * @description: Verifies refactor lookup argument parsing, ranking, fallback behavior, and GitHub error handling.
 * @footnote-scope: test
 * @footnote-module: RefactorLookupTests
 * @footnote-risk: low - This test validates script behavior and does not affect runtime request handling.
 * @footnote-ethics: low - Assertions use synthetic fixtures and do not process user-sensitive data.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const lookup = require('./refactor-lookup.cjs');

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        async json() {
            return body;
        },
    };
}

const testLookupMap = {
    aliases: {
        'long function': 'long method',
        strategy: 'strategy',
    },
    intents: {
        smell: { canonicalTerms: ['smell', 'cleanup'] },
        technique: { canonicalTerms: ['refactor'] },
        pattern: { canonicalTerms: ['pattern', 'design'] },
        'typescript-design': { canonicalTerms: ['typescript', 'architecture'] },
    },
    repoRouting: {
        smell: {
            primary: 'RefactoringGuru/refactoring-examples',
            fallback: 'RefactoringGuru/design-patterns-typescript',
        },
        technique: {
            primary: 'RefactoringGuru/refactoring-examples',
            fallback: 'RefactoringGuru/design-patterns-typescript',
        },
        pattern: {
            primary: 'RefactoringGuru/design-patterns-typescript',
            fallback: 'RefactoringGuru/refactoring-examples',
        },
        'typescript-design': {
            primary: 'RefactoringGuru/design-patterns-typescript',
            fallback: 'RefactoringGuru/refactoring-examples',
        },
    },
    seedPaths: {
        'RefactoringGuru/refactoring-examples': ['README.md', 'src'],
        'RefactoringGuru/design-patterns-typescript': [
            'README.md',
            'src/Behavioral',
        ],
    },
    confidenceRules: {
        highThreshold: 85,
        mediumThreshold: 55,
        fallbackTrigger: 55,
        maxPerRepo: 20,
    },
};

const envBackup = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY_PATH: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
};

test.beforeEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    delete process.env.GITHUB_TOKEN;
});

test.after(() => {
    process.env.GITHUB_APP_ID = envBackup.GITHUB_APP_ID;
    process.env.GITHUB_APP_PRIVATE_KEY_PATH =
        envBackup.GITHUB_APP_PRIVATE_KEY_PATH;
    process.env.GITHUB_TOKEN = envBackup.GITHUB_TOKEN;
});

test('resolveCanonicalQuery normalizes alias', () => {
    const resolved = lookup.resolveCanonicalQuery(
        ' long function ',
        testLookupMap
    );
    assert.equal(resolved.canonical, 'long method');
    assert.equal(resolved.aliasUsed, true);
});

test('parseArgs supports --quiet-notes flag', () => {
    const parsed = lookup.parseArgs([
        '--kind',
        'pattern',
        '--query',
        'adapter',
        '--quiet-notes',
    ]);
    assert.equal(parsed.quietNotes, true);
});

test('rankCandidates is deterministic and prefers stronger match', () => {
    const ranked = lookup.rankCandidates(
        [
            {
                repo: 'RefactoringGuru/refactoring-examples',
                name: 'README.md',
                path: 'README.md',
                url: 'https://example.com/readme',
            },
            {
                repo: 'RefactoringGuru/refactoring-examples',
                name: 'long_method.ts',
                path: 'src/long_method.ts',
                url: 'https://example.com/long_method',
            },
        ],
        {
            canonicalQuery: 'long method',
            originalQuery: 'long function',
            seedPaths: ['README.md'],
            primaryRepo: 'RefactoringGuru/refactoring-examples',
        }
    );

    assert.equal(ranked[0].path, 'src/long_method.ts');
    assert.ok(ranked[0].score >= ranked[1].score);
});

test('lookupRefactorExamples uses fallback when primary confidence is low', async () => {
    const fetchMock = async (url: string) => {
        if (url.includes('repo%3ARefactoringGuru%2Frefactoring-examples')) {
            return jsonResponse({ items: [] });
        }
        if (
            url.includes('repo%3ARefactoringGuru%2Fdesign-patterns-typescript')
        ) {
            return jsonResponse({
                items: [
                    {
                        name: 'strategy.ts',
                        path: 'src/Behavioral/Strategy/strategy.ts',
                        html_url:
                            'https://github.com/RefactoringGuru/design-patterns-typescript/blob/master/src/Behavioral/Strategy/strategy.ts',
                    },
                ],
            });
        }
        return jsonResponse({ items: [] });
    };

    const result = await lookup.lookupRefactorExamples({
        kind: 'smell',
        query: 'long function',
        limit: 3,
        lookupMap: testLookupMap,
        fetchImpl: fetchMock,
    });

    assert.equal(result.fallbackUsed, true);
    assert.ok(result.matches.length > 0);
    const unauthNotes = result.notes.filter(
        (note: string) => note === 'auth: unauthenticated public search'
    );
    assert.equal(unauthNotes.length, 1);
});

test('lookupRefactorExamples returns fallback links when no search results exist', async () => {
    const fetchMock = async () => jsonResponse({ items: [] });

    const result = await lookup.lookupRefactorExamples({
        kind: 'pattern',
        query: 'unknown concept',
        limit: 2,
        lookupMap: testLookupMap,
        fetchImpl: fetchMock,
    });

    assert.equal(result.confidence, 'low');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.matches.length, 2);
    assert.match(result.matches[0].url, /github\.com/);
});

test('lookupRefactorExamples falls back to tree search when code search is unauthorized', async () => {
    const fetchMock = async (url: string) => {
        if (url.includes('/search/code')) {
            return jsonResponse({ message: 'requires authentication' }, 401);
        }

        if (
            url.includes(
                '/repos/RefactoringGuru/design-patterns-typescript/git/trees/master'
            )
        ) {
            return jsonResponse({ message: 'not found' }, 404);
        }

        if (
            url.includes(
                '/repos/RefactoringGuru/design-patterns-typescript/git/trees/main'
            )
        ) {
            return jsonResponse({
                tree: [
                    {
                        type: 'blob',
                        path: 'src/Behavioral/Strategy/strategy.ts',
                    },
                ],
            });
        }

        return jsonResponse({ tree: [] });
    };

    const result = await lookup.lookupRefactorExamples({
        kind: 'pattern',
        query: 'strategy pattern',
        limit: 2,
        lookupMap: testLookupMap,
        fetchImpl: fetchMock,
    });

    assert.equal(result.matches.length > 0, true);
    assert.equal(
        result.notes.some((note: string) =>
            note.includes('tree path matching')
        ),
        true
    );
});

test('lookupRefactorExamples throws clear errors for GitHub API failures', async () => {
    const fetchMock = async (url: string) => {
        if (url.includes('/search/code')) {
            return jsonResponse({ message: 'rate limit exceeded' }, 403);
        }
        return jsonResponse({ message: 'tree unavailable' }, 500);
    };

    await assert.rejects(
        lookup.lookupRefactorExamples({
            kind: 'technique',
            query: 'extract method',
            lookupMap: testLookupMap,
            fetchImpl: fetchMock,
        }),
        /GitHub tree search failed/
    );
});
