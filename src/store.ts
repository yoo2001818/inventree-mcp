import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EncryptedValue } from "./crypto.js";

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

export interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string[];
  resource: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface AuthorizationCode extends Omit<PendingAuthorization, "id" | "state" | "expiresAt"> {
  codeHash: string;
  credentialsId: string;
  expiresAt: number;
}

export interface StoredCredentials {
  id: string;
  inventreeUrl: string;
  encryptedApiToken: EncryptedValue;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredAccessToken {
  tokenHash: string;
  clientId: string;
  credentialsId: string;
  scope: string[];
  resource: string;
  expiresAt: number;
}

export interface StoredRefreshToken extends Omit<StoredAccessToken, "tokenHash"> {
  tokenHash: string;
}

interface StoreData {
  version: 1;
  clients: Record<string, OAuthClient>;
  pendingAuthorizations: Record<string, PendingAuthorization>;
  authorizationCodes: Record<string, AuthorizationCode>;
  credentials: Record<string, StoredCredentials>;
  accessTokens: Record<string, StoredAccessToken>;
  refreshTokens: Record<string, StoredRefreshToken>;
}

function emptyStore(): StoreData {
  return {
    version: 1,
    clients: {},
    pendingAuthorizations: {},
    authorizationCodes: {},
    credentials: {},
    accessTokens: {},
    refreshTokens: {},
  };
}

export class JsonStore {
  private data: StoreData;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(file, "utf8")) as StoreData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = emptyStore();
      this.persist();
    }
    this.cleanup();
  }

  get snapshot(): Readonly<StoreData> {
    return this.data;
  }

  mutate(callback: (data: StoreData) => void): void {
    callback(this.data);
    this.persist();
  }

  cleanup(now = Date.now()): void {
    this.mutate((data) => {
      for (const collection of [
        data.pendingAuthorizations,
        data.authorizationCodes,
        data.accessTokens,
        data.refreshTokens,
      ]) {
        for (const [key, value] of Object.entries(collection)) {
          if (value.expiresAt <= now) delete collection[key];
        }
      }
    });
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
