import { createHash } from "node:crypto";

export interface Config {
  publicUrl: URL;
  resourceUrl: string;
  port: number;
  ownerPassword: string;
  encryptionKey: Buffer;
  dataFile: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  allowedRedirectOrigins: string[];
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = new URL(required("PUBLIC_URL", env.PUBLIC_URL));
  publicUrl.pathname = publicUrl.pathname.replace(/\/$/, "");
  if (publicUrl.protocol !== "https:" && publicUrl.hostname !== "localhost") {
    throw new Error("PUBLIC_URL must use HTTPS (except localhost during development)");
  }

  const encryptionKeyText = required("ENCRYPTION_KEY", env.ENCRYPTION_KEY);
  const encryptionKey = Buffer.from(encryptionKeyText, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be exactly 32 bytes encoded as base64");
  }

  return {
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl).toString(),
    port: Number.parseInt(env.PORT ?? "3000", 10),
    ownerPassword: required("OWNER_PASSWORD", env.OWNER_PASSWORD),
    encryptionKey,
    dataFile: env.DATA_FILE ?? "/data/state.json",
    accessTokenTtlSeconds: Number.parseInt(env.ACCESS_TOKEN_TTL_SECONDS ?? "3600", 10),
    refreshTokenTtlSeconds: Number.parseInt(env.REFRESH_TOKEN_TTL_SECONDS ?? "2592000", 10),
    allowedRedirectOrigins: (env.ALLOWED_REDIRECT_ORIGINS ?? "https://chatgpt.com")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

export function ownerPasswordFingerprint(config: Config): string {
  return createHash("sha256").update(config.ownerPassword).digest("hex").slice(0, 12);
}
