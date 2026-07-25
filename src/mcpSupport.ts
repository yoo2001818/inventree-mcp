import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvenTreeClient, InvenTreeError } from "./inventree.js";
import type { OAuthService } from "./oauth.js";

export const READ_SECURITY = [{ type: "oauth2", scopes: ["inventree.read"] }];
export const WRITE_SECURITY = [{ type: "oauth2", scopes: ["inventree.write"] }];

export class BridgeScopeError extends Error {
  constructor(readonly scope: string) {
    super(`OAuth scope ${scope} is required`);
  }
}

export function requireAuth(authInfo: AuthInfo | undefined, scope: string): AuthInfo {
  if (!authInfo) throw new BridgeScopeError(scope);
  if (!authInfo.scopes.includes(scope)) throw new BridgeScopeError(scope);
  return authInfo;
}

export function clientFor(
  oauth: OAuthService,
  authInfo: AuthInfo | undefined,
  scope: string,
): { auth: AuthInfo; client: InvenTreeClient } {
  const auth = requireAuth(authInfo, scope);
  return { auth, client: new InvenTreeClient(oauth.getCredentials(auth)) };
}

export function result(data: unknown, message: string) {
  return {
    structuredContent: { data },
    content: [{ type: "text" as const, text: message }],
  };
}

export function errorResult(error: unknown, oauth: OAuthService) {
  const details = error instanceof InvenTreeError ? error.details : undefined;
  const challenge =
    error instanceof BridgeScopeError
      ? {
          "mcp/www_authenticate": [
            `Bearer resource_metadata="${oauth.config.publicUrl.origin}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="${error.message}", scope="${error.scope}"`,
          ],
        }
      : undefined;
  return {
    isError: true,
    structuredContent: { error: (error as Error).message, details },
    content: [
      {
        type: "text" as const,
        text: details
          ? `${(error as Error).message}: ${JSON.stringify(details).slice(0, 2_000)}`
          : (error as Error).message,
      },
    ],
    ...(challenge ? { _meta: challenge } : {}),
  };
}

export async function safely<T>(
  oauth: OAuthService,
  callback: () => Promise<T>,
): Promise<T | ReturnType<typeof errorResult>> {
  try {
    return await callback();
  } catch (error) {
    return errorResult(error, oauth);
  }
}
