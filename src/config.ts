import { createHash } from "node:crypto";
import { normalizeInvenTreeUrl } from "./inventree.js";

export interface Config {
  publicUrl: URL;
  resourceUrl: string;
  inventreeUrl: string;
  bindHost: string;
  port: number;
  ownerPassword: string;
  encryptionKey: Buffer;
  dataFile: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  allowedRedirectOrigins: string[];
  allowedMcpOrigins: string[];
  enableRawWrite: boolean;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactOrigins(name: string, value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(`${name} entries must be exact HTTP(S) origins without paths`);
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
        throw new Error(`${name} entries must be exact HTTP(S) origins without paths`);
      }
      return origin;
    });
}

const LOOPBACK_REDIRECT_PATTERNS = new Set([
  "http://localhost:*",
  "http://127.0.0.1:*",
]);

function redirectOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      if (LOOPBACK_REDIRECT_PATTERNS.has(origin)) return origin;

      const [exactOrigin] = exactOrigins("ALLOWED_REDIRECT_ORIGINS", origin);
      const url = new URL(exactOrigin!);
      const isLoopbackHttp =
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1");
      if (url.protocol !== "https:" && !isLoopbackHttp) {
        throw new Error(
          "ALLOWED_REDIRECT_ORIGINS entries must use HTTPS or an HTTP loopback origin",
        );
      }
      return exactOrigin!;
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = new URL(required("PUBLIC_URL", env.PUBLIC_URL));
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin without a path, query, or fragment");
  }
  if (publicUrl.protocol !== "https:" && publicUrl.hostname !== "localhost") {
    throw new Error("PUBLIC_URL must use HTTPS (except localhost during development)");
  }

  const encryptionKeyText = required("ENCRYPTION_KEY", env.ENCRYPTION_KEY);
  const encryptionKey = Buffer.from(encryptionKeyText, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be exactly 32 bytes encoded as base64");
  }

  const ownerPassword = required("OWNER_PASSWORD", env.OWNER_PASSWORD);
  if (Buffer.byteLength(ownerPassword, "utf8") < 16) {
    throw new Error("OWNER_PASSWORD must be at least 16 bytes long");
  }

  const inventreeUrl = normalizeInvenTreeUrl(required("INVENTREE_URL", env.INVENTREE_URL));
  const allowedRedirectOrigins = redirectOrigins(
    env.ALLOWED_REDIRECT_ORIGINS ??
      "https://chatgpt.com,http://localhost:*,http://127.0.0.1:*",
  );

  return {
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl).toString(),
    inventreeUrl,
    bindHost: env.BIND_HOST?.trim() || "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    ownerPassword,
    encryptionKey,
    dataFile: env.DATA_FILE ?? "/data/state.json",
    accessTokenTtlSeconds: Number.parseInt(env.ACCESS_TOKEN_TTL_SECONDS ?? "3600", 10),
    refreshTokenTtlSeconds: Number.parseInt(env.REFRESH_TOKEN_TTL_SECONDS ?? "2592000", 10),
    allowedRedirectOrigins,
    allowedMcpOrigins: exactOrigins(
      "ALLOWED_MCP_ORIGINS",
      env.ALLOWED_MCP_ORIGINS ?? "https://chatgpt.com",
    ),
    enableRawWrite: env.ENABLE_RAW_WRITE?.trim().toLowerCase() === "true",
  };
}

export function ownerPasswordFingerprint(config: Pick<Config, "ownerPassword">): string {
  return createHash("sha256").update(config.ownerPassword).digest("hex").slice(0, 12);
}
