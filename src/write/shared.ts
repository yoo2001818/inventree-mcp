import { z } from "zod";
import { DomainError, notFound } from "../domainErrors.js";
import {
  entityRef,
  formatRef,
  numberValue,
  record,
  type EntityRef,
  type JsonRecord,
} from "../inventoryDomain.js";
import { InvenTreeClient, InvenTreeError } from "../inventree.js";
import {
  captureCheck,
  reviewPlan,
  stagePlan,
  stageResult,
  type PlannedOutputInput,
} from "../mutationPlans.js";
import type { OAuthService } from "../oauth.js";
import type {
  InventoryEntityType,
  MutationCheck,
  MutationOutput,
  MutationRequest,
} from "../store.js";
export const positiveQuantity = z.number().positive().finite();
export const optionalText = () => z.string().max(50_000).nullable().optional();
export const localPlanOutputNames = ["part", "stock_item", "part_category", "stock_location"] as const;
export const localPlanRefSchema = z.object({
  step: z.string().min(1).max(64).describe("Exact key of an earlier step in this create_inventory_plan request"),
  output: z.enum(localPlanOutputNames).describe(
    "Exact declared output name. Use part, stock_item, part_category, or stock_location; never append _id.",
  ),
}).strict().describe("Reference to an entity output declared by an earlier step");
export const partUnitsSchema = z.string().trim().min(1).max(20).nullable().optional().describe(
  "Formal InvenTree unit such as m, kg, L, piece, each, dozen, hundred, or thousand. Omit unless the user explicitly specifies a unit; never use arbitrary nouns, localized counting words, or packaging.",
);
export const entityIdSchema = () => z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).describe("Existing positive numeric InvenTree ID encoded as a string"),
  localPlanRefSchema,
]);
export const nullableEntityIdSchema = () => entityIdSchema().nullable();
export const planInputFields = {
  plan_id: z.string().min(16).optional().describe("Existing shared plan to append to; omit to start a new plan"),
  expected_version: z.number().int().positive().optional().describe("Required with plan_id to prevent lost updates"),
  operation_id: z.string().min(1).max(100).describe("Caller-stable idempotency key for this staged step"),
};
export const entitySelectorSchema = entityIdSchema();

export type LocalPlanOutputName = typeof localPlanOutputNames[number];
export type LocalPlanRef = { step: string; output: LocalPlanOutputName };
export type PlanInput = { plan_id?: string; expected_version?: number; operation_id: string };
export type EntityId = number | string | LocalPlanRef;

export type PrimitiveHandler = (input: any, extra: any) => Promise<any>;
export type PrimitiveConfig<TShape extends z.ZodRawShape = z.ZodRawShape> = {
  title: string;
  description: string;
  inputSchema: TShape;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};
export type PrimitiveDefinition = { name: string; config: PrimitiveConfig; handler: PrimitiveHandler };

export class MutationPrimitiveRegistry {
  readonly definitions: PrimitiveDefinition[] = [];

  register<TShape extends z.ZodRawShape>(
    name: string,
    config: PrimitiveConfig<TShape>,
    handler: (input: z.infer<z.ZodObject<TShape>>, extra: any) => Promise<any>,
  ): void {
    this.definitions.push({ name, config, handler: handler as PrimitiveHandler });
  }
}

export const STATUS_CODES = {
  ok: 10,
  attention_needed: 50,
  damaged: 55,
  destroyed: 60,
  rejected: 65,
  lost: 70,
  quarantined: 75,
  returned: 85,
} as const;

export async function getPart(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/part/${id}/`, { category_detail: true, location_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("part", { supplied_id: id }, "find_parts", `Part #${id} was not found. Use find_parts to resolve the current ID.`);
    }
    throw error;
  }
}

export async function getStock(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/stock/${id}/`, { part_detail: true, location_detail: true, path_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("stock_item", { supplied_id: id }, "get_part_inventory", `Stock item #${id} was not found. Use get_part_inventory to resolve current stock-item IDs.`);
    }
    throw error;
  }
}

export async function getCategory(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/part/category/${id}/`, { path_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("part_category", { supplied_id: id }, "browse_part_categories", `Part category #${id} was not found. Use browse_part_categories to resolve the current ID.`);
    }
    throw error;
  }
}

export async function getLocation(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/stock/location/${id}/`, { path_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("stock_location", { supplied_id: id }, "browse_stock_locations", `Stock location #${id} was not found. Use browse_stock_locations to resolve the current ID.`);
    }
    throw error;
  }
}

export function refOrFallback(value: unknown, kind: string, id: number): EntityRef {
  return entityRef(value) ?? { id, name: `${kind} ${id}` };
}

export function partRef(part: JsonRecord): EntityRef {
  return refOrFallback(part, "Part", numberValue(part.pk));
}

export function stockPartRef(stock: JsonRecord): EntityRef {
  const detail = entityRef(stock.part_detail);
  return detail ?? { id: numberValue(stock.part), name: `Part ${numberValue(stock.part)}` };
}

export function stockLocationRef(stock: JsonRecord): EntityRef | null {
  const detail = entityRef(stock.location_detail);
  if (detail) return detail;
  const id = numberValue(stock.location);
  return id ? { id, name: `Location ${id}` } : null;
}

export function ensureUnlocked(part: JsonRecord): void {
  if (part.locked === true) throw new Error(`${formatRef(partRef(part))} is locked`);
}

export function ensurePartCategory(category: JsonRecord): void {
  if (category.structural === true) {
    throw new Error(`${formatRef(refOrFallback(category, "Category", numberValue(category.pk)))} is structural and cannot directly contain parts`);
  }
}

export function ensureStockDestination(location: JsonRecord): void {
  if (location.structural === true) {
    throw new Error(`${formatRef(refOrFallback(location, "Location", numberValue(location.pk)))} is structural and cannot directly contain stock`);
  }
}

export async function checksFor(client: InvenTreeClient, paths: Array<[string, Record<string, unknown>?]>): Promise<MutationCheck[]> {
  return Promise.all(paths.map(([path, query]) => captureCheck(client, path, query)));
}

export async function validatePartUnits(client: InvenTreeClient, units: string | null | undefined): Promise<void> {
  if (units === undefined || units === null) return;
  const response = record(await client.get("/api/units/all/"));
  const available = record(response.available_units);
  if (Object.hasOwn(available, units)) return;
  const preferred = ["piece", "each", "dozen", "hundred", "thousand", "m", "kg", "L"]
    .filter((candidate) => Object.hasOwn(available, candidate));
  throw new DomainError(
    {
      status: "invalid_unit",
      supplied_unit: units,
      ...(preferred.length ? { common_units: preferred } : {}),
    },
    `"${units}" is not a configured InvenTree unit. Omit units unless a formal measurement or counting unit is required${preferred.length ? `; common choices include ${preferred.join(", ")}` : ""}.`,
  );
}

export function beforeAfter(label: string, before: unknown, after: unknown): string | undefined {
  const left = before ?? null;
  const right = after ?? null;
  return JSON.stringify(left) === JSON.stringify(right) ? undefined : `- ${label}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`;
}

export function mutationAnnotations(idempotentHint = true) {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false };
}

export function commitAnnotations() {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
}

export function stageMutation(
  oauth: OAuthService,
  auth: Parameters<typeof stagePlan>[1],
  input: PlanInput,
  summary: string,
  requests: MutationRequest[],
  checks: MutationCheck[],
  outputs?: PlannedOutputInput[],
) {
  return stageResult(stagePlan(oauth, auth, {
    planId: input.plan_id,
    expectedVersion: input.expected_version,
    operationId: input.operation_id,
    summary,
    requests,
    checks,
    outputs,
  }));
}

export function normalizeEntityId(value: EntityId): number | string {
  if (typeof value === "object") {
    throw new Error(`Local plan reference ${value.step}.${value.output} was not resolved`);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid entity ID: ${value}`);
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Entity ID or plan reference cannot be blank");
  if (!/^\d+$/.test(trimmed)) return trimmed;
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`Invalid entity ID: ${value}`);
  return numeric;
}

export function selectorId(value: EntityId): EntityId {
  if (typeof value === "number" || typeof value === "string") return normalizeEntityId(value);
  return normalizeEntityId(value);
}

export function plannedOutput(
  oauth: OAuthService,
  auth: Parameters<typeof reviewPlan>[1],
  planId: string | undefined,
  value: EntityId,
  expectedType: InventoryEntityType,
): MutationOutput | undefined {
  const normalized = normalizeEntityId(value);
  if (typeof normalized === "number") return undefined;
  if (!planId) throw new Error(`plan_id is required when using planned ref ${normalized}`);
  const output = reviewPlan(oauth, auth, planId).plan.steps
    .flatMap((step) => step.outputs)
    .find((candidate) => candidate.ref === normalized);
  if (!output) throw new Error(`Unknown plan reference: ${normalized}`);
  if (output.entityType !== expectedType) {
    throw new Error(`Plan reference ${normalized} is ${output.entityType}, not ${expectedType}`);
  }
  return output;
}

export function mutationValue(value: EntityId | null): unknown {
  if (value === null) return null;
  const normalized = normalizeEntityId(value);
  return typeof normalized === "number" ? normalized : { __planRef: normalized };
}

export function mutationPath(prefix: string, value: EntityId, suffix = "/"): MutationRequest["path"] {
  const normalized = normalizeEntityId(value);
  return typeof normalized === "number"
    ? `${prefix}${normalized}${suffix}`
    : [prefix, { __planRef: normalized }, suffix];
}

export function plannedLabel(output: MutationOutput | undefined, fallback: string): string {
  return output ? `${output.display} (ref ${output.ref})` : fallback;
}

export function metadataBoolean(output: MutationOutput | undefined, key: string): boolean | undefined {
  const value = output?.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function pathSegments(path: string): string[] {
  return path
    .split("/")
    .flatMap((segment) => segment.split(/\s+>\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function authenticatedCredentialsId(auth: Parameters<typeof reviewPlan>[1]): string {
  const id = String(auth.extra?.credentialsId ?? "");
  if (!id) throw new Error("Authenticated InvenTree credentials are missing");
  return id;
}
