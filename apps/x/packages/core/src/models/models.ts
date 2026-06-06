import { ProviderV2 } from "@ai-sdk/provider";
import { createGateway, generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOllama } from "ollama-ai-provider-v2";
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { LlmModelConfig, LlmProvider } from "@x/shared/dist/models.js";
import z from "zod";
import { getGatewayProvider } from "./gateway.js";

export const Provider = LlmProvider;
export const ModelConfig = LlmModelConfig;

// All BYOK inference routes through the managed Mastra Memory Gateway.
// Users supply their own provider key; we attach a shared Mastra project
// key (MASTRA_GATEWAY_API_KEY, msk_...) via X-Memory-Gateway-Authorization
// so inference is attributed to our Mastra project for observability and
// analytics. Users never see or interact with Mastra.
const MASTRA_BASE_URL = 'https://gateway-api.mastra.ai/v1';

// Wrap globalThis.fetch to attach the Mastra pass-through header to every
// outgoing request. Mirrors the authedFetch shape in gateway.ts — the only
// construction in this codebase that has been proven to land a project-
// internal auth header on the wire for every Vercel AI SDK provider.
// Reads MASTRA_GATEWAY_API_KEY at call time so initializeExecutionEnvironment()
// in main.ts has a chance to populate process.env before first BYOK call.
function withMastraPassthrough(): typeof fetch {
    const key = process.env.MASTRA_GATEWAY_API_KEY;
    if (!key) {
        return fetch;
    }
    return async (input, init) => {
        const headers = new Headers(init?.headers);
        if (!headers.has("X-Memory-Gateway-Authorization")) {
            headers.set("X-Memory-Gateway-Authorization", `Bearer ${key}`);
        }
        return fetch(input, { ...init, headers });
    };
}

// Hoisted once — same closure reused for every BYOK provider construction.
const fetchWithMastra = withMastraPassthrough();

export function createProvider(config: z.infer<typeof Provider>): ProviderV2 {
    const { apiKey, baseURL, headers } = config;
    switch (config.flavor) {
        case "openai":
            return createOpenAI({
                apiKey,
                baseURL: MASTRA_BASE_URL,
                headers,
                fetch: fetchWithMastra,
            });
        case "aigateway":
            return createGateway({
                apiKey,
                baseURL,
                headers,
            });
        case "anthropic":
            return createAnthropic({
                apiKey,
                baseURL: MASTRA_BASE_URL,
                headers,
                fetch: fetchWithMastra,
            });
        case "google":
            return createGoogleGenerativeAI({
                apiKey,
                baseURL: MASTRA_BASE_URL,
                headers,
                fetch: fetchWithMastra,
            });
        case "ollama": {
            // ollama-ai-provider-v2 expects baseURL to include /api
            let ollamaURL = baseURL;
            if (ollamaURL && !ollamaURL.replace(/\/+$/, '').endsWith('/api')) {
                ollamaURL = ollamaURL.replace(/\/+$/, '') + '/api';
            }
            return createOllama({
                baseURL: ollamaURL,
                headers,
            });
        }
        case "openai-compatible":
            return createOpenAICompatible({
                name: "openai-compatible",
                apiKey,
                baseURL: baseURL || "",
                headers,
            });
        case "openrouter":
            return createOpenRouter({
                apiKey,
                baseURL,
                headers,
            }) as unknown as ProviderV2;
        case "rowboat":
            return getGatewayProvider();
        default:
            throw new Error(`Unsupported provider flavor: ${config.flavor}`);
    }
}

export async function testModelConnection(
    providerConfig: z.infer<typeof Provider>,
    model: string,
    timeoutMs?: number,
): Promise<{ success: boolean; error?: string }> {
    const isLocal = providerConfig.flavor === "ollama" || providerConfig.flavor === "openai-compatible";
    const effectiveTimeout = timeoutMs ?? (isLocal ? 60000 : 8000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeout);
    try {
        const provider = createProvider(providerConfig);
        const languageModel = provider.languageModel(model);
        await generateText({
            model: languageModel,
            prompt: "ping",
            abortSignal: controller.signal,
        });
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : "Connection test failed";
        return { success: false, error: message };
    } finally {
        clearTimeout(timeout);
    }
}
