/**
 * @description: Defines monorepo lint rules, shared globals, and import guardrails across packages.
 * @arete-scope: utility
 * @arete-module: EslintConfig
 * @arete-risk: moderate - Misconfigured lint rules can hide unsafe imports or weaken code quality checks.
 * @arete-ethics: low - Lint policy affects traceability and consistency but does not directly process user data.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let prettierConfig = null;
// Prevent relative imports that jump between monorepo packages
const monorepoPackages = ['backend', 'discord-bot', 'web'];
// How many "../" levels to cover for relative imports
const restrictedImportDepth = 10;
// Build import patterns like "../backend/**" and "../../packages/web/**"
const restrictedPackageImportPatterns = Array.from(
    { length: restrictedImportDepth },
    (_, index) => {
        const prefix = '../'.repeat(index + 1);
        return monorepoPackages.flatMap((pkg) => [
            `${prefix}${pkg}/**`,
            `${prefix}packages/${pkg}/**`,
        ]);
    }
).flat();

try {
    prettierConfig = require('eslint-config-prettier');
} catch {
    prettierConfig = null;
}

export default [
    js.configs.recommended,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            globals: {
                // Node.js globals
                process: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                console: 'readonly',
                __dirname: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                NodeJS: 'readonly',
                AbortController: 'readonly',
                AbortSignal: 'readonly',
                fetch: 'readonly',
                global: 'readonly',
                setImmediate: 'readonly',
                BufferEncoding: 'readonly',
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                HTMLElement: 'readonly',
                HTMLTextAreaElement: 'readonly',
                HTMLDivElement: 'readonly',
                HTMLInputElement: 'readonly',
                HTMLFormElement: 'readonly',
                HTMLButtonElement: 'readonly',
                HTMLImageElement: 'readonly',
                Audio: 'readonly',
                IntersectionObserver: 'readonly',
                ResizeObserver: 'readonly',
                MutationObserver: 'readonly',
                KeyboardEvent: 'readonly',
                Event: 'readonly',
                EventTarget: 'readonly',
                Node: 'readonly',
                Request: 'readonly',
                Response: 'readonly',
                Headers: 'readonly',
                React: 'readonly',
                MediaQueryListEvent: 'readonly',
                JSX: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off', // Allow console statements
            'no-unused-vars': 'off', // Use TypeScript version instead
        },
    },
    {
        files: ['packages/*/**/*.{ts,tsx,js,jsx}'],
        rules: {
            // In package code, don't hop into another package with relative paths.
            // Use the package name (e.g. @arete/backend) and its public exports.
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: restrictedPackageImportPatterns,
                            message:
                                'Import across packages via workspace package names (e.g. @arete/backend) instead of relative paths.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: [
            'packages/web/**/*.{ts,tsx,js,jsx}',
            'packages/discord-bot/**/*.{ts,tsx,js,jsx}',
            'packages/contracts/**/*.{ts,tsx,js,jsx}',
        ],
        rules: {
            // Guardrail: packages outside backend should not import backend code directly.
            // Web/bot should call the backend over HTTP (/api/*) and keep the fetch logic
            // in a small local module. Contracts should stay dependency-light and only
            // define shared wire shapes/schemas.
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        'ImportDeclaration[source.value=/^@arete\\/backend(\\/|$)/]',
                    message:
                        'Avoid @arete/backend imports outside backend. Web/bot should call the backend via /api/* with package-local API clients, and contracts should stay dependency-light.',
                },
                {
                    selector:
                        'ImportExpression[source.value=/^@arete\\/backend(\\/|$)/]',
                    message:
                        'Avoid @arete/backend dynamic imports outside backend. Web/bot should call the backend via /api/* with package-local API clients, and contracts should stay dependency-light.',
                },
                {
                    selector:
                        'ExportNamedDeclaration[source.value=/^@arete\\/backend(\\/|$)/]',
                    message:
                        'Avoid re-exporting @arete/backend modules outside backend. Web/bot should call the backend via /api/* with package-local API clients, and contracts should stay dependency-light.',
                },
                {
                    selector:
                        'ExportAllDeclaration[source.value=/^@arete\\/backend(\\/|$)/]',
                    message:
                        'Avoid re-exporting @arete/backend modules outside backend. Web/bot should call the backend via /api/* with package-local API clients, and contracts should stay dependency-light.',
                },
            ],
        },
    },
    {
        files: ['packages/web/**/*.{ts,tsx}'],
        plugins: {
            'react-hooks': reactHooks,
        },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
        },
    },
    {
        ignores: [
            'node_modules/',
            'dist/',
            'build/',
            'packages/*/dist/',
            'packages/*/build/',
            '**/*.tsbuildinfo',
            '**/*.js',
            '*.d.ts',
        ],
    },
    ...(prettierConfig ? [prettierConfig] : []),
];
