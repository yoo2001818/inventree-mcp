import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, notFound } from "./domainErrors.js";
import {
  displayPath,
  entityRef,
  formatQuantity,
  formatRef,
  numberValue,
  optionalString,
  pageResults,
  record,
  stringValue,
  type EntityRef,
  type JsonRecord,
} from "./inventoryDomain.js";
import { InvenTreeClient, InvenTreeError } from "./inventree.js";
import {
  captureCheck,
  commitPlan,
  discardPlan,
  removePlanStep,
  reviewPlan,
  stagePlan,
  stageResult,
  type PlannedOutputInput,
} from "./mutationPlans.js";
import type { OAuthService } from "./oauth.js";
import type { PartImageUploads } from "./partImages.js";
import { clientFor, result, safely, WRITE_SECURITY } from "./mcpSupport.js";
import type { MutationCheck, MutationRequest } from "./store.js";
import type { InventoryEntityType, MutationOutput } from "./store.js";

const positiveQuantity = z.number().positive().finite();
const optionalText = () => z.string().max(50_000).nullable().optional();
const entityIdSchema = () => z.union([
  z.number().int().positive(),
  z.string().min(1).describe("Existing numeric ID or a server-issued ref from an earlier plan step"),
]);
const nullableEntityIdSchema = () => entityIdSchema().nullable();
const planInputFields = {
  plan_id: z.string().min(16).optional().describe("Existing shared plan to append to; omit to start a new plan"),
  expected_version: z.number().int().positive().optional().describe("Required with plan_id to prevent lost updates"),
  operation_id: z.string().min(1).max(100).describe("Caller-stable idempotency key for this staged step"),
};
const entitySelectorSchema = z.union([
  entityIdSchema(),
  z.object({ id: z.number().int().positive() }).strict(),
  z.object({ ref: z.string().min(1) }).strict(),
]);

type PlanInput = { plan_id?: string; expected_version?: number; operation_id: string };
type EntityId = number | string;

const STATUS_CODES = {
  ok: 10,
  attention_needed: 50,
  damaged: 55,
  destroyed: 60,
  rejected: 65,
  lost: 70,
  quarantined: 75,
  returned: 85,
} as const;

async function getPart(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/part/${id}/`, { category_detail: true, location_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("part", { supplied_id: id }, "find_parts", `Part #${id} was not found. Use find_parts to resolve the current ID.`);
    }
    throw error;
  }
}

async function getStock(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/stock/${id}/`, { part_detail: true, location_detail: true, path_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("stock_item", { supplied_id: id }, "get_part_inventory", `Stock item #${id} was not found. Use get_part_inventory to resolve current stock-item IDs.`);
    }
    throw error;
  }
}

async function getCategory(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/part/category/${id}/`, { path_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("part_category", { supplied_id: id }, "browse_part_categories", `Part category #${id} was not found. Use browse_part_categories to resolve the current ID.`);
    }
    throw error;
  }
}

async function getLocation(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  try {
    return record(await client.get(`/api/stock/location/${id}/`, { path_detail: true }));
  } catch (error) {
    if (error instanceof InvenTreeError && error.status === 404) {
      throw notFound("stock_location", { supplied_id: id }, "browse_stock_locations", `Stock location #${id} was not found. Use browse_stock_locations to resolve the current ID.`);
    }
    throw error;
  }
}

function refOrFallback(value: unknown, kind: string, id: number): EntityRef {
  return entityRef(value) ?? { id, name: `${kind} ${id}` };
}

function partRef(part: JsonRecord): EntityRef {
  return refOrFallback(part, "Part", numberValue(part.pk));
}

function stockPartRef(stock: JsonRecord): EntityRef {
  const detail = entityRef(stock.part_detail);
  return detail ?? { id: numberValue(stock.part), name: `Part ${numberValue(stock.part)}` };
}

function stockLocationRef(stock: JsonRecord): EntityRef | null {
  const detail = entityRef(stock.location_detail);
  if (detail) return detail;
  const id = numberValue(stock.location);
  return id ? { id, name: `Location ${id}` } : null;
}

function ensureUnlocked(part: JsonRecord): void {
  if (part.locked === true) throw new Error(`${formatRef(partRef(part))} is locked`);
}

function ensurePartCategory(category: JsonRecord): void {
  if (category.structural === true) {
    throw new Error(`${formatRef(refOrFallback(category, "Category", numberValue(category.pk)))} is structural and cannot directly contain parts`);
  }
}

function ensureStockDestination(location: JsonRecord): void {
  if (location.structural === true) {
    throw new Error(`${formatRef(refOrFallback(location, "Location", numberValue(location.pk)))} is structural and cannot directly contain stock`);
  }
}

async function checksFor(client: InvenTreeClient, paths: Array<[string, Record<string, unknown>?]>): Promise<MutationCheck[]> {
  return Promise.all(paths.map(([path, query]) => captureCheck(client, path, query)));
}

function beforeAfter(label: string, before: unknown, after: unknown): string | undefined {
  const left = before ?? null;
  const right = after ?? null;
  return JSON.stringify(left) === JSON.stringify(right) ? undefined : `- ${label}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`;
}

function mutationAnnotations(idempotentHint = true) {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false };
}

function commitAnnotations() {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
}

function stageMutation(
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

function normalizeEntityId(value: EntityId): EntityId {
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

function selectorId(value: EntityId | { id: number } | { ref: string }): EntityId {
  if (typeof value === "number" || typeof value === "string") return normalizeEntityId(value);
  return normalizeEntityId("id" in value ? value.id : value.ref);
}

function plannedOutput(
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

function mutationValue(value: EntityId | null): unknown {
  if (value === null) return null;
  const normalized = normalizeEntityId(value);
  return typeof normalized === "number" ? normalized : { __planRef: normalized };
}

function mutationPath(prefix: string, value: EntityId, suffix = "/"): MutationRequest["path"] {
  const normalized = normalizeEntityId(value);
  return typeof normalized === "number"
    ? `${prefix}${normalized}${suffix}`
    : [prefix, { __planRef: normalized }, suffix];
}

function plannedLabel(output: MutationOutput | undefined, fallback: string): string {
  return output ? `${output.display} (ref ${output.ref})` : fallback;
}

function metadataBoolean(output: MutationOutput | undefined, key: string): boolean | undefined {
  const value = output?.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function pathSegments(path: string): string[] {
  return path
    .split("/")
    .flatMap((segment) => segment.split(/\s+>\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function authenticatedCredentialsId(auth: Parameters<typeof reviewPlan>[1]): string {
  const id = String(auth.extra?.credentialsId ?? "");
  if (!id) throw new Error("Authenticated InvenTree credentials are missing");
  return id;
}

export function registerWriteTools(server: McpServer, oauth: OAuthService, imageUploads: PartImageUploads): void {
  server.registerTool(
    "create_part_with_stock",
    {
      title: "Prepare a new part and initial stock",
      description:
        "Check for duplicate parts, validate category/location IDs, and stage creation of a home-inventory part with optional initial stock in a shared plan.",
      inputSchema: {
        ...planInputFields,
        part: z.object({
          name: z.string().min(1).max(100),
          description: z.string().max(250).default(""),
          category_id: entityIdSchema(),
          IPN: z.string().max(100).default(""),
          keywords: z.array(z.string().min(1)).default([]),
          units: z.string().max(20).nullable().optional(),
          minimum_stock: z.number().nonnegative().default(0),
          maximum_stock: z.number().nonnegative().default(0),
          default_location_id: nullableEntityIdSchema().optional(),
          trackable: z.boolean().default(false),
          link: z.string().url().max(2000).nullable().optional(),
          notes: optionalText(),
        }),
        initial_stock: z
          .object({
            quantity: positiveQuantity,
            location_id: entityIdSchema(),
            batch: z.string().max(100).nullable().optional(),
            packaging: z.string().max(50).nullable().optional(),
            expiry_date: z.string().date().nullable().optional(),
            notes: optionalText(),
          })
          .nullable()
          .default(null),
        allow_possible_duplicates: z.boolean().default(false),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const categoryId = normalizeEntityId(input.part.category_id);
        const categoryOutput = plannedOutput(oauth, auth, input.plan_id, categoryId, "part_category");
        const category = typeof categoryId === "number" ? await getCategory(client, categoryId) : undefined;
        if (category) ensurePartCategory(category);
        if (metadataBoolean(categoryOutput, "structural")) throw new Error(`${categoryOutput!.display} is structural and cannot directly contain parts`);
        const defaultLocationId = input.part.default_location_id === null || input.part.default_location_id === undefined
          ? input.part.default_location_id
          : normalizeEntityId(input.part.default_location_id);
        const defaultLocationOutput = defaultLocationId === null || defaultLocationId === undefined
          ? undefined
          : plannedOutput(oauth, auth, input.plan_id, defaultLocationId, "stock_location");
        const defaultLocation = typeof defaultLocationId === "number"
          ? await getLocation(client, defaultLocationId)
          : undefined;
        if (defaultLocation) ensureStockDestination(defaultLocation);
        if (metadataBoolean(defaultLocationOutput, "structural")) throw new Error(`${defaultLocationOutput!.display} is structural and cannot directly contain stock`);
        const stockLocationId = input.initial_stock ? normalizeEntityId(input.initial_stock.location_id) : undefined;
        const stockLocationOutput = stockLocationId === undefined
          ? undefined
          : plannedOutput(oauth, auth, input.plan_id, stockLocationId, "stock_location");
        const stockLocation = typeof stockLocationId === "number" ? await getLocation(client, stockLocationId) : undefined;
        if (stockLocation) ensureStockDestination(stockLocation);
        if (metadataBoolean(stockLocationOutput, "structural")) throw new Error(`${stockLocationOutput!.display} is structural and cannot directly contain stock`);

        const duplicateQuery = { search: input.part.name, active: true, limit: 10, offset: 0 };
        const duplicates = await client.get("/api/part/", duplicateQuery);
        const candidates = pageResults(duplicates);
        if (candidates.length && !input.allow_possible_duplicates) {
          const duplicateCandidates = candidates.map((candidate) => ({
            id: numberValue(candidate.pk),
            name: stringValue(candidate.name),
          }));
          throw new DomainError(
            { status: "conflict", conflict_type: "possible_duplicates", candidates: duplicateCandidates },
            `Possible duplicate parts found: ${candidates
              .map((candidate) => `${stringValue(candidate.name)} (#${numberValue(candidate.pk)})`)
              .join(", ")}. Reuse one, or set allow_possible_duplicates after reviewing them.`,
          );
        }

        const partBody: Record<string, unknown> = {
          name: input.part.name,
          description: input.part.description,
          category: mutationValue(categoryId),
          IPN: input.part.IPN,
          keywords: input.part.keywords.join(", "),
          minimum_stock: input.part.minimum_stock,
          maximum_stock: input.part.maximum_stock,
          active: true,
          assembly: false,
          component: true,
          purchaseable: true,
          salable: false,
          virtual: false,
          trackable: input.part.trackable,
          ...(input.part.units !== undefined ? { units: input.part.units } : {}),
          ...(defaultLocationId !== undefined
            ? { default_location: mutationValue(defaultLocationId) }
            : {}),
          ...(input.part.link !== undefined ? { link: input.part.link } : {}),
          ...(input.part.notes !== undefined ? { notes: input.part.notes } : {}),
        };
        const requests: MutationRequest[] = [{ method: "POST", path: "/api/part/", body: partBody }];
        if (input.initial_stock) {
          requests.push({
            method: "POST",
            path: "/api/stock/",
            body: {
              part: { __result: 0, __field: "pk" },
              quantity: input.initial_stock.quantity,
              location: mutationValue(stockLocationId!),
              ...(input.initial_stock.batch ? { batch: input.initial_stock.batch } : {}),
              ...(input.initial_stock.packaging ? { packaging: input.initial_stock.packaging } : {}),
              ...(input.initial_stock.expiry_date ? { expiry_date: input.initial_stock.expiry_date } : {}),
              ...(input.initial_stock.notes ? { notes: input.initial_stock.notes } : {}),
            },
          });
        }
        const checkPaths: Array<[string, Record<string, unknown>?]> = [["/api/part/", duplicateQuery]];
        if (typeof categoryId === "number") {
          checkPaths.unshift([`/api/part/category/${categoryId}/`, { path_detail: true }]);
        }
        if (typeof defaultLocationId === "number") {
          checkPaths.push([`/api/stock/location/${defaultLocationId}/`, { path_detail: true }]);
        }
        if (typeof stockLocationId === "number" && stockLocationId !== defaultLocationId) {
          checkPaths.push([`/api/stock/location/${stockLocationId}/`, { path_detail: true }]);
        }
        const summary = [
          `Create part ${input.part.name}`,
          `- Category: ${plannedLabel(categoryOutput, formatRef(refOrFallback(category, "Category", Number(categoryId))))}`,
          ...(input.part.description ? [`- Description: ${input.part.description}`] : []),
          ...(input.part.IPN ? [`- IPN: ${input.part.IPN}`] : []),
          ...(input.part.keywords.length ? [`- Keywords: ${input.part.keywords.join(", ")}`] : []),
          ...(input.part.units ? [`- Units: ${input.part.units}`] : []),
          ...(input.part.minimum_stock ? [`- Minimum stock: ${input.part.minimum_stock}`] : []),
          ...(input.part.maximum_stock ? [`- Maximum stock: ${input.part.maximum_stock}`] : []),
          ...(input.part.trackable ? ["- Trackable: yes"] : []),
          ...(defaultLocationId !== undefined && defaultLocationId !== null
            ? [`- Default location: ${plannedLabel(defaultLocationOutput, formatRef(refOrFallback(defaultLocation, "Location", Number(defaultLocationId))))}`]
            : []),
          ...(input.part.link ? [`- Link: ${input.part.link}`] : []),
          ...(input.part.notes ? [`- Part notes: ${input.part.notes}`] : []),
          ...(input.initial_stock
            ? [
                `- Initial stock: ${formatQuantity(input.initial_stock.quantity, input.part.units ?? undefined)} in ${plannedLabel(
                  stockLocationOutput,
                  formatRef(refOrFallback(stockLocation, "Location", Number(stockLocationId))),
                )}`,
                ...(input.initial_stock.batch ? [`- Stock batch: ${input.initial_stock.batch}`] : []),
                ...(input.initial_stock.packaging ? [`- Stock packaging: ${input.initial_stock.packaging}`] : []),
                ...(input.initial_stock.expiry_date ? [`- Stock expiry: ${input.initial_stock.expiry_date}`] : []),
                ...(input.initial_stock.notes ? [`- Stock notes: ${input.initial_stock.notes}`] : []),
              ]
            : []),
          `- Upstream operations: ${requests.length}`,
        ].join("\n");
        const outputs: PlannedOutputInput[] = [
          {
            name: "part",
            entityType: "part",
            requestIndex: 0,
            responsePaths: [["pk"]],
            display: input.part.name,
            metadata: { name: input.part.name, units: input.part.units ?? null, locked: false },
          },
          ...(input.initial_stock
            ? [{
                name: "stock_item" as const,
                entityType: "stock_item" as const,
                requestIndex: 1,
                responsePaths: [[0, "pk"], ["pk"]],
                display: `${input.part.name} in ${plannedLabel(stockLocationOutput, formatRef(refOrFallback(stockLocation, "Location", Number(stockLocationId))))}`,
                metadata: {
                  part_name: input.part.name,
                  location: plannedLabel(stockLocationOutput, formatRef(refOrFallback(stockLocation, "Location", Number(stockLocationId)))),
                  quantity: input.initial_stock.quantity,
                },
              }]
            : []),
        ];
        return stageMutation(oauth, auth, input, summary, requests, await checksFor(client, checkPaths), outputs);
      }),
  );

  server.registerTool(
    "update_part",
    {
      title: "Prepare changes to a part",
      description: "Prepare a sparse metadata update for an existing part and show an exact before/after diff.",
      inputSchema: {
        ...planInputFields,
        part_id: entityIdSchema(),
        changes: z.object({
          name: z.string().min(1).max(100).optional(),
          description: z.string().max(250).optional(),
          category_id: nullableEntityIdSchema().optional(),
          IPN: z.string().max(100).optional(),
          keywords: z.array(z.string().min(1)).optional(),
          units: z.string().max(20).nullable().optional(),
          minimum_stock: z.number().nonnegative().optional(),
          maximum_stock: z.number().nonnegative().optional(),
          default_location_id: nullableEntityIdSchema().optional(),
          default_expiry: z.number().int().nonnegative().optional(),
          link: z.string().url().max(2000).nullable().optional(),
          notes: optionalText(),
          tags: z.array(z.string()).optional(),
          active: z.boolean().optional(),
          trackable: z.boolean().optional(),
        }),
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { changes } = input;
        const part_id = normalizeEntityId(input.part_id);
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const partOutput = plannedOutput(oauth, auth, input.plan_id, part_id, "part");
        const part = typeof part_id === "number" ? await getPart(client, part_id) : undefined;
        if (part) ensureUnlocked(part);
        let category: JsonRecord | undefined;
        const categoryId = changes.category_id === null || changes.category_id === undefined
          ? changes.category_id
          : normalizeEntityId(changes.category_id);
        const categoryOutput = categoryId === null || categoryId === undefined
          ? undefined
          : plannedOutput(oauth, auth, input.plan_id, categoryId, "part_category");
        if (typeof categoryId === "number") {
          category = await getCategory(client, categoryId);
          ensurePartCategory(category);
        }
        if (metadataBoolean(categoryOutput, "structural")) {
          throw new Error(`${categoryOutput!.display} is structural and cannot directly contain parts`);
        }
        let location: JsonRecord | undefined;
        const locationId = changes.default_location_id === null || changes.default_location_id === undefined
          ? changes.default_location_id
          : normalizeEntityId(changes.default_location_id);
        const locationOutput = locationId === null || locationId === undefined
          ? undefined
          : plannedOutput(oauth, auth, input.plan_id, locationId, "stock_location");
        if (typeof locationId === "number") {
          location = await getLocation(client, locationId);
          ensureStockDestination(location);
        }
        if (metadataBoolean(locationOutput, "structural")) {
          throw new Error(`${locationOutput!.display} is structural and cannot directly contain stock`);
        }
        const mapping: Array<[keyof typeof changes, string, string]> = [
          ["name", "name", "Name"],
          ["description", "description", "Description"],
          ["category_id", "category", "Category ID"],
          ["IPN", "IPN", "IPN"],
          ["units", "units", "Units"],
          ["minimum_stock", "minimum_stock", "Minimum stock"],
          ["maximum_stock", "maximum_stock", "Maximum stock"],
          ["default_location_id", "default_location", "Default location ID"],
          ["default_expiry", "default_expiry", "Default expiry"],
          ["link", "link", "Link"],
          ["notes", "notes", "Notes"],
          ["tags", "tags", "Tags"],
          ["active", "active", "Active"],
          ["trackable", "trackable", "Trackable"],
        ];
        const body: Record<string, unknown> = {};
        const diffs: string[] = [];
        for (const [inputKey, upstreamKey, label] of mapping) {
          const value = changes[inputKey];
          if (value === undefined) continue;
          const normalizedValue = inputKey === "category_id"
            ? categoryId
            : inputKey === "default_location_id"
              ? locationId
              : value;
          body[upstreamKey] = inputKey === "category_id" || inputKey === "default_location_id"
            ? mutationValue(normalizedValue as EntityId | null)
            : normalizedValue;
          const displayValue = categoryOutput && inputKey === "category_id"
            ? categoryOutput.display
            : locationOutput && inputKey === "default_location_id"
              ? locationOutput.display
              : normalizedValue;
          const diff = part
            ? beforeAfter(label, part[upstreamKey], displayValue)
            : `- ${label}: assigned at commit -> ${JSON.stringify(displayValue)}`;
          if (diff) diffs.push(diff);
        }
        if (changes.keywords !== undefined) {
          body.keywords = changes.keywords.join(", ");
          const diff = part
            ? beforeAfter("Keywords", part.keywords, body.keywords)
            : `- Keywords: assigned at commit -> ${JSON.stringify(body.keywords)}`;
          if (diff) diffs.push(diff);
        }
        if (!Object.keys(body).length) throw new Error("At least one part change is required");
        if (!diffs.length) throw new Error("The requested part values are already current");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [];
        if (typeof part_id === "number") checkPaths.push([`/api/part/${part_id}/`, { category_detail: true, location_detail: true }]);
        if (typeof categoryId === "number") checkPaths.push([`/api/part/category/${categoryId}/`, { path_detail: true }]);
        if (typeof locationId === "number") checkPaths.push([`/api/stock/location/${locationId}/`, { path_detail: true }]);
        const summary = [`Update ${plannedLabel(partOutput, formatRef(part ? partRef(part) : undefined))}:`, ...diffs].join("\n");
        return stageMutation(
          oauth,
          auth,
          input,
          summary,
          [{ method: "PATCH", path: mutationPath("/api/part/", part_id), body }],
          await checksFor(client, checkPaths),
        );
      }),
  );

  server.registerTool(
    "prepare_part_image_upload",
    {
      title: "Prepare a part-image upload",
      description: "Create an expiring capability URL for uploading image bytes outside MCP JSON. The URL works in a browser or with a raw HTTP PUT.",
      inputSchema: {
        filename: z.string().min(1).max(120).optional().describe("Optional filename hint used when the image is staged"),
      },
      annotations: mutationAnnotations(false),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
        const upload = imageUploads.prepare(authenticatedCredentialsId(auth), input.filename);
        const uploadUrl = new URL("/part-images/upload", oauth.config.publicUrl);
        uploadUrl.searchParams.set("token", upload.token);
        const expiresAt = new Date(upload.expiresAt).toISOString();
        return result(
          {
            status: "awaiting_upload",
            upload_ref: upload.uploadRef,
            upload_url: uploadUrl.toString(),
            method: "PUT",
            accepted_mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
            max_bytes: imageUploads.maxBytes,
            max_pixels: imageUploads.maxPixels,
            expires_at: expiresAt,
          },
          [
            `Upload reference: ${upload.uploadRef}`,
            `[Open the secure upload page](${uploadUrl.toString()})`,
            "A native client may instead PUT the raw image bytes to the same URL with the image Content-Type and optional X-File-Name header.",
            `The URL expires at ${expiresAt}. After uploading, call get_part_image_upload_status or stage set_part_image with the upload reference.`,
          ].join("\n\n"),
        );
      }),
  );

  server.registerTool(
    "get_part_image_upload_status",
    {
      title: "Check a part-image upload",
      description: "Check whether an expiring part-image upload reference is pending or ready to use with set_part_image.",
      inputSchema: {
        upload_ref: z.string().startsWith("upload_"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
        const upload = imageUploads.status(input.upload_ref, authenticatedCredentialsId(auth));
        const expiresAt = new Date(upload.expiresAt).toISOString();
        const data = upload.image
          ? {
              status: "ready" as const,
              upload_ref: input.upload_ref,
              filename: upload.image.filename,
              mime_type: upload.image.mimeType,
              byte_size: upload.image.byteSize,
              width: upload.image.width,
              height: upload.image.height,
              expires_at: expiresAt,
            }
          : { status: "pending" as const, upload_ref: input.upload_ref, expires_at: expiresAt };
        return result(
          data,
          upload.image
            ? `${input.upload_ref} is ready: ${upload.image.filename}, ${upload.image.width}x${upload.image.height}, ${upload.image.byteSize} bytes.`
            : `${input.upload_ref} is still waiting for an image upload.`,
        );
      }),
  );

  server.registerTool(
    "set_part_image",
    {
      title: "Prepare replacement of a part image",
      description: "Stage a part-image replacement using an opaque temporary upload_ref obtained from prepare_part_image_upload.",
      inputSchema: {
        ...planInputFields,
        part_id: entityIdSchema(),
        upload_ref: z.string().startsWith("upload_"),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const partId = normalizeEntityId(input.part_id);
        const partOutput = plannedOutput(oauth, auth, input.plan_id, partId, "part");
        const part = typeof partId === "number" ? await getPart(client, partId) : undefined;
        if (part) ensureUnlocked(part);
        const upload = imageUploads.get(input.upload_ref, authenticatedCredentialsId(auth));
        const identity = plannedLabel(partOutput, part ? formatRef(partRef(part)) : `Part ${String(partId)}`);
        const currentImage = part ? optionalString(part.image) ?? optionalString(part.thumbnail) : undefined;
        const summary = [
          `Replace image for ${identity}:`,
          `- Current image: ${currentImage ? "present" : "none"}`,
          `- Upload: ${upload.filename}`,
          `- Type: ${upload.mimeType}`,
          `- Dimensions: ${upload.width}x${upload.height}`,
          `- Size: ${upload.byteSize} bytes`,
          "- Side effect: replace the part image and let InvenTree regenerate its thumbnail.",
        ].join("\n");
        const checks = typeof partId === "number"
          ? await checksFor(client, [[`/api/part/${partId}/`, { category_detail: true, location_detail: true }]])
          : [];
        return stageMutation(oauth, auth, input, summary, [{
          method: "PATCH",
          path: mutationPath("/api/part/", partId),
          body: {},
          imageUpload: { uploadRef: upload.ref, field: "image" },
        }], checks);
      }),
  );

  server.registerTool(
    "receive_stock",
    {
      title: "Prepare receipt of stock",
      description:
        "Prepare adding newly acquired quantity to a compatible stock item or creating a new stock item. IDs are validated and the selected behavior is previewed.",
      inputSchema: {
        ...planInputFields,
        part_id: entityIdSchema(),
        quantity: positiveQuantity,
        location_id: entityIdSchema(),
        merge: z.enum(["compatible", "new_item", "stock_item"]).default("compatible"),
        stock_item_id: entityIdSchema().optional(),
        batch: z.string().max(100).nullable().optional(),
        packaging: z.string().max(50).nullable().optional(),
        expiry_date: z.string().date().nullable().optional(),
        notes: optionalText(),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        if (input.merge === "stock_item" && !input.stock_item_id) {
          throw new Error("stock_item_id is required when merge is stock_item");
        }
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const partId = normalizeEntityId(input.part_id);
        const locationId = normalizeEntityId(input.location_id);
        const partOutput = plannedOutput(oauth, auth, input.plan_id, partId, "part");
        const locationOutput = plannedOutput(oauth, auth, input.plan_id, locationId, "stock_location");
        const [part, location] = await Promise.all([
          typeof partId === "number" ? getPart(client, partId) : undefined,
          typeof locationId === "number" ? getLocation(client, locationId) : undefined,
        ]);
        if (part) ensureUnlocked(part);
        if (location) ensureStockDestination(location);
        if (metadataBoolean(locationOutput, "structural")) {
          throw new Error(`${locationOutput!.display} is structural and cannot directly contain stock`);
        }
        if ((partOutput || locationOutput) && input.merge === "compatible") {
          throw new Error("merge=compatible cannot search entities that do not exist yet; use merge=new_item or an explicit stock_item_id ref");
        }
        let target: JsonRecord | undefined;
        let targetOutput: MutationOutput | undefined;
        const query = {
          part: partId,
          location: locationId,
          in_stock: true,
          limit: 100,
          offset: 0,
          part_detail: false,
          location_detail: true,
        };
        const listed = typeof partId === "number" && typeof locationId === "number"
          ? await client.get("/api/stock/", query)
          : { results: [] };
        if (input.merge === "stock_item") {
          const stockId = normalizeEntityId(input.stock_item_id!);
          targetOutput = plannedOutput(oauth, auth, input.plan_id, stockId, "stock_item");
          target = typeof stockId === "number" ? await getStock(client, stockId) : undefined;
          if (target && (numberValue(target.part) !== partId || numberValue(target.location) !== locationId)) {
            throw new Error("The selected stock item does not match the requested part and location");
          }
          if (target && (numberValue(target.status, 10) !== 10 || target.expired === true)) {
            throw new Error("New stock cannot be merged into a non-OK or expired stock item");
          }
        } else if (input.merge === "compatible") {
          const compatible = pageResults(listed).filter(
            (item) =>
              numberValue(item.status, 10) === 10 &&
              item.expired !== true &&
              (optionalString(item.batch) ?? null) === (input.batch || null) &&
              (optionalString(item.packaging) ?? null) === (input.packaging || null) &&
              (optionalString(item.expiry_date) ?? null) === (input.expiry_date || null),
          );
          if (compatible.length > 1) {
            throw new Error(
              `Multiple compatible stock items found: ${compatible.map((item) => `#${numberValue(item.pk)}`).join(", ")}. Select stock_item explicitly or use new_item.`,
            );
          }
          target = compatible[0];
        }
        const targetId = input.stock_item_id === undefined ? undefined : normalizeEntityId(input.stock_item_id);
        const requests: MutationRequest[] = target || targetOutput
          ? [
              {
                method: "POST",
                path: "/api/stock/add/",
                body: {
                  items: [{ pk: target ? numberValue(target.pk) : mutationValue(targetId!), quantity: String(input.quantity) }],
                  ...(input.notes ? { notes: input.notes } : {}),
                },
              },
            ]
          : [
              {
                method: "POST",
                path: "/api/stock/",
                body: {
                  part: mutationValue(partId),
                  quantity: input.quantity,
                  location: mutationValue(locationId),
                  ...(input.batch ? { batch: input.batch } : {}),
                  ...(input.packaging ? { packaging: input.packaging } : {}),
                  ...(input.expiry_date ? { expiry_date: input.expiry_date } : {}),
                  ...(input.notes ? { notes: input.notes } : {}),
                },
              },
            ];
        const partDisplay = plannedLabel(partOutput, formatRef(part ? partRef(part) : undefined));
        const locationDisplay = plannedLabel(locationOutput, formatRef(refOrFallback(location, "Location", Number(locationId))));
        const units = part ? optionalString(part.units) : optionalString(partOutput?.metadata?.units);
        const summary = target
          ? `Receive ${formatQuantity(input.quantity, units)} of ${partDisplay}\n` +
            `- Add to stock #${numberValue(target.pk)} in ${locationDisplay}: ` +
            `${formatQuantity(numberValue(target.quantity), units)} -> ${formatQuantity(numberValue(target.quantity) + input.quantity, units)}`
          : targetOutput
            ? `Receive ${formatQuantity(input.quantity, units)} of ${partDisplay}\n- Add to planned stock ${targetOutput.display} (ref ${targetOutput.ref})`
            : `Receive ${formatQuantity(input.quantity, units)} of ${partDisplay}\n- Create a new stock item in ${locationDisplay}`;
        const detailedSummary = [
          summary,
          ...(input.batch ? [`- Batch: ${input.batch}`] : []),
          ...(input.packaging ? [`- Packaging: ${input.packaging}`] : []),
          ...(input.expiry_date ? [`- Expiry: ${input.expiry_date}`] : []),
          ...(input.notes ? [`- Notes: ${input.notes}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [];
        if (typeof partId === "number") checkPaths.push([`/api/part/${partId}/`, { category_detail: true, location_detail: true }]);
        if (typeof locationId === "number") checkPaths.push([`/api/stock/location/${locationId}/`, { path_detail: true }]);
        if (typeof partId === "number" && typeof locationId === "number") checkPaths.push(["/api/stock/", query]);
        if (typeof targetId === "number") checkPaths.push([`/api/stock/${targetId}/`, { part_detail: true, location_detail: true, path_detail: true }]);
        const outputs: PlannedOutputInput[] | undefined = target || targetOutput
          ? undefined
          : [{
              name: "stock_item",
              entityType: "stock_item",
              requestIndex: 0,
              responsePaths: [[0, "pk"], ["pk"]],
              display: `${partDisplay} in ${locationDisplay}`,
              metadata: { part_name: partDisplay, location: locationDisplay, quantity: input.quantity },
            }];
        return stageMutation(oauth, auth, input, detailedSummary, requests, await checksFor(client, checkPaths), outputs);
      }),
  );

  server.registerTool(
    "consume_stock",
    {
      title: "Prepare consumption of stock",
      description:
        "Prepare removal of a used or discarded quantity from eligible stock. Returns an explicit per-stock-item allocation and never consumes unavailable stock.",
      inputSchema: {
        ...planInputFields,
        part_id: entityIdSchema(),
        quantity: positiveQuantity,
        location_id: entityIdSchema().optional(),
        stock_item_id: entityIdSchema().optional(),
        strategy: z.enum(["fewest_items", "oldest_first"]).optional(),
        reason: z.enum(["used", "discarded", "lost", "other"]).default("used"),
        notes: optionalText(),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const partId = normalizeEntityId(input.part_id);
        const locationId = input.location_id === undefined ? undefined : normalizeEntityId(input.location_id);
        const stockId = input.stock_item_id === undefined ? undefined : normalizeEntityId(input.stock_item_id);
        const partOutput = plannedOutput(oauth, auth, input.plan_id, partId, "part");
        const locationOutput = locationId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, locationId, "stock_location");
        const stockOutput = stockId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, stockId, "stock_item");
        const part = typeof partId === "number" ? await getPart(client, partId) : undefined;
        const note = [input.reason, input.notes].filter(Boolean).join(": ");
        if (stockOutput) {
          const partDisplay = plannedLabel(partOutput, part ? formatRef(partRef(part)) : `Part ${String(partId)}`);
          const summary = [
            `Consume ${formatQuantity(input.quantity, part ? optionalString(part.units) : undefined)} of ${partDisplay}:`,
            `- Planned stock ${stockOutput.display} (ref ${stockOutput.ref}): remove ${input.quantity}`,
            ...(locationOutput ? [`- Expected location: ${locationOutput.display} (ref ${locationOutput.ref})`] : []),
            ...(note ? [`- Note: ${note}`] : []),
          ].join("\n");
          const checks: MutationCheck[] = typeof partId === "number"
            ? await checksFor(client, [[`/api/part/${partId}/`, { category_detail: true, location_detail: true }]])
            : [];
          return stageMutation(oauth, auth, input, summary, [{
            method: "POST",
            path: "/api/stock/remove/",
            body: { items: [{ pk: mutationValue(stockId!), quantity: String(input.quantity) }], ...(note ? { notes: note } : {}) },
          }], checks);
        }
        if (typeof partId !== "number" || (locationId !== undefined && typeof locationId !== "number")) {
          throw new Error("Consuming planned entities requires an explicit stock_item_id ref from an earlier step");
        }
        if (!part) throw new Error("Part was not found");
        ensureUnlocked(part);
        const query = {
          part: partId,
          location: locationId,
          in_stock: true,
          available: true,
          limit: 100,
          offset: 0,
          part_detail: false,
          location_detail: true,
          ordering: input.strategy === "oldest_first" ? "updated" : "-quantity",
        };
        const listed = await client.get("/api/stock/", query);
        let eligible = pageResults(listed).filter(
          (item) =>
            numberValue(item.status, 10) === 10 &&
            item.expired !== true &&
            numberValue(item.quantity) - numberValue(item.allocated) > 0,
        );
        if (typeof stockId === "number") {
          const selected = await getStock(client, stockId);
          if (numberValue(selected.part) !== partId) throw new Error("The selected stock item belongs to another part");
          if (typeof locationId === "number" && numberValue(selected.location) !== locationId) {
            throw new Error("The selected stock item is not in the requested location");
          }
          if (
            numberValue(selected.status, 10) !== 10 ||
            selected.expired === true ||
            numberValue(selected.quantity) - numberValue(selected.allocated) <= 0
          ) {
            throw new Error("The selected stock item is not eligible for consumption");
          }
          eligible = [selected];
        }
        const locationIds = new Set(eligible.map((item) => numberValue(item.location)).filter(Boolean));
        if (!input.stock_item_id && !input.location_id && locationIds.size > 1 && !input.strategy) {
          throw new Error(
            `Stock exists in multiple locations: ${eligible
              .map((item) => `${formatRef(stockLocationRef(item))} [stock #${numberValue(item.pk)}]`)
              .join("; ")}. Specify location_id, stock_item_id, or an allocation strategy.`,
          );
        }
        if (input.strategy === "fewest_items") {
          eligible.sort((left, right) => numberValue(right.quantity) - numberValue(left.quantity));
        } else if (input.strategy === "oldest_first") {
          eligible.sort((left, right) => stringValue(left.updated).localeCompare(stringValue(right.updated)));
        }
        let remaining = input.quantity;
        const allocation: Array<{ item: JsonRecord; quantity: number }> = [];
        for (const item of eligible) {
          const available = Math.max(0, numberValue(item.quantity) - numberValue(item.allocated));
          const quantity = Math.min(available, remaining);
          if (quantity > 0) allocation.push({ item, quantity });
          remaining -= quantity;
          if (remaining <= 0) break;
        }
        if (remaining > 0) {
          const available = input.quantity - remaining;
          throw new Error(`Insufficient eligible stock: requested ${input.quantity}, available ${available}`);
        }
        const summary = [
          `Consume ${formatQuantity(input.quantity, optionalString(part.units))} of ${formatRef(partRef(part))}:`,
          ...allocation.map(({ item, quantity }) =>
            `- Stock #${numberValue(item.pk)} in ${formatRef(stockLocationRef(item))}: ` +
            `${formatQuantity(numberValue(item.quantity), optionalString(part.units))} -> ` +
            `${formatQuantity(numberValue(item.quantity) - quantity, optionalString(part.units))}`,
          ),
          ...(note ? [`- Note: ${note}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          [`/api/part/${partId}/`, { category_detail: true, location_detail: true }],
          ["/api/stock/", query],
          ...allocation.map(({ item }) => [`/api/stock/${numberValue(item.pk)}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>]),
        ];
        return stageMutation(oauth, auth, input, summary, [{
          method: "POST",
          path: "/api/stock/remove/",
          body: {
            items: allocation.map(({ item, quantity }) => ({ pk: numberValue(item.pk), quantity: String(quantity) })),
            ...(note ? { notes: note } : {}),
          },
        }], await checksFor(client, checkPaths));
      }),
  );

  server.registerTool(
    "move_stock",
    {
      title: "Prepare a stock movement",
      description:
        "Prepare moving one stock item, a quantity of one part from a source location, or every stock item under a source location. Total quantity is preserved.",
      inputSchema: {
        ...planInputFields,
        destination_location_id: entityIdSchema(),
        stock_item_id: entityIdSchema().optional(),
        part_id: entityIdSchema().optional(),
        source_location_id: entityIdSchema().optional(),
        quantity: positiveQuantity.optional(),
        all: z.boolean().default(false),
        include_sublocations: z.boolean().default(false),
        notes: optionalText(),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const selectorCount = Number(Boolean(input.stock_item_id)) + Number(Boolean(input.part_id && input.source_location_id)) + Number(Boolean(input.source_location_id && input.all));
        if (selectorCount !== 1) {
          throw new Error("Select exactly one mode: stock_item_id, part_id with source_location_id, or source_location_id with all=true");
        }
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const destinationId = normalizeEntityId(input.destination_location_id);
        const stockId = input.stock_item_id === undefined ? undefined : normalizeEntityId(input.stock_item_id);
        const partId = input.part_id === undefined ? undefined : normalizeEntityId(input.part_id);
        const sourceId = input.source_location_id === undefined ? undefined : normalizeEntityId(input.source_location_id);
        const destinationOutput = plannedOutput(oauth, auth, input.plan_id, destinationId, "stock_location");
        const stockOutput = stockId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, stockId, "stock_item");
        const destination = typeof destinationId === "number" ? await getLocation(client, destinationId) : undefined;
        if (destination) ensureStockDestination(destination);
        if (metadataBoolean(destinationOutput, "structural")) throw new Error(`${destinationOutput!.display} is structural and cannot directly contain stock`);
        if (!stockOutput && (typeof partId === "string" || typeof sourceId === "string")) {
          throw new Error("Moving from planned entities requires an explicit stock_item_id ref from an earlier step");
        }
        const query = {
          part: partId,
          location: sourceId,
          cascade: input.include_sublocations,
          in_stock: true,
          limit: 100,
          offset: 0,
          part_detail: true,
          location_detail: true,
          path_detail: true,
        };
        let items: JsonRecord[];
        if (typeof stockId === "number") items = [await getStock(client, stockId)];
        else if (stockOutput) items = [];
        else items = pageResults(await client.get("/api/stock/", query));
        if (stockOutput && input.quantity === undefined) {
          throw new Error("quantity is required when moving a planned stock_item_id ref");
        }
        if (!items.length && !stockOutput) throw new Error("No matching stock items found to move");
        if (input.quantity !== undefined && items.length !== 1) {
          throw new Error("A partial quantity move requires exactly one matching stock item");
        }
        const moveItems = items.map((item) => {
          const quantity = input.quantity ?? numberValue(item.quantity);
          if (quantity > numberValue(item.quantity) - numberValue(item.allocated)) {
            throw new Error(`Stock #${numberValue(item.pk)} does not have ${quantity} unallocated units available`);
          }
          return { item, quantity };
        });
        const destinationDisplay = plannedLabel(destinationOutput, formatRef(refOrFallback(destination, "Location", Number(destinationId))));
        const plannedMove = stockOutput ? [{ id: stockId!, quantity: input.quantity!, output: stockOutput }] : [];
        const summary = [
          `Move stock to ${destinationDisplay}:`,
          ...moveItems.map(({ item, quantity }) =>
            `- ${formatRef(stockPartRef(item))}: ${formatQuantity(quantity, optionalString(record(item.part_detail).units))} ` +
            `from ${formatRef(stockLocationRef(item))} [stock #${numberValue(item.pk)}]`,
          ),
          ...plannedMove.map(({ output, quantity }) => `- Planned stock ${output.display} (ref ${output.ref}): ${formatQuantity(quantity)}`),
          ...(moveItems.some(({ item, quantity }) => quantity < numberValue(item.quantity))
            ? ["- Partial move: InvenTree will split the source and assign a new stock-item ID at commit."]
            : stockOutput ? ["- Planned move: stock identity resolves at commit."] : ["- Full move: existing stock-item IDs are retained."]),
          ...(input.notes ? [`- Note: ${input.notes}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          ...moveItems.map(({ item }) => [`/api/stock/${numberValue(item.pk)}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>]),
        ];
        if (typeof destinationId === "number") checkPaths.unshift([`/api/stock/location/${destinationId}/`, { path_detail: true }]);
        if (!input.stock_item_id) checkPaths.push(["/api/stock/", query]);
        return stageMutation(oauth, auth, input, summary, [{
          method: "POST",
          path: "/api/stock/transfer/",
          body: {
            items: [
              ...moveItems.map(({ item, quantity }) => ({ pk: numberValue(item.pk), quantity: String(quantity) })),
              ...plannedMove.map(({ id, quantity }) => ({ pk: mutationValue(id), quantity: String(quantity) })),
            ],
            location: mutationValue(destinationId),
            ...(input.notes ? { notes: input.notes } : {}),
          },
        }], await checksFor(client, checkPaths));
      }),
  );

  server.registerTool(
    "count_stock",
    {
      title: "Prepare a physical stock count",
      description: "Prepare reconciliation of recorded stock quantities with observed physical counts.",
      inputSchema: {
        ...planInputFields,
        counts: z.array(z.object({ stock_item_id: entityIdSchema(), observed_quantity: z.number().nonnegative().finite() })).min(1).max(100),
        location_id: entityIdSchema().optional(),
        notes: optionalText(),
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const ids = input.counts.map((count) => normalizeEntityId(count.stock_item_id));
        if (new Set(ids).size !== ids.length) throw new Error("Each stock_item_id may be counted only once");
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const locationId = input.location_id === undefined ? undefined : normalizeEntityId(input.location_id);
        if (locationId !== undefined) plannedOutput(oauth, auth, input.plan_id, locationId, "stock_location");
        const entries = await Promise.all(input.counts.map(async (count, index) => {
          const id = ids[index]!;
          const output = plannedOutput(oauth, auth, input.plan_id, id, "stock_item");
          const item = typeof id === "number" ? await getStock(client, id) : undefined;
          return { id, output, item, observed: count.observed_quantity };
        }));
        if (typeof locationId === "number" && entries.some(({ item }) => item && numberValue(item.location) !== locationId)) {
          throw new Error("One or more stock items are not in the stated stocktake location");
        }
        const changed = entries.filter(({ item, observed }) => !item || numberValue(item.quantity) !== observed);
        if (!changed.length) {
          return result(
            { status: "already_current", unchanged_stock_item_ids: ids },
            `${entries.length === 1 ? "The observed stock quantity is" : `All ${entries.length} observed stock quantities are`} already current; no plan step was created.`,
          );
        }
        const summary = [
          `Count ${changed.length} changed stock item${changed.length === 1 ? "" : "s"}:`,
          ...changed.map(({ id, item, output, observed }) => {
            if (!item) return `- Planned stock ${output!.display} (ref ${String(id)}): assigned at commit -> ${observed}`;
            const current = numberValue(item.quantity);
            return `- ${formatRef(stockPartRef(item))} [stock #${numberValue(item.pk)}]: ${current} -> ${observed} (${observed - current >= 0 ? "+" : ""}${observed - current})`;
          }),
          ...(input.notes ? [`- Note: ${input.notes}`] : []),
        ].join("\n");
        return stageMutation(oauth, auth, input, summary, [{
          method: "POST",
          path: "/api/stock/count/",
          body: {
            items: changed.map(({ id, observed }) => ({ pk: mutationValue(id), quantity: String(observed) })),
            ...(locationId !== undefined ? { location: mutationValue(locationId) } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
          },
        }], await checksFor(
          client,
          [
            ...changed.flatMap(({ id }) => typeof id === "number"
              ? [[`/api/stock/${id}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>]]
              : []),
            ...(typeof locationId === "number" ? [[`/api/stock/location/${locationId}/`, { path_detail: true }] as [string, Record<string, unknown>]] : []),
          ],
        ));
      }),
  );

  server.registerTool(
    "set_stock_status",
    {
      title: "Prepare stock-status changes",
      description: "Prepare marking stock items OK, damaged, lost, quarantined, or another supported semantic status.",
      inputSchema: {
        ...planInputFields,
        stock_item_ids: z.array(entityIdSchema()).min(1).max(100),
        status: z.enum(["ok", "attention_needed", "damaged", "destroyed", "rejected", "lost", "quarantined", "returned"]),
        notes: optionalText(),
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const ids = [...new Set(input.stock_item_ids.map(normalizeEntityId))];
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const entries = await Promise.all(ids.map(async (id) => ({
          id,
          output: plannedOutput(oauth, auth, input.plan_id, id, "stock_item"),
          item: typeof id === "number" ? await getStock(client, id) : undefined,
        })));
        const statusCode = STATUS_CODES[input.status];
        const summary = [
          `Set stock status to ${input.status.replaceAll("_", " ")} (${statusCode}):`,
          ...entries.map(({ id, item, output }) => item
            ? `- ${formatRef(stockPartRef(item))} [stock #${numberValue(item.pk)}]: ${optionalString(item.status_text) ?? item.status} -> ${input.status.replaceAll("_", " ")}`
            : `- Planned stock ${output!.display} (ref ${String(id)}): assigned at commit -> ${input.status.replaceAll("_", " ")}`),
          ...(input.notes ? [`- Note: ${input.notes}`] : []),
        ].join("\n");
        return stageMutation(
          oauth,
          auth,
          input,
          summary,
          [{ method: "POST", path: "/api/stock/change_status/", body: { items: ids.map((id) => mutationValue(id)), status: statusCode, ...(input.notes ? { note: input.notes } : {}) } }],
          await checksFor(client, ids.flatMap((id) => typeof id === "number"
            ? [[`/api/stock/${id}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>]]
            : [])),
        );
      }),
  );

  registerStructureTools(server, oauth);
  registerLabelTool(server, oauth);

  server.registerTool(
    "review_inventory_plan",
    {
      title: "Review an inventory plan",
      description: "Show every staged step, immutable step ID, and future entity reference in one shared inventory plan.",
      inputSchema: { plan_id: z.string().min(16) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ plan_id }, extra) =>
      safely(oauth, async () => {
        const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
        const reviewed = reviewPlan(oauth, auth, plan_id);
        return result(
          {
            status: reviewed.plan.state,
            plan_id,
            plan_version: reviewed.plan.version,
            steps: reviewed.plan.steps.map((step, index) => ({
              position: index + 1,
              step_id: step.id,
              operation_id: step.operationId,
              summary: step.summary,
              operation_count: step.requests.length,
              outputs: step.outputs.map(({ ref, name, entityType, display }) => ({ ref, name, entity_type: entityType, display })),
            })),
          },
          reviewed.text,
        );
      }),
  );

  server.registerTool(
    "remove_inventory_plan_step",
    {
      title: "Remove a staged inventory-plan step",
      description: "Remove a step by immutable ID. Dependent steps are rejected unless cascade is explicitly enabled.",
      inputSchema: {
        plan_id: z.string().min(16),
        expected_version: z.number().int().positive(),
        step_id: z.string().startsWith("stp_"),
        cascade: z.boolean().default(false),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) => safely(oauth, async () => {
      const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
      const plan = removePlanStep(oauth, auth, input.plan_id, input.expected_version, input.step_id, input.cascade);
      return result(
        { status: "staged", plan_id: plan.id, plan_version: plan.version, remaining_step_ids: plan.steps.map((step) => step.id) },
        `Removed ${input.step_id}${input.cascade ? " and its dependent steps" : ""}. Plan ${plan.id} is now version ${plan.version} with ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}.`,
      );
    }),
  );

  server.registerTool(
    "discard_inventory_plan",
    {
      title: "Discard an inventory plan",
      description: "Discard a staged plan without changing InvenTree.",
      inputSchema: { plan_id: z.string().min(16) },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ plan_id }, extra) => safely(oauth, async () => {
      const { auth } = clientFor(oauth, extra.authInfo, "inventree.write");
      discardPlan(oauth, auth, plan_id);
      return result({ status: "discarded", plan_id }, `Discarded inventory plan ${plan_id}. No InvenTree changes were made.`);
    }),
  );

  server.registerTool(
    "commit_inventory_plan",
    {
      title: "Commit a reviewed inventory plan",
      description: "After the user's single final confirmation, revalidate and execute all staged steps serially. Safe retries return the recorded result.",
      inputSchema: { plan_id: z.string().min(16), expected_version: z.number().int().positive() },
      annotations: commitAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async ({ plan_id, expected_version }, extra) => safely(oauth, async () => {
      const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
      const committed = await commitPlan(oauth, auth, client, plan_id, expected_version, imageUploads);
      const resolved = Object.entries(committed.result.resolvedRefs).map(([ref, id]) => `${ref}=#${id}`);
      return result(
        {
          status: committed.result.status,
          plan_id,
          plan_version: committed.plan.version,
          completed_steps: committed.result.completedSteps,
          completed_requests: committed.result.completedRequests,
          resolved_refs: committed.result.resolvedRefs,
          result_ids: committed.result.resultIds,
          ...(committed.result.failedStepId ? { failed_step_id: committed.result.failedStepId } : {}),
          ...(committed.result.error ? { error: committed.result.error } : {}),
        },
        `Committed ${committed.result.completedSteps} steps (${committed.result.completedRequests} upstream operations) successfully.${resolved.length ? ` Resolved references: ${resolved.join(", ")}.` : ""}`,
      );
    }),
  );
}

function registerStructureTools(server: McpServer, oauth: OAuthService): void {
  const categoryFields = {
    ...planInputFields,
    name: z.string().min(1).max(100),
    parent_id: nullableEntityIdSchema().optional(),
    description: z.string().max(250).default(""),
    structural: z.boolean().default(false),
    default_location_id: nullableEntityIdSchema().optional(),
    default_keywords: z.string().max(250).nullable().optional(),
  };
  server.registerTool(
    "create_part_category",
    {
      title: "Prepare a new part category",
      description: "Validate the parent and sibling names, then prepare creation of a part category.",
      inputSchema: categoryFields,
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const parentId = input.parent_id === null || input.parent_id === undefined ? input.parent_id : normalizeEntityId(input.parent_id);
        const locationId = input.default_location_id === null || input.default_location_id === undefined
          ? input.default_location_id
          : normalizeEntityId(input.default_location_id);
        const parentOutput = parentId === null || parentId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, parentId, "part_category");
        const locationOutput = locationId === null || locationId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, locationId, "stock_location");
        const parent = typeof parentId === "number" ? await getCategory(client, parentId) : undefined;
        const location = typeof locationId === "number" ? await getLocation(client, locationId) : undefined;
        if (location) ensureStockDestination(location);
        if (metadataBoolean(locationOutput, "structural")) {
          throw new Error(`${locationOutput!.display} is structural and cannot directly contain stock`);
        }
        const siblingsQuery = {
          ...(typeof parentId === "number" ? { parent: parentId } : { top_level: true }),
          name: input.name,
          limit: 20,
          offset: 0,
        };
        const siblings = typeof parentId === "string" ? { results: [] } : await client.get("/api/part/category/", siblingsQuery);
        if (pageResults(siblings).some((item) => stringValue(item.name).localeCompare(input.name, undefined, { sensitivity: "base" }) === 0)) {
          throw new Error(`A category named ${input.name} already exists under the selected parent`);
        }
        const parentPath = parentOutput?.display ?? (parent ? stringValue(parent.pathstring) : "");
        const path = [parentPath, input.name].filter(Boolean).join("/");
        const summary = [
          `Create part category ${displayPath(path)}`,
          `- Structural: ${input.structural ? "yes" : "no"}`,
          ...(input.description ? [`- Description: ${input.description}`] : []),
          ...(locationId !== null && locationId !== undefined
            ? [`- Default location: ${plannedLabel(locationOutput, formatRef(refOrFallback(location, "Location", Number(locationId))))}`]
            : []),
          ...(input.default_keywords ? [`- Default keywords: ${input.default_keywords}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [];
        if (typeof parentId !== "string") checkPaths.push(["/api/part/category/", siblingsQuery]);
        if (typeof parentId === "number") checkPaths.push([`/api/part/category/${parentId}/`, { path_detail: true }]);
        if (typeof locationId === "number") checkPaths.push([`/api/stock/location/${locationId}/`, { path_detail: true }]);
        return stageMutation(oauth, auth, input, summary, [{ method: "POST", path: "/api/part/category/", body: { name: input.name, parent: mutationValue(parentId ?? null), description: input.description, structural: input.structural, ...(locationId !== undefined ? { default_location: mutationValue(locationId) } : {}), ...(input.default_keywords !== undefined ? { default_keywords: input.default_keywords } : {}) } }], await checksFor(client, checkPaths), [{ name: "part_category", entityType: "part_category", requestIndex: 0, responsePaths: [["pk"]], display: displayPath(path), metadata: { path: displayPath(path), structural: input.structural } }]);
      }),
  );

  server.registerTool(
    "update_part_category",
    {
      title: "Prepare changes to a part category",
      description: "Prepare renaming, reparenting, or changing defaults for a part category, with descendant impact shown.",
      inputSchema: {
        ...planInputFields,
        category_id: entityIdSchema(),
        changes: z.object({
          name: z.string().min(1).max(100).optional(),
          parent_id: nullableEntityIdSchema().optional(),
          description: z.string().max(250).optional(),
          structural: z.boolean().optional(),
          default_location_id: nullableEntityIdSchema().optional(),
          default_keywords: z.string().max(250).nullable().optional(),
        }),
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { changes } = input;
        const category_id = normalizeEntityId(input.category_id);
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const categoryOutput = plannedOutput(oauth, auth, input.plan_id, category_id, "part_category");
        const category = typeof category_id === "number" ? await getCategory(client, category_id) : undefined;
        const parentId = changes.parent_id === null || changes.parent_id === undefined ? changes.parent_id : normalizeEntityId(changes.parent_id);
        if (parentId === category_id) throw new Error("A category cannot be its own parent");
        const parentOutput = parentId === null || parentId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, parentId, "part_category");
        const newParent = typeof parentId === "number" ? await getCategory(client, parentId) : undefined;
        if (
          category &&
          newParent &&
          stringValue(newParent.pathstring).startsWith(`${stringValue(category.pathstring)}/`)
        ) {
          throw new Error("A category cannot be moved below one of its own descendants");
        }
        const defaultLocationId = changes.default_location_id === null || changes.default_location_id === undefined
          ? changes.default_location_id
          : normalizeEntityId(changes.default_location_id);
        const defaultLocationOutput = defaultLocationId === null || defaultLocationId === undefined
          ? undefined
          : plannedOutput(oauth, auth, input.plan_id, defaultLocationId, "stock_location");
        if (typeof defaultLocationId === "number") ensureStockDestination(await getLocation(client, defaultLocationId));
        if (metadataBoolean(defaultLocationOutput, "structural")) {
          throw new Error(`${defaultLocationOutput!.display} is structural and cannot directly contain stock`);
        }
        let siblingCheck: Record<string, unknown> | undefined;
        if (changes.name !== undefined || changes.parent_id !== undefined) {
          const targetParent = parentId !== undefined ? parentId : category?.parent;
          const siblingQuery = {
            ...(typeof targetParent === "number" && targetParent ? { parent: targetParent } : { top_level: true }),
            name: changes.name ?? stringValue(category?.name),
            limit: 20,
            offset: 0,
          };
          siblingCheck = siblingQuery;
          const siblings = typeof targetParent === "string" ? [] : pageResults(await client.get("/api/part/category/", siblingQuery));
          if (
            siblings.some(
              (item) =>
                numberValue(item.pk) !== category_id &&
                stringValue(item.name).localeCompare(changes.name ?? stringValue(category?.name), undefined, {
                  sensitivity: "base",
                }) === 0,
            )
          ) {
            throw new Error("A category with that name already exists under the selected parent");
          }
        }
        if (category && changes.structural === true && numberValue(category.part_count) > 0) {
          throw new Error("A category containing parts cannot be made structural");
        }
        const mapping: Array<[keyof typeof changes, string, string]> = [
          ["name", "name", "Name"], ["parent_id", "parent", "Parent ID"], ["description", "description", "Description"],
          ["structural", "structural", "Structural"], ["default_location_id", "default_location", "Default location ID"],
          ["default_keywords", "default_keywords", "Default keywords"],
        ];
        const body: Record<string, unknown> = {};
        const diffs = mapping.flatMap(([key, upstream, label]) => {
          const value = changes[key];
          if (value === undefined) return [];
          const normalizedValue = key === "parent_id" ? parentId : key === "default_location_id" ? defaultLocationId : value;
          body[upstream] = key === "parent_id" || key === "default_location_id"
            ? mutationValue(normalizedValue as EntityId | null)
            : normalizedValue;
          const displayValue = key === "parent_id" && parentOutput
            ? parentOutput.display
            : key === "default_location_id" && defaultLocationOutput
              ? defaultLocationOutput.display
              : normalizedValue;
          return category
            ? beforeAfter(label, category[upstream], displayValue) ?? []
            : [`- ${label}: assigned at commit -> ${JSON.stringify(displayValue)}`];
        });
        if (!diffs.length) throw new Error("No category changes are required");
        const oldPath = category ? stringValue(category.pathstring) || stringValue(category.name) : categoryOutput!.display;
        const oldPathSegments = pathSegments(oldPath);
        const currentParentPath = oldPathSegments.slice(0, -1).join(" > ");
        const newParentPath =
          changes.parent_id === undefined
            ? currentParentPath
            : parentOutput?.display ?? (newParent ? displayPath(stringValue(newParent.pathstring)) : "");
        const newName = changes.name ?? (stringValue(category?.name) || oldPathSegments.at(-1));
        const newPath = [newParentPath, newName].filter(Boolean).join(" > ");
        const summary = [
          `Update category ${plannedLabel(categoryOutput, formatRef(refOrFallback(category, "Category", Number(category_id))))}:`,
          ...(oldPath !== newPath ? [`- Path: ${displayPath(oldPath)} -> ${displayPath(newPath)}`] : []),
          ...diffs,
          ...(category ? [`- Impact: ${numberValue(category.subcategories)} descendant categories; ${numberValue(category.part_count)} directly assigned parts`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [];
        if (typeof category_id === "number") checkPaths.push([`/api/part/category/${category_id}/`, { path_detail: true }]);
        if (typeof parentId === "number") checkPaths.push([`/api/part/category/${parentId}/`, { path_detail: true }]);
        if (typeof defaultLocationId === "number") checkPaths.push([`/api/stock/location/${defaultLocationId}/`, { path_detail: true }]);
        if (siblingCheck && typeof (parentId !== undefined ? parentId : category?.parent) !== "string") checkPaths.push(["/api/part/category/", siblingCheck]);
        return stageMutation(oauth, auth, input, summary, [{ method: "PATCH", path: mutationPath("/api/part/category/", category_id), body }], await checksFor(client, checkPaths));
      }),
  );

  const locationFields = {
    ...planInputFields,
    name: z.string().min(1).max(100),
    parent_id: nullableEntityIdSchema().optional(),
    description: z.string().max(250).default(""),
    structural: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
  };
  server.registerTool(
    "create_stock_location",
    {
      title: "Prepare a new stock location",
      description: "Validate the physical parent and sibling names, then prepare creation of a stock location.",
      inputSchema: locationFields,
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const parentId = input.parent_id === null || input.parent_id === undefined ? input.parent_id : normalizeEntityId(input.parent_id);
        const parentOutput = parentId === null || parentId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, parentId, "stock_location");
        const parent = typeof parentId === "number" ? await getLocation(client, parentId) : undefined;
        const siblingsQuery = {
          ...(typeof parentId === "number" ? { parent: parentId } : { top_level: true }),
          name: input.name,
          limit: 20,
          offset: 0,
        };
        const siblings = typeof parentId === "string" ? { results: [] } : await client.get("/api/stock/location/", siblingsQuery);
        if (pageResults(siblings).some((item) => stringValue(item.name).localeCompare(input.name, undefined, { sensitivity: "base" }) === 0)) {
          throw new Error(`A location named ${input.name} already exists under the selected parent`);
        }
        const path = [parentOutput?.display ?? (parent ? stringValue(parent.pathstring) : ""), input.name].filter(Boolean).join("/");
        const summary = [
          `Create stock location ${displayPath(path)}`,
          `- Structural: ${input.structural ? "yes" : "no"}`,
          ...(input.description ? [`- Description: ${input.description}`] : []),
          ...(input.tags.length ? [`- Tags: ${input.tags.join(", ")}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [];
        if (typeof parentId !== "string") checkPaths.push(["/api/stock/location/", siblingsQuery]);
        if (typeof parentId === "number") checkPaths.push([`/api/stock/location/${parentId}/`, { path_detail: true }]);
        return stageMutation(oauth, auth, input, summary, [{ method: "POST", path: "/api/stock/location/", body: { name: input.name, parent: mutationValue(parentId ?? null), description: input.description, structural: input.structural, tags: input.tags } }], await checksFor(client, checkPaths), [{ name: "stock_location", entityType: "stock_location", requestIndex: 0, responsePaths: [["pk"]], display: displayPath(path), metadata: { path: displayPath(path), structural: input.structural } }]);
      }),
  );

  server.registerTool(
    "update_stock_location",
    {
      title: "Prepare changes to a stock location",
      description: "Prepare renaming, reparenting, or changing a physical stock location, with descendant and item impact shown.",
      inputSchema: {
        ...planInputFields,
        location_id: entityIdSchema(),
        changes: z.object({
          name: z.string().min(1).max(100).optional(),
          parent_id: nullableEntityIdSchema().optional(),
          description: z.string().max(250).optional(),
          structural: z.boolean().optional(),
          tags: z.array(z.string()).optional(),
        }),
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { changes } = input;
        const location_id = normalizeEntityId(input.location_id);
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const locationOutput = plannedOutput(oauth, auth, input.plan_id, location_id, "stock_location");
        const location = typeof location_id === "number" ? await getLocation(client, location_id) : undefined;
        const parentId = changes.parent_id === null || changes.parent_id === undefined ? changes.parent_id : normalizeEntityId(changes.parent_id);
        if (parentId === location_id) throw new Error("A location cannot be its own parent");
        const parentOutput = parentId === null || parentId === undefined ? undefined : plannedOutput(oauth, auth, input.plan_id, parentId, "stock_location");
        const newParent = typeof parentId === "number" ? await getLocation(client, parentId) : undefined;
        if (
          location &&
          newParent &&
          stringValue(newParent.pathstring).startsWith(`${stringValue(location.pathstring)}/`)
        ) {
          throw new Error("A location cannot be moved below one of its own descendants");
        }
        if (location && changes.structural === true && numberValue(location.items) > 0) {
          throw new Error("A location containing stock cannot be made structural");
        }
        let siblingCheck: Record<string, unknown> | undefined;
        if (changes.name !== undefined || changes.parent_id !== undefined) {
          const targetParent = parentId !== undefined ? parentId : location?.parent;
          const siblingQuery = {
            ...(typeof targetParent === "number" && targetParent ? { parent: targetParent } : { top_level: true }),
            name: changes.name ?? stringValue(location?.name),
            limit: 20,
            offset: 0,
          };
          siblingCheck = siblingQuery;
          const siblings = typeof targetParent === "string" ? [] : pageResults(await client.get("/api/stock/location/", siblingQuery));
          if (
            siblings.some(
              (item) =>
                numberValue(item.pk) !== location_id &&
                stringValue(item.name).localeCompare(changes.name ?? stringValue(location?.name), undefined, {
                  sensitivity: "base",
                }) === 0,
            )
          ) {
            throw new Error("A location with that name already exists under the selected parent");
          }
        }
        const mapping: Array<[keyof typeof changes, string, string]> = [
          ["name", "name", "Name"], ["parent_id", "parent", "Parent ID"], ["description", "description", "Description"],
          ["structural", "structural", "Structural"], ["tags", "tags", "Tags"],
        ];
        const body: Record<string, unknown> = {};
        const diffs = mapping.flatMap(([key, upstream, label]) => {
          const value = changes[key];
          if (value === undefined) return [];
          const normalizedValue = key === "parent_id" ? parentId : value;
          body[upstream] = key === "parent_id" ? mutationValue(normalizedValue as EntityId | null) : normalizedValue;
          const displayValue = key === "parent_id" && parentOutput ? parentOutput.display : normalizedValue;
          return location
            ? beforeAfter(label, location[upstream], displayValue) ?? []
            : [`- ${label}: assigned at commit -> ${JSON.stringify(displayValue)}`];
        });
        if (!diffs.length) throw new Error("No location changes are required");
        const oldPath = location ? stringValue(location.pathstring) || stringValue(location.name) : locationOutput!.display;
        const oldPathSegments = pathSegments(oldPath);
        const currentParentPath = oldPathSegments.slice(0, -1).join(" > ");
        const newParentPath =
          changes.parent_id === undefined
            ? currentParentPath
            : parentOutput?.display ?? (newParent ? displayPath(stringValue(newParent.pathstring)) : "");
        const newName = changes.name ?? (stringValue(location?.name) || oldPathSegments.at(-1));
        const newPath = [newParentPath, newName].filter(Boolean).join(" > ");
        const summary = [
          `Update location ${plannedLabel(locationOutput, formatRef(refOrFallback(location, "Location", Number(location_id))))}:`,
          ...(oldPath !== newPath ? [`- Path: ${displayPath(oldPath)} -> ${displayPath(newPath)}`] : []),
          ...diffs,
          ...(location ? [`- Impact: ${numberValue(location.sublocations)} descendant locations; ${numberValue(location.items)} stock items`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [];
        if (typeof location_id === "number") checkPaths.push([`/api/stock/location/${location_id}/`, { path_detail: true }]);
        if (typeof parentId === "number") checkPaths.push([`/api/stock/location/${parentId}/`, { path_detail: true }]);
        if (siblingCheck && typeof (parentId !== undefined ? parentId : location?.parent) !== "string") checkPaths.push(["/api/stock/location/", siblingCheck]);
        return stageMutation(oauth, auth, input, summary, [{ method: "PATCH", path: mutationPath("/api/stock/location/", location_id), body }], await checksFor(client, checkPaths));
      }),
  );
}

function registerLabelTool(server: McpServer, oauth: OAuthService): void {
  server.registerTool(
    "print_labels",
    {
      title: "Prepare printing inventory labels",
      description: "Resolve an enabled label template by ID, name, or dimensions and prepare a real printer side effect.",
      inputSchema: {
        ...planInputFields,
        entity_type: z.enum(["part", "stock_item", "stock_location"]),
        entities: z.array(entitySelectorSchema).min(1).max(100),
        template: z.string().min(1).describe("Template ID like #20, exact name, or dimensions like 30x15mm"),
        printer: z.string().min(1).default("zebra").describe("InvenTree label printing plugin slug"),
        copies: z.number().int().min(1).max(20).default(1),
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const modelType = input.entity_type.replace("_", "");
        const query = { enabled: true, model_type: modelType, limit: 100, offset: 0 };
        const templateData = await client.get("/api/label/template/", query);
        const normalized = input.template.trim().toLocaleLowerCase();
        const templateId = /^#?(\d+)$/.exec(normalized)?.[1];
        const dimension = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*mm$/.exec(normalized);
        const matches = pageResults(templateData).filter((template) => {
          if (templateId) return numberValue(template.pk) === Number(templateId);
          if (dimension) return numberValue(template.width) === Number(dimension[1]) && numberValue(template.height) === Number(dimension[2]);
          return stringValue(template.name).toLocaleLowerCase() === normalized;
        });
        if (matches.length !== 1) {
          const choices = pageResults(templateData)
            .map((template) => `${stringValue(template.name)} (#${numberValue(template.pk)}, ${template.width}x${template.height}mm)`)
            .join(", ");
          throw new Error(`${matches.length ? "Multiple" : "No"} matching enabled templates. Choices: ${choices || "none"}`);
        }
        const template = matches[0]!;
        const entityPaths = {
          part: (id: number) => `/api/part/${id}/`,
          stock_item: (id: number) => `/api/stock/${id}/`,
          stock_location: (id: number) => `/api/stock/location/${id}/`,
        } as const;
        const expectedType = input.entity_type;
        const resolved = await Promise.all(input.entities.map(async (selector) => {
          const id = selectorId(selector);
          const output = plannedOutput(oauth, auth, input.plan_id, id, expectedType);
          if (output) {
            return { item: mutationValue(id), label: output.display, suffix: `ref ${output.ref}` };
          }
          const query = input.entity_type === "stock_item"
            ? { part_detail: true, location_detail: true, path_detail: true }
            : { path_detail: true };
          const numericId = Number(id);
          const value = record(await client.get(entityPaths[input.entity_type](numericId), query));
          let label = optionalString(value.pathstring)
            ? displayPath(stringValue(value.pathstring))
            : optionalString(value.name) ?? optionalString(value.full_name);
          if (input.entity_type === "stock_item") {
            label = `${formatRef(stockPartRef(value))} in ${formatRef(stockLocationRef(value))}`;
          }
          return {
            item: numericId,
            label: label ?? `${input.entity_type} #${numericId}`,
            suffix: input.entity_type === "stock_item" ? `stock #${numericId}` : `#${numericId}`,
          };
        }));
        const summary = [
          `Print ${input.copies} cop${input.copies === 1 ? "y" : "ies"} of ${resolved.length} ${input.entity_type.replaceAll("_", " ")} label${resolved.length === 1 ? "" : "s"}:`,
          ...resolved.map(({ label, suffix }) => `- ${label} (${suffix})`),
          `- Template: ${stringValue(template.name)} (#${numberValue(template.pk)}, ${template.width}x${template.height}mm)`,
          `- Printer plugin: ${input.printer}`,
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          ["/api/label/template/", query],
          ...input.entities.flatMap((selector) => {
            const id = selectorId(selector);
            return typeof id === "number"
              ? [[entityPaths[input.entity_type](id), input.entity_type === "stock_item" ? { part_detail: true, location_detail: true, path_detail: true } : { path_detail: true }] as [string, Record<string, unknown>]]
              : [];
          }),
        ];
        const requests: MutationRequest[] = Array.from({ length: input.copies }, () => ({
          method: "POST" as const,
          path: "/api/label/print/",
          body: { template: numberValue(template.pk), plugin: input.printer, items: resolved.map(({ item }) => item) },
        }));
        return stageMutation(oauth, auth, input, summary, requests, await checksFor(client, checkPaths));
      }),
  );
}
