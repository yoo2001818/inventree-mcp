import type { Request, Response, Router } from "express";
import express from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Config } from "./config.js";
import { decrypt, encrypt, hashToken, pkceS256, randomToken, secureEqual } from "./crypto.js";
import { authorizationPage } from "./html.js";
import { InvenTreeClient } from "./inventree.js";
import { JsonStore, type PendingAuthorization } from "./store.js";

const ALLOWED_SCOPES = new Set(["inventree.read", "inventree.write"]);

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function parseScopes(value: unknown): string[] {
  const scopes = String(value ?? "inventree.read inventree.write")
    .split(/\s+/)
    .filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new Error("Unsupported scope requested");
  }
  return [...new Set(scopes)];
}

export class OAuthService {
  readonly router: Router;
  private readonly failedOwnerAttempts = new Map<string, { count: number; resetAt: number }>();
  private readonly registrationAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly config: Config,
    readonly store: JsonStore,
  ) {
    this.router = express.Router();
    this.registerRoutes();
  }

  metadata() {
    const issuer = this.config.publicUrl.origin;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...ALLOWED_SCOPES],
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.config.resourceUrl,
      authorization_servers: [this.config.publicUrl.origin],
      scopes_supported: [...ALLOWED_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: `${this.config.publicUrl.origin}/`,
    };
  }

  verifyAccessToken(token: string): AuthInfo {
    this.store.cleanup();
    const stored = this.store.snapshot.accessTokens[hashToken(token)];
    if (!stored || stored.expiresAt <= Date.now()) throw new Error("Invalid or expired access token");
    if (stored.resource !== this.config.resourceUrl) throw new Error("Invalid token audience");
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scope,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: new URL(stored.resource),
      extra: { credentialsId: stored.credentialsId },
    };
  }

  getCredentials(authInfo: AuthInfo): { baseUrl: string; apiToken: string } {
    const credentialsId = String(authInfo.extra?.credentialsId ?? "");
    return this.getCredentialsById(credentialsId);
  }

  getCredentialsById(credentialsId: string): { baseUrl: string; apiToken: string } {
    const stored = this.store.snapshot.credentials[credentialsId];
    if (!stored) throw new Error("Linked InvenTree credentials no longer exist");
    return {
      baseUrl: this.config.inventreeUrl,
      apiToken: decrypt(stored.encryptedApiToken, this.config.encryptionKey),
    };
  }

  private registerRoutes(): void {
    this.router.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(this.metadata()));
    this.router.get("/.well-known/openid-configuration", (_req, res) => res.json(this.metadata()));
    this.router.get("/.well-known/oauth-protected-resource", (_req, res) =>
      res.json(this.protectedResourceMetadata()),
    );
    this.router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) =>
      res.json(this.protectedResourceMetadata()),
    );
    this.router.post("/oauth/register", (req, res) => this.registerClient(req, res));
    this.router.get("/oauth/authorize", (req, res) => this.beginAuthorization(req, res));
    this.router.post("/oauth/authorize", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) =>
      this.completeAuthorization(req, res),
    );
    this.router.post("/oauth/token", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) =>
      this.exchangeToken(req, res),
    );
    this.router.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) =>
      this.revokeToken(req, res),
    );
  }

  private registerClient(req: Request, res: Response): void {
    const attemptKey = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const attempts = this.registrationAttempts.get(attemptKey);
    if (attempts && attempts.count >= 30 && attempts.resetAt > Date.now()) {
      oauthError(res, 429, "temporarily_unavailable", "Dynamic client registration rate limit reached");
      return;
    }
    this.registrationAttempts.set(attemptKey, {
      count: (attempts?.resetAt ?? 0) > Date.now() ? attempts!.count + 1 : 1,
      resetAt: Date.now() + 60 * 60_000,
    });
    if (Object.keys(this.store.snapshot.clients).length >= 1_000) {
      oauthError(res, 429, "temporarily_unavailable", "Registered OAuth client limit reached");
      return;
    }
    const redirectUris = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      oauthError(res, 400, "invalid_client_metadata", "redirect_uris must be a non-empty array");
      return;
    }
    try {
      for (const value of redirectUris) this.assertAllowedRedirectUri(String(value));
    } catch (error) {
      oauthError(res, 400, "invalid_redirect_uri", (error as Error).message);
      return;
    }

    const clientId = randomToken(24);
    const client = {
      clientId,
      redirectUris: redirectUris.map(String),
      clientName: typeof req.body.client_name === "string" ? req.body.client_name.slice(0, 100) : undefined,
      createdAt: Date.now(),
    };
    this.store.mutate((data) => {
      data.clients[clientId] = client;
    });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  private beginAuthorization(req: Request, res: Response): void {
    try {
      const pending = this.validateAuthorizationRequest(req.query);
      this.store.mutate((data) => {
        data.pendingAuthorizations[pending.id] = pending;
      });
      const client = this.store.snapshot.clients[pending.clientId];
      res.type("html").send(
        authorizationPage({
          requestId: pending.id,
          clientName: client?.clientName ?? "ChatGPT",
          scopes: pending.scope,
        }),
      );
    } catch (error) {
      res.status(400).type("text").send(`Invalid authorization request: ${(error as Error).message}`);
    }
  }

  private async completeAuthorization(req: Request, res: Response): Promise<void> {
    const requestId = String(req.body.request_id ?? "");
    const pending = this.store.snapshot.pendingAuthorizations[requestId];
    if (!pending || pending.expiresAt <= Date.now()) {
      res.status(400).type("text").send("Authorization request expired. Start the connection again.");
      return;
    }
    const client = this.store.snapshot.clients[pending.clientId];
    const renderError = (message: string) =>
      res.status(400).type("html").send(
        authorizationPage({
          requestId,
          clientName: client?.clientName ?? "ChatGPT",
          scopes: pending.scope,
          error: message,
        }),
      );

    const attemptKey = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const attempts = this.failedOwnerAttempts.get(attemptKey);
    if (attempts && attempts.count >= 10 && attempts.resetAt > Date.now()) {
      renderError("Too many failed owner-password attempts. Try again later.");
      return;
    }
    if (!secureEqual(String(req.body.owner_password ?? ""), this.config.ownerPassword)) {
      this.failedOwnerAttempts.set(attemptKey, {
        count: (attempts?.resetAt ?? 0) > Date.now() ? attempts!.count + 1 : 1,
        resetAt: Date.now() + 15 * 60_000,
      });
      renderError("Incorrect bridge owner password.");
      return;
    }
    this.failedOwnerAttempts.delete(attemptKey);

    try {
      const apiToken = String(req.body.api_token ?? "").trim();
      if (!apiToken) throw new Error("InvenTree API token is required");
      const connection = await new InvenTreeClient({
        baseUrl: this.config.inventreeUrl,
        apiToken,
      }).testConnection();
      const credentialsId = randomToken(18);
      const code = randomToken(32);
      const now = Date.now();
      this.store.mutate((data) => {
        delete data.pendingAuthorizations[requestId];
        data.credentials[credentialsId] = {
          id: credentialsId,
          encryptedApiToken: encrypt(apiToken, this.config.encryptionKey),
          label: connection.username,
          createdAt: now,
          updatedAt: now,
        };
        data.authorizationCodes[hashToken(code)] = {
          codeHash: hashToken(code),
          clientId: pending.clientId,
          redirectUri: pending.redirectUri,
          scope: pending.scope,
          resource: pending.resource,
          codeChallenge: pending.codeChallenge,
          credentialsId,
          expiresAt: now + 5 * 60_000,
        };
      });
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set("code", code);
      if (pending.state) redirect.searchParams.set("state", pending.state);
      res.redirect(303, redirect.toString());
    } catch (error) {
      renderError((error as Error).message);
    }
  }

  private exchangeToken(req: Request, res: Response): void {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    const grantType = String(req.body.grant_type ?? "");
    if (grantType === "authorization_code") {
      this.exchangeAuthorizationCode(req, res);
    } else if (grantType === "refresh_token") {
      this.exchangeRefreshToken(req, res);
    } else {
      oauthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
    }
  }

  private exchangeAuthorizationCode(req: Request, res: Response): void {
    const code = String(req.body.code ?? "");
    const stored = this.store.snapshot.authorizationCodes[hashToken(code)];
    if (!stored || stored.expiresAt <= Date.now()) {
      oauthError(res, 400, "invalid_grant", "Invalid or expired authorization code");
      return;
    }
    if (
      stored.clientId !== String(req.body.client_id ?? "") ||
      stored.redirectUri !== String(req.body.redirect_uri ?? "") ||
      stored.resource !== String(req.body.resource ?? "") ||
      pkceS256(String(req.body.code_verifier ?? "")) !== stored.codeChallenge
    ) {
      oauthError(res, 400, "invalid_grant", "Authorization code validation failed");
      return;
    }
    this.store.mutate((data) => delete data.authorizationCodes[stored.codeHash]);
    this.issueTokens(res, stored);
  }

  private exchangeRefreshToken(req: Request, res: Response): void {
    const rawToken = String(req.body.refresh_token ?? "");
    const stored = this.store.snapshot.refreshTokens[hashToken(rawToken)];
    if (!stored || stored.expiresAt <= Date.now() || stored.clientId !== String(req.body.client_id ?? "")) {
      oauthError(res, 400, "invalid_grant", "Invalid or expired refresh token");
      return;
    }
    if (String(req.body.resource ?? "") !== stored.resource) {
      oauthError(res, 400, "invalid_target", "Refresh token is not valid for that resource");
      return;
    }
    this.store.mutate((data) => delete data.refreshTokens[stored.tokenHash]);
    this.issueTokens(res, stored);
  }

  private issueTokens(
    res: Response,
    input: { clientId: string; credentialsId: string; scope: string[]; resource: string },
  ): void {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(40);
    const now = Date.now();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds * 1000;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds * 1000;
    this.store.mutate((data) => {
      data.accessTokens[hashToken(accessToken)] = {
        tokenHash: hashToken(accessToken),
        ...input,
        expiresAt: accessExpiresAt,
      };
      data.refreshTokens[hashToken(refreshToken)] = {
        tokenHash: hashToken(refreshToken),
        ...input,
        expiresAt: refreshExpiresAt,
      };
    });
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: input.scope.join(" "),
    });
  }

  private revokeToken(req: Request, res: Response): void {
    const tokenHash = hashToken(String(req.body.token ?? ""));
    this.store.mutate((data) => {
      delete data.accessTokens[tokenHash];
      delete data.refreshTokens[tokenHash];
    });
    res.status(200).end();
  }

  private validateAuthorizationRequest(query: Request["query"]): PendingAuthorization {
    if (query.response_type !== "code") throw new Error("response_type must be code");
    const clientId = String(query.client_id ?? "");
    const client = this.store.snapshot.clients[clientId];
    if (!client) throw new Error("Unknown client_id");
    const redirectUri = String(query.redirect_uri ?? "");
    if (!client.redirectUris.includes(redirectUri)) throw new Error("redirect_uri is not registered");
    if (query.code_challenge_method !== "S256") throw new Error("PKCE S256 is required");
    const codeChallenge = String(query.code_challenge ?? "");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) throw new Error("Invalid PKCE code_challenge");
    const resource = String(query.resource ?? "");
    if (resource !== this.config.resourceUrl) throw new Error("Invalid resource target");
    return {
      id: randomToken(24),
      clientId,
      redirectUri,
      state: typeof query.state === "string" ? query.state : undefined,
      scope: parseScopes(query.scope),
      resource,
      codeChallenge,
      expiresAt: Date.now() + 10 * 60_000,
    };
  }

  private assertAllowedRedirectUri(value: string): void {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    const loopbackPattern = `http://${url.hostname}:*`;
    if (
      !this.config.allowedRedirectOrigins.includes(url.origin) &&
      !(isLoopbackHttp && this.config.allowedRedirectOrigins.includes(loopbackPattern))
    ) {
      throw new Error(`Redirect origin ${url.origin} is not allowed`);
    }
    if (url.protocol !== "https:" && !isLoopbackHttp) {
      throw new Error("Redirect URI must use HTTPS or an HTTP loopback address");
    }
    if (
      url.origin === "https://chatgpt.com" &&
      !url.pathname.startsWith("/connector/oauth/") &&
      url.pathname !== "/connector_platform_oauth_redirect"
    ) {
      throw new Error("ChatGPT redirect URI is not a recognized connector callback");
    }
  }
}
