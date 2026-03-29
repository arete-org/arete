/**
 * @description: Executes the planner via OpenAI Responses function calling to enforce a structured planner decision payload.
 * @footnote-scope: core
 * @footnote-module: ChatPlannerStructuredOpenAI
 * @footnote-risk: high - API contract mistakes here can hard-fail planner execution.
 * @footnote-ethics: high - Structured planner correctness affects grounding and response behavior.
 */
import type { GenerationUsage, RuntimeMessage } from '@footnote/agent-runtime';
import {
    CHAT_PLANNER_TOOL_NAME,
    chatPlannerDecisionTool,
} from './chatPlannerDecisionContract.js';

type ChatPlannerStructuredExecutionRequest = {
    messages: RuntimeMessage[];
    model: string;
    maxOutputTokens: number;
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
    verbosity: 'low' | 'medium' | 'high';
    signal?: AbortSignal;
};

type PlannerToolCallOutputItem = {
    type?: string;
    name?: string;
    arguments?: string;
    status?: string;
};

type ChatPlannerStructuredExecutionResult = {
    decision: unknown;
    model?: string;
    usage?: GenerationUsage;
    rawArguments?: string;
};

type CreateOpenAiChatPlannerStructuredExecutorOptions = {
    apiKey: string;
    retryAttempts?: number;
};

type ResponsesInputMessage = {
    role: string;
    type: 'message';
    content:
        | string
        | Array<{
              type: 'input_text';
              text: string;
          }>;
};

const normalizeReasoningEffort = (
    value: ChatPlannerStructuredExecutionRequest['reasoningEffort']
): 'low' | 'medium' | 'high' => {
    if (value === 'medium' || value === 'high') {
        return value;
    }
    return 'low';
};

const normalizeVerbosity = (
    value: ChatPlannerStructuredExecutionRequest['verbosity']
): 'low' | 'medium' | 'high' => {
    if (value === 'medium' || value === 'high') {
        return value;
    }
    return 'low';
};

const toResponsesInputMessages = (
    messages: RuntimeMessage[]
): ResponsesInputMessage[] =>
    messages.map((message) => ({
        role: message.role,
        type: 'message',
        content:
            message.role === 'assistant'
                ? message.content
                : [
                      {
                          type: 'input_text',
                          text: message.content,
                      },
                  ],
    }));

export const createOpenAiChatPlannerStructuredExecutor = ({
    apiKey,
    retryAttempts = 1,
}: CreateOpenAiChatPlannerStructuredExecutorOptions) => {
    return async (
        request: ChatPlannerStructuredExecutionRequest
    ): Promise<ChatPlannerStructuredExecutionResult> => {
        const requestBody = JSON.stringify({
            model: request.model,
            input: toResponsesInputMessages(request.messages),
            max_output_tokens: request.maxOutputTokens,
            reasoning: {
                effort: normalizeReasoningEffort(request.reasoningEffort),
            },
            text: {
                verbosity: normalizeVerbosity(request.verbosity),
            },
            tools: [chatPlannerDecisionTool],
            tool_choice: {
                type: 'function',
                name: CHAT_PLANNER_TOOL_NAME,
            },
        });

        const performRequest = async (attempt: number): Promise<Response> => {
            try {
                return await fetch('https://api.openai.com/v1/responses', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: requestBody,
                    signal: request.signal,
                });
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new Error('Planner structured call was aborted');
                }

                if (attempt < retryAttempts) {
                    const backoffMs = 300 * (attempt + 1);
                    await new Promise((resolve) =>
                        setTimeout(resolve, backoffMs)
                    );
                    return performRequest(attempt + 1);
                }

                throw error;
            }
        };

        const response = await performRequest(0);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Planner structured API error: ${response.status} ${response.statusText} - ${errorText}`
            );
        }

        const data = (await response.json()) as {
            model?: string;
            usage?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
            };
            output?: PlannerToolCallOutputItem[];
        };

        const outputItems = Array.isArray(data.output) ? data.output : [];
        const functionCallItem = outputItems.find(
            (item) =>
                item.type === 'function_call' &&
                item.name === CHAT_PLANNER_TOOL_NAME &&
                typeof item.arguments === 'string'
        );

        if (!functionCallItem?.arguments) {
            throw new Error(
                'Planner structured call did not return a function_call payload.'
            );
        }

        let parsedDecision: unknown;
        try {
            parsedDecision = JSON.parse(functionCallItem.arguments) as unknown;
        } catch (error) {
            throw new Error(
                `Failed structured planner argument parsing: ${functionCallItem.arguments}`,
                {
                    cause:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                }
            );
        }
        return {
            decision: parsedDecision,
            model: data.model ?? request.model,
            usage: {
                promptTokens: data.usage?.input_tokens,
                completionTokens: data.usage?.output_tokens,
                totalTokens:
                    data.usage?.total_tokens ??
                    (data.usage?.input_tokens ?? 0) +
                        (data.usage?.output_tokens ?? 0),
            },
            rawArguments: functionCallItem.arguments,
        };
    };
};
