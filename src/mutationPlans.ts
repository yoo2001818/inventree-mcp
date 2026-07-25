import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomToken } from "./crypto.js";
import { DomainError, versionConflict } from "./domainErrors.js";
import { InvenTreeClient, InvenTreeError } from "./inventree.js";
import type { PartImageUploads } from "./partImages.js";
import type { OAuthService } from "./oauth.js";
import type {
  InventoryEntityType,
  MutationCheck,
  MutationCommitResult,
  MutationOutput,
  MutationPlan,
  MutationRequest,
  MutationStep,
} from "./store.js";

const PLAN_TTL_MS = 30 * 60_000;
const COMMITTED_PLAN_TTL_MS = 60 * 60_000;

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

export interface PlannedOutputInput {
  name: string;
  entityType: InventoryEntityType;
  requestIndex: number;
  responsePaths: Array<Array<string | number>>;
  display: string;
  metadata?: Record<string, unknown>;
}

export interface StagePlanInput {
  planId?: string;
  expectedVersion?: number;
  operationId: string;
  summary: string;
  requests: MutationRequest[];
  checks: MutationCheck[];
  outputs?: PlannedOutputInput[];
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomToken(8).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}

function outputPrefix(entityType: InventoryEntityType): string {
  return { part: "part", stock_item: "stock", part_category: "category", stock_location: "location" }[entityType];
}

export function stagePlan(
  oauth: OAuthService,
  authInfo: AuthInfo,
  input: StagePlanInput,
): { plan: MutationPlan; step: MutationStep; duplicate: boolean } {
  const now = Date.now();
  const owner = credentialsId(authInfo);
  let staged!: { plan: MutationPlan; step: MutationStep; duplicate: boolean };
  oauth.store.mutate((data) => {
    let plan: MutationPlan;
    if (input.planId) {
      plan = data.mutationPlans[input.planId]!;
      if (!plan) throw new Error("Inventory plan was not found or expired");
      if (plan.credentialsId !== owner) throw new Error("Inventory plan belongs to another credential link");
      if (plan.state !== "staging") throw new Error(`Inventory plan cannot be edited while it is ${plan.state}`);
      const existing = plan.steps.find((step) => step.operationId === input.operationId);
      if (existing) {
        if (existing.summary !== input.summary || digest(existing.requests) !== digest(input.requests)) {
          throw new Error(`operation_id ${input.operationId} was already used for a different staged operation`);
        }
        staged = { plan, step: existing, duplicate: true };
        return;
      }
      if (input.expectedVersion === undefined) throw new Error("expected_version is required when appending to a plan");
      if (plan.version !== input.expectedVersion) {
        throw versionConflict(input.expectedVersion, plan.version);
      }
    } else {
      plan = {
        id: randomToken(18),
        credentialsId: owner,
        version: 0,
        state: "staging",
        steps: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + PLAN_TTL_MS,
      };
      data.mutationPlans[plan.id] = plan;
    }
    const stepId = opaqueId("stp");
    const outputs: MutationOutput[] = (input.outputs ?? []).map((output) => ({
      ...output,
      ref: opaqueId(outputPrefix(output.entityType)),
    }));
    const step: MutationStep = {
      id: stepId,
      operationId: input.operationId,
      summary: input.summary,
      requests: input.requests,
      checks: input.checks,
      outputs,
      createdAt: now,
    };
    validateReferences(plan, step);
    plan.steps.push(step);
    plan.version += 1;
    plan.updatedAt = now;
    plan.expiresAt = now + PLAN_TTL_MS;
    staged = { plan, step, duplicate: false };
  });
  return staged;
}

export function stageResult(staged: { plan: MutationPlan; step: MutationStep; duplicate: boolean }) {
  const { plan, step, duplicate } = staged;
  const outputText = step.outputs.length
    ? `\n${step.outputs.map((output) => `- Future ${output.entityType.replaceAll("_", " ")}: ${output.display} (ref ${output.ref})`).join("\n")}`
    : "";
  return {
    structuredContent: {
      data: {
        status: "staged",
        plan_id: plan.id,
        plan_version: plan.version,
        step_id: step.id,
        position: plan.steps.findIndex((candidate) => candidate.id === step.id) + 1,
        duplicate_operation: duplicate,
        expires_at: new Date(plan.expiresAt).toISOString(),
        summary: step.summary,
        outputs: step.outputs.map(({ ref, name, entityType, display }) => ({ ref, name, entity_type: entityType, display })),
      },
    },
    content: [
      {
        type: "text" as const,
        text: `${duplicate ? "Already staged" : `Staged step ${plan.steps.findIndex((candidate) => candidate.id === step.id) + 1}`} (${step.id}) in plan ${plan.id}, version ${plan.version}.\n${step.summary}${outputText}${plan.steps.length === 1 ? "\n\nAppend related steps with this plan ID and version, then review once before the final commit." : ""}`,
      },
    ],
  };
}

function referencedPlanRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => referencedPlanRefs(item, refs));
  else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.__planRef === "string") refs.add(object.__planRef);
    else Object.values(object).forEach((child) => referencedPlanRefs(child, refs));
  }
  return refs;
}

function validateReferences(plan: MutationPlan, step: MutationStep): void {
  const available = new Set(plan.steps.flatMap((candidate) => candidate.outputs.map((output) => output.ref)));
  for (const ref of step.requests.flatMap((request) => [
    ...referencedPlanRefs(request.path),
    ...referencedPlanRefs(request.body),
  ])) {
    if (!available.has(ref)) throw new Error(`Unknown or not-yet-available plan reference: ${ref}`);
  }
}

function resolveRequestPath(path: MutationRequest["path"], refs: Map<string, number | string>): string {
  if (typeof path === "string") return path;
  return path.map((segment) => {
    if (typeof segment === "string") return segment;
    const resolved = refs.get(segment.__planRef);
    if (resolved === undefined) throw new Error(`Plan reference was not resolved: ${segment.__planRef}`);
    return encodeURIComponent(String(resolved));
  }).join("");
}

function resolveReferences(value: unknown, results: unknown[], refs: Map<string, number | string>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, results, refs));
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.__planRef === "string") {
      const resolved = refs.get(object.__planRef);
      if (resolved === undefined) throw new Error(`Plan reference was not resolved: ${object.__planRef}`);
      return resolved;
    }
    if (typeof object.__result === "number" && typeof object.__field === "string") {
      const source = results[object.__result];
      const resolved = source !== null && typeof source === "object"
        ? (source as Record<string, unknown>)[object.__field]
        : undefined;
      if (resolved === undefined) throw new Error("A prior mutation did not return the expected identifier");
      return resolved;
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [key, resolveReferences(child, results, refs)]),
    );
  }
  return value;
}

function extractPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function resolveOutput(output: MutationOutput, result: unknown): number | string {
  for (const path of output.responsePaths) {
    const value = extractPath(result, path);
    if (typeof value === "number" || typeof value === "string") return value;
  }
  throw new Error(`Step output ${output.ref} did not return an identifier at an expected path`);
}

function requireOwnedPlan(oauth: OAuthService, authInfo: AuthInfo, planId: string): MutationPlan {
  oauth.store.cleanup();
  const plan = oauth.store.snapshot.mutationPlans[planId];
  if (!plan) throw new Error("Inventory plan was not found or expired");
  if (plan.credentialsId !== credentialsId(authInfo)) throw new Error("Inventory plan belongs to another credential link");
  return plan;
}

export function reviewPlan(oauth: OAuthService, authInfo: AuthInfo, planId: string) {
  const plan = requireOwnedPlan(oauth, authInfo, planId);
  return {
    plan,
    text: [
      `Inventory plan ${plan.id}, version ${plan.version} (${plan.state})`,
      ...plan.steps.flatMap((step, index) => [
        `\n${index + 1}. [${step.id}]`,
        step.summary,
        ...step.outputs.map((output) => `   Output: ${output.display} (ref ${output.ref})`),
      ]),
      `\nTotal upstream operations: ${plan.steps.reduce((count, step) => count + step.requests.length, 0)}`,
    ].join("\n"),
  };
}

export function discardPlan(oauth: OAuthService, authInfo: AuthInfo, planId: string): void {
  const plan = requireOwnedPlan(oauth, authInfo, planId);
  if (plan.state === "committing") throw new Error("Inventory plan is currently committing");
  oauth.store.mutate((data) => { delete data.mutationPlans[plan.id]; });
}

export async function commitPlan(
  oauth: OAuthService,
  authInfo: AuthInfo,
  client: InvenTreeClient,
  planId: string,
  expectedVersion: number,
  imageUploads?: PartImageUploads,
): Promise<{ plan: MutationPlan; result: MutationCommitResult }> {
  const plan = requireOwnedPlan(oauth, authInfo, planId);
  if (plan.state === "committed" && plan.commitResult) return { plan, result: plan.commitResult };
  if (plan.state !== "staging") throw new Error(`Inventory plan cannot be committed while it is ${plan.state}`);
  if (plan.version !== expectedVersion) throw versionConflict(expectedVersion, plan.version);
  if (!plan.steps.length) throw new Error("Inventory plan has no steps to commit");

  // Claim the plan synchronously before the first await so concurrent commits
  // cannot both pass validation and execute the same real-world mutation.
  oauth.store.mutate((data) => {
    data.mutationPlans[plan.id]!.state = "committing";
  });

  try {
    for (const check of plan.steps.flatMap((step) => step.checks)) {
      const current = await client.get(check.path, check.query);
      if (digest(current) !== check.digest) {
        throw new DomainError(
          { status: "conflict", conflict_type: "stale_inventory", changed_path: check.path },
          `Inventory plan is stale because ${check.path} changed; prepare a new plan`,
        );
      }
    }
  } catch (error) {
    const failed: MutationCommitResult = {
      status: "failed",
      completedSteps: 0,
      completedRequests: 0,
      resolvedRefs: {},
      resultIds: [],
      error: (error as Error).message,
    };
    oauth.store.mutate((data) => {
      Object.assign(data.mutationPlans[plan.id]!, { state: "failed", commitResult: failed, updatedAt: Date.now(), expiresAt: Date.now() + COMMITTED_PLAN_TTL_MS });
    });
    throw error;
  }

  const refs = new Map<string, number | string>();
  const resultIds: number[] = [];
  let completedRequests = 0;
  let completedSteps = 0;
  for (const step of plan.steps) {
    const stepResults: unknown[] = [];
    for (let requestIndex = 0; requestIndex < step.requests.length; requestIndex += 1) {
      const request = step.requests[requestIndex]!;
      const body = resolveReferences(request.body, stepResults, refs);
      try {
        const requestPath = resolveRequestPath(request.path, refs);
        const upload = request.imageUpload
          ? imageUploads?.get(request.imageUpload.uploadRef, credentialsId(authInfo))
          : undefined;
        if (request.imageUpload && !upload) throw new Error("Image uploads are unavailable for this commit");
        const response = upload
          ? await client.writeMultipart(request.method, requestPath, {
              field: request.imageUpload!.field,
              bytes: upload.bytes,
              filename: upload.filename,
              mimeType: upload.mimeType,
            })
          : await client.write(request.method, requestPath, body);
        completedRequests += 1;
        if (upload) {
          const responseRecord = response !== null && typeof response === "object"
            ? response as Record<string, unknown>
            : {};
          if (typeof responseRecord.image !== "string" || !responseRecord.image || typeof responseRecord.thumbnail !== "string" || !responseRecord.thumbnail) {
            throw new Error("InvenTree accepted the image request but did not return verified image and thumbnail paths");
          }
          imageUploads!.remove(upload.ref);
        }
        stepResults.push(response);
        const directId = extractPath(response, ["pk"]);
        if (typeof directId === "number") resultIds.push(directId);
        for (const output of step.outputs.filter((candidate) => candidate.requestIndex === requestIndex)) {
          const value = resolveOutput(output, response);
          refs.set(output.ref, value);
          if (typeof value === "number") resultIds.push(value);
        }
      } catch (error) {
        const failed: MutationCommitResult = {
          status: "failed",
          completedSteps,
          completedRequests,
          resolvedRefs: Object.fromEntries(refs),
          resultIds: [...new Set(resultIds)],
          failedStepId: step.id,
          error: (error as Error).message,
        };
        oauth.store.mutate((data) => {
          Object.assign(data.mutationPlans[plan.id]!, { state: "failed", commitResult: failed, updatedAt: Date.now(), expiresAt: Date.now() + COMMITTED_PLAN_TTL_MS });
        });
        const message = `Inventory plan failed at ${step.id} after ${completedRequests} upstream operations: ${(error as Error).message}`;
        if (error instanceof InvenTreeError) {
          throw new InvenTreeError(message, error.status, error.details, {
            failed_step_id: step.id,
            completed_steps: completedSteps,
            completed_operations: completedRequests,
          });
        }
        throw new Error(message, { cause: error });
      }
    }
    completedSteps += 1;
  }
  const committed: MutationCommitResult = {
    status: "committed",
    completedSteps,
    completedRequests,
    resolvedRefs: Object.fromEntries(refs),
    resultIds: [...new Set(resultIds)],
  };
  oauth.store.mutate((data) => {
    Object.assign(data.mutationPlans[plan.id]!, { state: "committed", commitResult: committed, updatedAt: Date.now(), expiresAt: Date.now() + COMMITTED_PLAN_TTL_MS });
  });
  return { plan, result: committed };
}
