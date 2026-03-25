/**
 * @description: Normalizes image generation errors into user-facing messages.
 * @footnote-scope: utility
 * @footnote-module: ImageErrorHandling
 * @footnote-risk: low - Incorrect mappings can mislead users or hide recoverable issues.
 * @footnote-ethics: low - Error copy affects transparency but not sensitive processing.
 */
import { CombinedPropertyError } from '@sapphire/shapeshift';
import { logger } from '../../utils/logger.js';
import { CloudinaryConfigurationError } from './cloudinary.js';

/**
 * Provider-neutral error payload used when an upstream image API returns a
 * structured error body.
 */
export interface ImageProviderResponseError {
    code?: string | null;
    message: string;
}

export function mapResponseError(error: ImageProviderResponseError): string {
    switch (error.code) {
        case 'image_content_policy_violation':
            return 'OpenAI safety filters blocked this prompt. Please modify your prompt and try again.';
        case 'rate_limit_exceeded':
            return 'OpenAI rate limit hit. Please wait a few moments and try again.';
        case 'invalid_prompt':
            return `OpenAI could not process the prompt: ${error.message}`;
        case 'server_error':
            return 'OpenAI had a temporary issue generating the image. Please try again.';
        case 'invalid_image':
        case 'invalid_image_format':
        case 'invalid_base64_image':
        case 'invalid_image_url':
        case 'image_too_large':
        case 'image_too_small':
        case 'image_parse_error':
        case 'invalid_image_mode':
        case 'image_file_too_large':
        case 'unsupported_image_media_type':
        case 'empty_image_file':
        case 'failed_to_download_image':
        case 'image_file_not_found':
            return `Image processing error: ${error.message}`;
        default:
            return `OpenAI error: ${error.message}`;
    }
}

export function resolveImageCommandError(error: unknown): string {
    if (error instanceof CloudinaryConfigurationError) {
        return 'Cloudinary is not configured. Please contact the administrator.';
    }

    if (error instanceof AggregateError) {
        const aggregate = error as AggregateError & { errors?: unknown[] };
        const nestedMessages = (aggregate.errors ?? [])
            .map((inner) => resolveImageCommandError(inner))
            .filter(
                (message) => Boolean(message) && message !== aggregate.message
            );

        if (nestedMessages.length > 0) {
            const uniqueMessages = [...new Set(nestedMessages)];
            return uniqueMessages.join(' | ');
        }

        return (
            aggregate.message ||
            'Multiple errors occurred while generating the image.'
        );
    }

    if (error instanceof CombinedPropertyError) {
        logger.warn(
            'Discord embed validation failed while preparing an image response: %s',
            error
        );
        return 'Discord rejected the response format. Please try again with a shorter or simpler prompt.';
    }

    if (isProviderApiError(error)) {
        const code = extractApiErrorCode(error);
        const status = error.status;
        if (
            code === 'content_policy_violation' ||
            code === 'image_content_policy_violation'
        ) {
            return 'OpenAI safety filters blocked this prompt. Please modify your prompt and try again.';
        }
        if (code === 'rate_limit_exceeded' || status === 429) {
            return 'OpenAI rate limit hit. Please wait a few moments and try again.';
        }
        if (status === 401 || status === 403) {
            return 'OpenAI rejected our request. Please contact the administrator.';
        }
        if (
            status === 400 &&
            /invalid[_\s-]*prompt/i.test(error.message ?? '')
        ) {
            return 'OpenAI reported that the prompt was invalid. Please try again with a simpler request.';
        }
        if (typeof status === 'number' && status >= 500) {
            return 'OpenAI had a temporary issue generating the image. Please try again.';
        }
        return error.message || 'OpenAI returned an unexpected error.';
    }

    if (error instanceof Error) {
        const message = error.message || 'Unknown error.';
        if (/content filter|safety system|moderation/i.test(message)) {
            return 'OpenAI safety filters blocked this prompt. Please modify your prompt and try again.';
        }
        if (/quota/i.test(message)) {
            return 'Quota exceeded: Please try again later.';
        }
        if (/network|timeout|fetch/i.test(message)) {
            return 'Network error: Please try again later.';
        }
        if (/model/i.test(message)) {
            return 'Model error: The specified model is not supported for image generation.';
        }
        return message;
    }

    return 'An unknown error occurred while generating the image.';
}

interface ProviderApiErrorShape {
    message: string;
    status?: number;
    code?: unknown;
    error?: unknown;
}

function isProviderApiError(error: unknown): error is ProviderApiErrorShape {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const candidate = error as {
        message?: unknown;
        status?: unknown;
        code?: unknown;
        error?: unknown;
    };

    if (typeof candidate.message !== 'string') {
        return false;
    }

    const hasStatus = typeof candidate.status === 'number';
    const hasCode = typeof candidate.code === 'string';
    const nestedCode =
        candidate.error &&
        typeof candidate.error === 'object' &&
        'code' in candidate.error
            ? (candidate.error as { code?: unknown }).code
            : undefined;
    const hasNestedCode = typeof nestedCode === 'string';

    return hasStatus || hasCode || hasNestedCode;
}

function extractApiErrorCode(error: ProviderApiErrorShape): string | undefined {
    if (typeof error.code === 'string') {
        return error.code;
    }

    const apiError =
        error.error && typeof error.error === 'object'
            ? (error.error as { code?: string })
            : undefined;
    if (apiError && typeof apiError.code === 'string') {
        return apiError.code;
    }

    return undefined;
}
