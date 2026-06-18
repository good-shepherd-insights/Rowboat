import * as client from 'openid-client';
import { OAuthTokens, ClientRegistrationResponse } from './types.js';
import { rootLogger } from '@x/shared';

const log = rootLogger.child('OAuth');


/**
 * Cached configurations per provider (issuer:clientId -> Configuration)
 */
const configCache = new Map<string, client.Configuration>();

/**
 * Helper to convert openid-client token response to our OAuthTokens type
 */
function toOAuthTokens(response: client.TokenEndpointResponse): OAuthTokens {
  const accessToken = response.access_token;
  const refreshToken = response.refresh_token ?? null;

  // Calculate expires_at from expires_in
  const expiresIn = response.expires_in ?? 3600;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  // Parse scopes from space-separated string
  let scopes: string[] | undefined;
  if (response.scope) {
    scopes = response.scope.split(' ').filter(s => s.length > 0);
  }

  return OAuthTokens.parse({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    token_type: 'Bearer',
    scopes,
  });
}

/**
 * Discover authorization server metadata and create configuration
 */
export async function discoverConfiguration(
  issuerUrl: string,
  clientId: string,
  clientSecret?: string
): Promise<client.Configuration> {
  const cacheKey = `${issuerUrl}:${clientId}:${clientSecret ? 'secret' : 'none'}`;

  const cached = configCache.get(cacheKey);
  if (cached) {
    log.debug(`Using cached configuration for ${issuerUrl}`);
    return cached;
  }
  log.debug(`Discovering authorization server metadata for ${issuerUrl}...`);
  const config = await client.discovery(
    new URL(issuerUrl),
    clientId,
    clientSecret ?? undefined,
    clientSecret ? client.ClientSecretPost(clientSecret) : client.None(),
    {
      execute: [client.allowInsecureRequests],
    }
  );

  configCache.set(cacheKey, config);
  log.debug(`Discovery complete for ${issuerUrl}`);
  return config;
}

/**
 * Create configuration from static endpoints (no discovery)
 */
export function createStaticConfiguration(
  authorizationEndpoint: string,
  tokenEndpoint: string,
  clientId: string,
  revocationEndpoint?: string,
  clientSecret?: string
): client.Configuration {
  log.debug(`Creating static configuration (no discovery)`);

  const issuer = new URL(authorizationEndpoint).origin;

  // Create Configuration with static metadata
  const serverMetadata: client.ServerMetadata = {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    revocation_endpoint: revocationEndpoint,
  };

  return new client.Configuration(
    serverMetadata,
    clientId,
    clientSecret ?? undefined,
    clientSecret ? client.ClientSecretPost(clientSecret) : client.None()
  );
}

/**
 * Register client via Dynamic Client Registration (RFC 7591)
 * Returns both the Configuration and the registration response (for persistence)
 */
export async function registerClient(
  issuerUrl: string,
  redirectUris: string[],
  scopes: string[],
  clientName: string = 'RowboatX Desktop App'
): Promise<{ config: client.Configuration; registration: ClientRegistrationResponse }> {
  log.debug(`Registering client via DCR at ${issuerUrl}...`);
  const config = await client.dynamicClientRegistration(
    new URL(issuerUrl),
    {
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none', // PKCE flow
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: clientName,
      scope: scopes.join(' '),
    },
    client.None(),
    {
      execute: [client.allowInsecureRequests],
    },
  );

  const metadata = config.clientMetadata();
  log.debug(`DCR complete, client_id: ${metadata.client_id}`);

  // Extract registration response for persistence
  const registration = ClientRegistrationResponse.parse({
    client_id: metadata.client_id,
    client_secret: metadata.client_secret,
    client_id_issued_at: metadata.client_id_issued_at,
    client_secret_expires_at: metadata.client_secret_expires_at,
  });

  // Cache the configuration
  const cacheKey = `${issuerUrl}:${metadata.client_id}`;
  configCache.set(cacheKey, config);

  return { config, registration };
}

/**
 * Generate PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  return { verifier, challenge };
}

/**
 * Generate random state for CSRF protection
 */
export function generateState(): string {
  return client.randomState();
}

/**
 * Build authorization URL with PKCE
 */
export function buildAuthorizationUrl(
  config: client.Configuration,
  params: Record<string, string>
): URL {
  return client.buildAuthorizationUrl(config, {
    code_challenge_method: 'S256',
    ...params,
  });
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  config: client.Configuration,
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string
): Promise<OAuthTokens> {
  log.debug(`Exchanging authorization code for tokens...`);

  const response = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState,
  });

  log.debug(`Token exchange successful`);
  return toOAuthTokens(response);
}

/**
 * Refresh access token using refresh token
 * Preserves existing scopes if not returned by server
 */
export async function refreshTokens(
  config: client.Configuration,
  refreshToken: string,
  existingScopes?: string[]
): Promise<OAuthTokens> {
  log.debug(`Refreshing access token...`);

  const response = await client.refreshTokenGrant(config, refreshToken);

  const tokens = toOAuthTokens(response);

  // Preserve existing scopes if server didn't return them
  if (!tokens.scopes && existingScopes) {
    tokens.scopes = existingScopes;
  }

  // Preserve existing refresh token if server didn't return it
  if (!tokens.refresh_token) {
    tokens.refresh_token = refreshToken;
  }

  log.debug(`Token refresh successful`);
  return tokens;
}

const EXPIRY_MARGIN_SECONDS = 60;

/**
 * Check if tokens are expired. Treats tokens as expired EXPIRY_MARGIN_SECONDS
 * before the real expiry to absorb clock skew and in-flight request latency.
 */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  const now = Math.floor(Date.now() / 1000);
  return tokens.expires_at <= now + EXPIRY_MARGIN_SECONDS;
}

/**
 * Clear configuration cache for a specific provider or all providers
 */
export function clearConfigCache(issuerUrl?: string, clientId?: string): void {
  if (issuerUrl && clientId) {
    configCache.delete(`${issuerUrl}:${clientId}`);
    log.debug(`Cleared configuration cache for ${issuerUrl}`);
  } else {
    configCache.clear();
    log.debug(`Cleared all configuration cache`);
  }
}

/**
 * Get cached configuration if available
 */
export function getCachedConfiguration(issuerUrl: string, clientId: string): client.Configuration | undefined {
  return configCache.get(`${issuerUrl}:${clientId}`);
}

// Re-export Configuration type for external use
export type { Configuration } from 'openid-client';

