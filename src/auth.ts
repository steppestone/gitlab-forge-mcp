import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import {
  OAuthTokensSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const GITLAB_URL = (process.env.GITLAB_URL ?? "https://gitlab.com").replace(/\/$/, "");
const GITLAB_OAUTH_CLIENT_ID = process.env.GITLAB_OAUTH_CLIENT_ID ?? "";
const GITLAB_OAUTH_CLIENT_SECRET = process.env.GITLAB_OAUTH_CLIENT_SECRET ?? "";
export const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");

const ALLOWED_USERS: string[] = (process.env.ALLOWED_GITLAB_USERS ?? "")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  mcpState?: string;
  codeChallenge: string;
}

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  gitlabAccessToken: string;
  gitlabRefreshToken?: string;
  expiresIn?: number;
}

/**
 * OAuth proxy provider that:
 *   - Registers MCP clients in-memory (DCR, since GitLab doesn't support it)
 *   - Proxies the authorization flow to GitLab using our GitLab OAuth App
 *   - Issues MCP authorization codes mapped to the resulting GitLab tokens
 *   - Verifies GitLab access tokens live via /api/v4/user
 */
export class GitLabOAuthProvider implements OAuthServerProvider {
  // Local PKCE validation is done by the SDK auth handler before calling
  // exchangeAuthorizationCode — no need to forward code_verifier to GitLab.
  readonly skipLocalPkceValidation = false;

  private readonly _clients = new Map<string, OAuthClientInformationFull>();
  private readonly _pendingAuths = new Map<string, PendingAuth>();
  private readonly _pendingCodes = new Map<string, PendingCode>();

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this._clients.get(id),
      registerClient: (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret: randomUUID(),
          client_secret_expires_at: 0,
        };
        this._clients.set(full.client_id, full);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const proxyState = randomUUID();
    this._pendingAuths.set(proxyState, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      mcpState: params.state,
      codeChallenge: params.codeChallenge,
    });
    setTimeout(() => this._pendingAuths.delete(proxyState), 10 * 60 * 1000);

    const url = new URL(`${GITLAB_URL}/oauth/authorize`);
    url.searchParams.set("client_id", GITLAB_OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${BASE_URL}/auth/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read_user openid");
    url.searchParams.set("state", proxyState);
    res.redirect(url.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this._pendingCodes.get(authorizationCode)?.codeChallenge ?? "";
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
  ): Promise<OAuthTokens> {
    const pending = this._pendingCodes.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id) {
      throw new Error("Invalid or expired authorization code");
    }
    this._pendingCodes.delete(authorizationCode);
    return OAuthTokensSchema.parse({
      access_token: pending.gitlabAccessToken,
      token_type: "bearer",
      ...(pending.expiresIn !== undefined && { expires_in: pending.expiresIn }),
      ...(pending.gitlabRefreshToken && { refresh_token: pending.gitlabRefreshToken }),
    });
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: GITLAB_OAUTH_CLIENT_ID,
      client_secret: GITLAB_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    const res = await fetch(`${GITLAB_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Refresh token exchange failed: ${res.status}`);
    return OAuthTokensSchema.parse(await res.json());
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const res = await fetch(`${GITLAB_URL}/api/v4/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Token verification failed: ${res.status}`);
    const user = (await res.json()) as { username: string; id: number };
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(user.username.toLowerCase())) {
      throw new Error(`User '${user.username}' is not authorized`);
    }
    return {
      token,
      clientId: "gitlab",
      scopes: ["read_user"],
      extra: { username: user.username },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const body = new URLSearchParams({
      token: request.token,
      client_id: GITLAB_OAUTH_CLIENT_ID,
      client_secret: GITLAB_OAUTH_CLIENT_SECRET,
    });
    if (request.token_type_hint) body.set("token_type_hint", request.token_type_hint);
    await fetch(`${GITLAB_URL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  /** Express route handler for the GitLab OAuth callback at /auth/callback */
  async handleCallback(req: Request, res: Response): Promise<void> {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (error) {
      res.status(400).send(`GitLab OAuth error: ${error}${error_description ? ` — ${error_description}` : ""}`);
      return;
    }
    if (!code || !state) {
      res.status(400).send("Missing code or state");
      return;
    }

    const pending = this._pendingAuths.get(state);
    if (!pending) {
      res.status(400).send("Invalid or expired OAuth state");
      return;
    }
    this._pendingAuths.delete(state);

    // Exchange the GitLab auth code for a GitLab token
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: GITLAB_OAUTH_CLIENT_ID,
      client_secret: GITLAB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}/auth/callback`,
    });
    const tokenRes = await fetch(`${GITLAB_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      res.status(502).send(`GitLab token exchange failed: ${tokenRes.status}`);
      return;
    }
    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    // Verify user identity + allowlist
    const userRes = await fetch(`${GITLAB_URL}/api/v4/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) {
      res.status(502).send("Failed to fetch user info from GitLab");
      return;
    }
    const user = (await userRes.json()) as { username: string };
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(user.username.toLowerCase())) {
      res.status(403).send(`User '${user.username}' is not authorized`);
      return;
    }

    // Issue an MCP authorization code backed by the GitLab token
    const mcpCode = randomUUID();
    this._pendingCodes.set(mcpCode, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      gitlabAccessToken: tokenData.access_token,
      gitlabRefreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
    });
    setTimeout(() => this._pendingCodes.delete(mcpCode), 5 * 60 * 1000);

    // Redirect back to the MCP client's redirect_uri
    const callbackUrl = new URL(pending.redirectUri);
    callbackUrl.searchParams.set("code", mcpCode);
    if (pending.mcpState) callbackUrl.searchParams.set("state", pending.mcpState);
    res.redirect(callbackUrl.toString());
  }
}
