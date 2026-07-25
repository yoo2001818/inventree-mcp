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

export interface MutationRequest {
  method: "POST" | "PATCH" | "PUT";
  path: string | MutationPathSegment[];
  body: unknown;
  imageUpload?: {
    uploadRef: string;
    field: "image";
  };
}

export type MutationPathSegment = string | { __planRef: string };

export interface MutationCheck {
  path: string;
  query?: Record<string, unknown>;
  digest: string;
}

export type InventoryEntityType = "part" | "stock_item" | "part_category" | "stock_location";

export interface MutationOutput {
  ref: string;
  name: string;
  entityType: InventoryEntityType;
  requestIndex: number;
  responsePaths: Array<Array<string | number>>;
  display: string;
  metadata?: Record<string, unknown>;
}

export interface MutationStep {
  id: string;
  operationId: string;
  summary: string;
  requests: MutationRequest[];
  checks: MutationCheck[];
  outputs: MutationOutput[];
  createdAt: number;
}

export interface MutationCommitResult {
  status: "committed" | "failed";
  completedSteps: number;
  completedRequests: number;
  resolvedRefs: Record<string, number | string>;
  resultIds: number[];
  failedStepId?: string;
  error?: string;
}

export interface MutationPlan {
  id: string;
  credentialsId: string;
  version: number;
  state: "staging" | "committing" | "committed" | "failed";
  steps: MutationStep[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  commitResult?: MutationCommitResult;
}

export interface StoreData {
  version: 1;
  clients: Record<string, OAuthClient>;
  pendingAuthorizations: Record<string, PendingAuthorization>;
  authorizationCodes: Record<string, AuthorizationCode>;
  credentials: Record<string, StoredCredentials>;
  accessTokens: Record<string, StoredAccessToken>;
  refreshTokens: Record<string, StoredRefreshToken>;
  mutationPlans: Record<string, MutationPlan>;
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
    mutationPlans: {},
  };
}

export class JsonStore {
  private data: StoreData;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(file, "utf8")) as StoreData;
      this.data.mutationPlans ??= {};
      // Mutation plans are intentionally short-lived and are not user data.
      // Drop plans from the pre-v0.3 isolated-plan representation rather than
      // attempting to execute them with different semantics.
      for (const [id, plan] of Object.entries(this.data.mutationPlans)) {
        if (!Array.isArray((plan as MutationPlan).steps)) delete this.data.mutationPlans[id];
      }
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
        data.mutationPlans,
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
