/**
 * @description: Validates web blog fetch behavior for API-client errors and not-found handling.
 * @footnote-scope: test
 * @footnote-module: WebBlogApiTests
 * @footnote-risk: low - These tests only verify error classification behavior for read-only blog calls.
 * @footnote-ethics: low - Uses synthetic errors and does not process user-identifying data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApiClientError } from './api.js';
import { api } from './api.js';
import { fetchBlogIndex, fetchBlogPost } from './blog.js';

const createApiClientError = (status: number): ApiClientError => {
    const error = new Error(`HTTP ${status}`) as ApiClientError;
    error.name = 'ApiClientError';
    error.status = status;
    error.code = 'api_error';
    error.endpoint = '/api/blog';
    return error;
};

test('fetchBlogIndex treats ApiClientError 404 as missing content', async () => {
    const originalGetBlogIndex = api.getBlogIndex;

    try {
        api.getBlogIndex = async () => {
            throw createApiClientError(404);
        };

        const result = await fetchBlogIndex();
        assert.equal(result, null);
    } finally {
        api.getBlogIndex = originalGetBlogIndex;
    }
});

test('fetchBlogPost treats ApiClientError 404 as missing content', async () => {
    const originalGetBlogPost = api.getBlogPost;

    try {
        api.getBlogPost = async () => {
            throw createApiClientError(404);
        };

        const result = await fetchBlogPost(42);
        assert.equal(result, null);
    } finally {
        api.getBlogPost = originalGetBlogPost;
    }
});
