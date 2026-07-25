import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { DomainError } from "./domainErrors.js";
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

function sanitizedDetails(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizedDetails(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/(barcode|hash|token|secret|password)/i.test(key))
        .slice(0, 30)
        .map(([key, child]) => [key, sanitizedDetails(child, depth + 1)]),
    );
  }
  return String(value).slice(0, 500);
}

export function errorResult(error: unknown, oauth: OAuthService) {
  const message = error instanceof Error ? error.message : String(error);
  const domainData = error instanceof DomainError ? error.data : undefined;
  const upstreamData = error instanceof InvenTreeError
    ? {
        status: "upstream_error",
        ...(error.status ? { http_status: error.status } : {}),
        ...(error.details === undefined ? {} : { details: sanitizedDetails(error.details) }),
      }
    : undefined;
  const data = domainData ?? upstreamData ?? { status: "error", message };
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
    structuredContent: { data },
    content: [
      {
        type: "text" as const,
        text: message,
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
