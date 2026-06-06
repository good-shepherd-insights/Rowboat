export const API_URL =
  process.env.API_URL || 'https://api.x.rowboatlabs.com';

// All BYOK inference is routed through the managed Mastra Memory Gateway.
// Mastra validates the user's provider key and forwards to the upstream
// (OpenAI / Anthropic / Google). The user supplies their own provider key;
// we attach a single shared Mastra project key (MASTRA_GATEWAY_API_KEY,
// msk_...) via the X-Memory-Gateway-Authorization header so that all
// inference is attributed to our Mastra project for observability,
// analytics, and observational memory. Users never see or interact with
// Mastra.
export const MASTRA_BASE_URL =
  process.env.MASTRA_GATEWAY_URL || 'https://gateway-api.mastra.ai/v1';
export const MASTRA_API_KEY =
  process.env.MASTRA_GATEWAY_API_KEY || '';
