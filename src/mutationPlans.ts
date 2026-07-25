import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomToken } from "./crypto.js";
import { InvenTreeClient } from "./inventree.js";
import type { OAuthService } from "./oauth.js";
import type { MutationCheck, MutationPlan, MutationRequest } from "./store.js";

const PLAN_TTL_MS = 10 * 60_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export async function captureCheck(
  client: InvenTreeClient,
  path: string,
  query?: Record<string, unknown>,
): Promise<MutationCheck> {
  return { path, ...(query ? { query } : {}), digest: digest(await client.get(path, query)) };
}

function credentialsId(authInfo: AuthInfo): string {
  const id = String(authInfo.extra?.credentialsId ?? "");
  if (!id) throw new Error("Authenticated InvenTree credentials are missing");
  return id;
}

export function savePlan(
  oauth: OAuthService,
  authInfo: AuthInfo,
  summary: string,
  requests: MutationRequest[],
  checks: MutationCheck[],
): MutationPlan {
  const now = Date.now();
  const plan: MutationPlan = {
    id: randomToken(18),
    credentialsId: credentialsId(authInfo),
    summary,
    requests,
    checks,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
  };
  oauth.store.mutate((data) => {
    data.mutationPlans[plan.id] = plan;
  });
  return plan;
}

export function planResult(plan: MutationPlan) {
  return {
    structuredContent: {
      status: "confirmation_required",
      plan_id: plan.id,
      expires_at: new Date(plan.expiresAt).toISOString(),
      summary: plan.summary,
    },
    content: [
      {
        type: "text" as const,
        text: `${plan.summary}\n\nConfirmation required. After the user confirms this exact preview, call commit_inventory_change with plan ID ${plan.id}. The plan expires at ${new Date(plan.expiresAt).toISOString()}.`,
      },
    ],
  };
}

function resolveResultReferences(value: unknown, results: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveResultReferences(item, results));
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.__result === "number" && typeof object.__field === "string") {
      const source = results[object.__result];
      const resolved = source !== null && typeof source === "object"
        ? (source as Record<string, unknown>)[object.__field]
        : undefined;
      if (resolved === undefined) throw new Error("A prior mutation did not return the expected identifier");
      return resolved;
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [key, resolveResultReferences(child, results)]),
    );
  }
  return value;
}

export async function commitPlan(
  oauth: OAuthService,
  authInfo: AuthInfo,
  client: InvenTreeClient,
  planId: string,
): Promise<{ plan: MutationPlan; results: unknown[] }> {
  oauth.store.cleanup();
  const plan = oauth.store.snapshot.mutationPlans[planId];
  if (!plan) throw new Error("Mutation plan was not found, expired, or already used");
  if (plan.credentialsId !== credentialsId(authInfo)) throw new Error("Mutation plan belongs to another credential link");

  // Claim the plan synchronously before the first await so concurrent commits
  // cannot both pass validation and execute the same real-world mutation.
  oauth.store.mutate((data) => {
    delete data.mutationPlans[plan.id];
  });

  for (const check of plan.checks) {
    const current = await client.get(check.path, check.query);
    if (digest(current) !== check.digest) {
      throw new Error(`Mutation plan is stale because ${check.path} changed; prepare a new plan`);
    }
  }

  const results: unknown[] = [];
  for (const request of plan.requests) {
    const body = resolveResultReferences(request.body, results);
    try {
      results.push(await client.write(request.method, request.path, body));
    } catch (error) {
      throw new Error(
        `Mutation plan failed after ${results.length} of ${plan.requests.length} upstream operations: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return { plan, results };
}
