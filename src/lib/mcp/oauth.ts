import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.1 helpers for MCP connectors. Implements the discovery + dynamic
 * registration + PKCE authorization-code flow used by remote MCP
 * servers (RFC 9728 protected-resource metadata, RFC 8414 AS metadata,
 * RFC 7591 dynamic client registration, RFC 7636 PKCE, RFC 8707 resource
 * indicators). Every network call uses fetch with a 10s timeout.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Resolved OAuth endpoints for a connector's authorization server. */
export interface OAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** The protected resource (the MCP url), sent as RFC 8707 `resource`. */
  resource?: string;
  scopesSupported?: string[];
}

/** Token-endpoint response, normalized. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  tokenType?: string;
  scope?: string;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the `resource_metadata` parameter out of a WWW-Authenticate header. */
function parseResourceMetadataUrl(
  wwwAuthenticate?: string | null,
): string | null {
  if (!wwwAuthenticate) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate);
  return match ? match[1] : null;
}

/**
 * Discover the connector's authorization server endpoints. Returns null if the
 * flow can't be completed (so callers can surface an error gracefully).
 */
export async function discoverOAuth(
  mcpUrl: string,
  wwwAuthenticate?: string | null,
): Promise<OAuthMetadata | null> {
  const origin = new URL(mcpUrl).origin;

  // 1. Protected-resource metadata (RFC 9728).
  const prmUrl =
    parseResourceMetadataUrl(wwwAuthenticate) ??
    `${origin}/.well-known/oauth-protected-resource`;

  let authServer: string | null = null;
  const prm = await fetchJson(prmUrl);
  if (prm.ok && prm.body && typeof prm.body === "object") {
    const servers = (prm.body as { authorization_servers?: unknown })
      .authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      authServer = servers[0];
    }
  }
  // Fall back to treating the MCP origin as the authorization server.
  if (!authServer) authServer = origin;

  // 2. Authorization-server metadata (RFC 8414), with OIDC fallback.
  const asOrigin = new URL(authServer).origin;
  const asPathname = new URL(authServer).pathname.replace(/\/$/, "");
  const candidates = [
    `${asOrigin}/.well-known/oauth-authorization-server${asPathname}`,
    `${asOrigin}/.well-known/oauth-authorization-server`,
    `${asOrigin}/.well-known/openid-configuration${asPathname}`,
    `${asOrigin}/.well-known/openid-configuration`,
  ];

  for (const candidate of candidates) {
    const asm = await fetchJson(candidate);
    if (!asm.ok || !asm.body || typeof asm.body !== "object") continue;
    const meta = asm.body as {
      authorization_endpoint?: unknown;
      token_endpoint?: unknown;
      registration_endpoint?: unknown;
      scopes_supported?: unknown;
    };
    if (
      typeof meta.authorization_endpoint === "string" &&
      typeof meta.token_endpoint === "string"
    ) {
      return {
        authorizationEndpoint: meta.authorization_endpoint,
        tokenEndpoint: meta.token_endpoint,
        registrationEndpoint:
          typeof meta.registration_endpoint === "string"
            ? meta.registration_endpoint
            : undefined,
        resource: mcpUrl,
        scopesSupported: Array.isArray(meta.scopes_supported)
          ? meta.scopes_supported.filter(
              (s): s is string => typeof s === "string",
            )
          : undefined,
      };
    }
  }

  return null;
}

/**
 * RFC 7591 dynamic client registration. Throws if the AS exposes no
 * registration endpoint.
 */
export async function registerClient(
  meta: OAuthMetadata,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!meta.registrationEndpoint) {
    throw new Error(
      "OAuth dynamic client registration is not supported by this server " +
        "(no registration_endpoint).",
    );
  }
  const result = await fetchJson(meta.registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_name: "OpenAgent Connector",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!result.ok || !result.body || typeof result.body !== "object") {
    throw new Error(
      `OAuth client registration failed with status ${result.status}.`,
    );
  }
  const body = result.body as {
    client_id?: unknown;
    client_secret?: unknown;
  };
  if (typeof body.client_id !== "string") {
    throw new Error("OAuth client registration returned no client_id.");
  }
  return {
    clientId: body.client_id,
    clientSecret:
      typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate a PKCE (S256) verifier/challenge pair, base64url-encoded. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Generate a random base64url CSRF state value. */
export function generateState(): string {
  return base64url(randomBytes(32));
}

/** Build the authorization-endpoint URL for the PKCE flow. */
export function buildAuthorizeUrl(
  meta: OAuthMetadata,
  p: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope?: string;
  },
): string {
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (meta.resource) url.searchParams.set("resource", meta.resource);
  if (p.scope) url.searchParams.set("scope", p.scope);
  return url.toString();
}

function normalizeTokens(body: unknown): OAuthTokens {
  if (!body || typeof body !== "object") {
    throw new Error("OAuth token endpoint returned an empty response.");
  }
  const b = body as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
    scope?: unknown;
  };
  if (typeof b.access_token !== "string") {
    throw new Error("OAuth token endpoint returned no access_token.");
  }
  return {
    accessToken: b.access_token,
    refreshToken:
      typeof b.refresh_token === "string" ? b.refresh_token : undefined,
    expiresInSec:
      typeof b.expires_in === "number" ? b.expires_in : undefined,
    tokenType: typeof b.token_type === "string" ? b.token_type : undefined,
    scope: typeof b.scope === "string" ? b.scope : undefined,
  };
}

async function tokenRequest(
  meta: OAuthMetadata,
  params: Record<string, string>,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const form = new URLSearchParams(params);
  if (meta.resource) form.set("resource", meta.resource);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (clientSecret) {
    // Confidential client: HTTP Basic with client_id + secret.
    const basic = Buffer.from(
      `${encodeURIComponent(params.client_id)}:${encodeURIComponent(
        clientSecret,
      )}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }
  // Public client (token_endpoint_auth_method=none): client_id stays in body.

  const result = await fetchJson(meta.tokenEndpoint, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  if (!result.ok) {
    const detail =
      result.body && typeof result.body === "object"
        ? JSON.stringify(result.body)
        : String(result.body ?? "");
    throw new Error(
      `OAuth token request failed with status ${result.status}: ${detail}`,
    );
  }
  return normalizeTokens(result.body);
}

/** Exchange an authorization code for tokens (PKCE). */
export async function exchangeCode(
  meta: OAuthMetadata,
  p: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<OAuthTokens> {
  return tokenRequest(
    meta,
    {
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.codeVerifier,
    },
    p.clientSecret,
  );
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  meta: OAuthMetadata,
  p: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  },
): Promise<OAuthTokens> {
  return tokenRequest(
    meta,
    {
      grant_type: "refresh_token",
      refresh_token: p.refreshToken,
      client_id: p.clientId,
    },
    p.clientSecret,
  );
}
