import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import type { InvenTreeClient } from "./inventree.js";
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
import { clientFor, result, safely, WRITE_SECURITY } from "./mcpSupport.js";
import type { MutationCheck, MutationRequest } from "./store.js";

const positiveQuantity = z.number().positive().finite();
const optionalText = z.string().max(50_000).nullable().optional();
const planInputFields = {
  plan_id: z.string().min(16).optional().describe("Existing shared plan to append to; omit to start a new plan"),
  expected_version: z.number().int().positive().optional().describe("Required with plan_id to prevent lost updates"),
  operation_id: z.string().min(1).max(100).describe("Caller-stable idempotency key for this staged step"),
};
const entitySelectorSchema = z.union([
  z.object({ id: z.number().int().positive() }).strict(),
  z.object({ ref: z.string().min(1) }).strict(),
]);

type PlanInput = { plan_id?: string; expected_version?: number; operation_id: string };

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
  return record(await client.get(`/api/part/${id}/`, { category_detail: true, location_detail: true }));
}

async function getStock(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  return record(await client.get(`/api/stock/${id}/`, { part_detail: true, location_detail: true, path_detail: true }));
}

async function getCategory(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  return record(await client.get(`/api/part/category/${id}/`, { path_detail: true }));
}

async function getLocation(client: InvenTreeClient, id: number): Promise<JsonRecord> {
  return record(await client.get(`/api/stock/location/${id}/`, { path_detail: true }));
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

export function registerWriteTools(server: McpServer, oauth: OAuthService): void {
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
          category_id: z.number().int().positive(),
          IPN: z.string().max(100).default(""),
          keywords: z.array(z.string().min(1)).default([]),
          units: z.string().max(20).nullable().optional(),
          minimum_stock: z.number().nonnegative().default(0),
          maximum_stock: z.number().nonnegative().default(0),
          default_location_id: z.number().int().positive().nullable().optional(),
          trackable: z.boolean().default(false),
          link: z.string().url().max(2000).nullable().optional(),
          notes: optionalText,
        }),
        initial_stock: z
          .object({
            quantity: positiveQuantity,
            location_id: z.number().int().positive(),
            batch: z.string().max(100).nullable().optional(),
            packaging: z.string().max(50).nullable().optional(),
            expiry_date: z.string().date().nullable().optional(),
            notes: optionalText,
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
        const category = await getCategory(client, input.part.category_id);
        ensurePartCategory(category);
        const defaultLocation = input.part.default_location_id
          ? await getLocation(client, input.part.default_location_id)
          : undefined;
        if (defaultLocation) ensureStockDestination(defaultLocation);
        const stockLocation = input.initial_stock
          ? await getLocation(client, input.initial_stock.location_id)
          : undefined;
        if (stockLocation) ensureStockDestination(stockLocation);

        const duplicateQuery = { search: input.part.name, active: true, limit: 10, offset: 0 };
        const duplicates = await client.get("/api/part/", duplicateQuery);
        const candidates = pageResults(duplicates);
        if (candidates.length && !input.allow_possible_duplicates) {
          throw new Error(
            `Possible duplicate parts found: ${candidates
              .map((candidate) => `${stringValue(candidate.name)} (#${numberValue(candidate.pk)})`)
              .join(", ")}. Reuse one, or set allow_possible_duplicates after reviewing them.`,
          );
        }

        const partBody: Record<string, unknown> = {
          name: input.part.name,
          description: input.part.description,
          category: input.part.category_id,
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
          ...(input.part.default_location_id !== undefined
            ? { default_location: input.part.default_location_id }
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
              location: input.initial_stock.location_id,
              ...(input.initial_stock.batch ? { batch: input.initial_stock.batch } : {}),
              ...(input.initial_stock.packaging ? { packaging: input.initial_stock.packaging } : {}),
              ...(input.initial_stock.expiry_date ? { expiry_date: input.initial_stock.expiry_date } : {}),
              ...(input.initial_stock.notes ? { notes: input.initial_stock.notes } : {}),
            },
          });
        }
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          [`/api/part/category/${input.part.category_id}/`, { path_detail: true }],
          ["/api/part/", duplicateQuery],
        ];
        if (input.part.default_location_id) {
          checkPaths.push([`/api/stock/location/${input.part.default_location_id}/`, { path_detail: true }]);
        }
        if (input.initial_stock && input.initial_stock.location_id !== input.part.default_location_id) {
          checkPaths.push([`/api/stock/location/${input.initial_stock.location_id}/`, { path_detail: true }]);
        }
        const summary = [
          `Create part ${input.part.name}`,
          `- Category: ${formatRef(refOrFallback(category, "Category", input.part.category_id))}`,
          ...(input.part.description ? [`- Description: ${input.part.description}`] : []),
          ...(input.part.IPN ? [`- IPN: ${input.part.IPN}`] : []),
          ...(input.part.keywords.length ? [`- Keywords: ${input.part.keywords.join(", ")}`] : []),
          ...(input.part.units ? [`- Units: ${input.part.units}`] : []),
          ...(input.part.minimum_stock ? [`- Minimum stock: ${input.part.minimum_stock}`] : []),
          ...(input.part.maximum_stock ? [`- Maximum stock: ${input.part.maximum_stock}`] : []),
          ...(input.part.trackable ? ["- Trackable: yes"] : []),
          ...(defaultLocation ? [`- Default location: ${formatRef(refOrFallback(defaultLocation, "Location", input.part.default_location_id!))}`] : []),
          ...(input.part.link ? [`- Link: ${input.part.link}`] : []),
          ...(input.part.notes ? [`- Part notes: ${input.part.notes}`] : []),
          ...(input.initial_stock && stockLocation
            ? [
                `- Initial stock: ${formatQuantity(input.initial_stock.quantity, input.part.units ?? undefined)} in ${formatRef(
                  refOrFallback(stockLocation, "Location", input.initial_stock.location_id),
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
          { name: "part", entityType: "part", requestIndex: 0, responsePaths: [["pk"]], display: input.part.name },
          ...(input.initial_stock
            ? [{
                name: "stock_item" as const,
                entityType: "stock_item" as const,
                requestIndex: 1,
                responsePaths: [[0, "pk"], ["pk"]],
                display: `${input.part.name} in ${formatRef(refOrFallback(stockLocation!, "Location", input.initial_stock.location_id))}`,
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
        part_id: z.number().int().positive(),
        changes: z.object({
          name: z.string().min(1).max(100).optional(),
          description: z.string().max(250).optional(),
          category_id: z.number().int().positive().nullable().optional(),
          IPN: z.string().max(100).optional(),
          keywords: z.array(z.string().min(1)).optional(),
          units: z.string().max(20).nullable().optional(),
          minimum_stock: z.number().nonnegative().optional(),
          maximum_stock: z.number().nonnegative().optional(),
          default_location_id: z.number().int().positive().nullable().optional(),
          default_expiry: z.number().int().nonnegative().optional(),
          link: z.string().url().max(2000).nullable().optional(),
          notes: optionalText,
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
        const { part_id, changes } = input;
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const part = await getPart(client, part_id);
        ensureUnlocked(part);
        let category: JsonRecord | undefined;
        if (changes.category_id) {
          category = await getCategory(client, changes.category_id);
          ensurePartCategory(category);
        }
        let location: JsonRecord | undefined;
        if (changes.default_location_id) {
          location = await getLocation(client, changes.default_location_id);
          ensureStockDestination(location);
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
          body[upstreamKey] = value;
          const diff = beforeAfter(label, part[upstreamKey], value);
          if (diff) diffs.push(diff);
        }
        if (changes.keywords !== undefined) {
          body.keywords = changes.keywords.join(", ");
          const diff = beforeAfter("Keywords", part.keywords, body.keywords);
          if (diff) diffs.push(diff);
        }
        if (!Object.keys(body).length) throw new Error("At least one part change is required");
        if (!diffs.length) throw new Error("The requested part values are already current");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          [`/api/part/${part_id}/`, { category_detail: true, location_detail: true }],
        ];
        if (category) checkPaths.push([`/api/part/category/${changes.category_id}/`, { path_detail: true }]);
        if (location) checkPaths.push([`/api/stock/location/${changes.default_location_id}/`, { path_detail: true }]);
        const summary = [`Update ${formatRef(partRef(part))}:`, ...diffs].join("\n");
        return stageMutation(
          oauth,
          auth,
          input,
          summary,
          [{ method: "PATCH", path: `/api/part/${part_id}/`, body }],
          await checksFor(client, checkPaths),
        );
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
        part_id: z.number().int().positive(),
        quantity: positiveQuantity,
        location_id: z.number().int().positive(),
        merge: z.enum(["compatible", "new_item", "stock_item"]).default("compatible"),
        stock_item_id: z.number().int().positive().optional(),
        batch: z.string().max(100).nullable().optional(),
        packaging: z.string().max(50).nullable().optional(),
        expiry_date: z.string().date().nullable().optional(),
        notes: optionalText,
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
        const [part, location] = await Promise.all([
          getPart(client, input.part_id),
          getLocation(client, input.location_id),
        ]);
        ensureUnlocked(part);
        ensureStockDestination(location);
        let target: JsonRecord | undefined;
        const query = {
          part: input.part_id,
          location: input.location_id,
          in_stock: true,
          limit: 100,
          offset: 0,
          part_detail: false,
          location_detail: true,
        };
        const listed = await client.get("/api/stock/", query);
        if (input.merge === "stock_item") {
          target = await getStock(client, input.stock_item_id!);
          if (numberValue(target.part) !== input.part_id || numberValue(target.location) !== input.location_id) {
            throw new Error("The selected stock item does not match the requested part and location");
          }
          if (numberValue(target.status, 10) !== 10 || target.expired === true) {
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
        const requests: MutationRequest[] = target
          ? [
              {
                method: "POST",
                path: "/api/stock/add/",
                body: {
                  items: [{ pk: numberValue(target.pk), quantity: String(input.quantity) }],
                  ...(input.notes ? { notes: input.notes } : {}),
                },
              },
            ]
          : [
              {
                method: "POST",
                path: "/api/stock/",
                body: {
                  part: input.part_id,
                  quantity: input.quantity,
                  location: input.location_id,
                  ...(input.batch ? { batch: input.batch } : {}),
                  ...(input.packaging ? { packaging: input.packaging } : {}),
                  ...(input.expiry_date ? { expiry_date: input.expiry_date } : {}),
                  ...(input.notes ? { notes: input.notes } : {}),
                },
              },
            ];
        const summary = target
          ? `Receive ${formatQuantity(input.quantity, optionalString(part.units))} of ${formatRef(partRef(part))}\n` +
            `- Add to stock #${numberValue(target.pk)} in ${formatRef(refOrFallback(location, "Location", input.location_id))}: ` +
            `${formatQuantity(numberValue(target.quantity), optionalString(part.units))} -> ${formatQuantity(numberValue(target.quantity) + input.quantity, optionalString(part.units))}`
          : `Receive ${formatQuantity(input.quantity, optionalString(part.units))} of ${formatRef(partRef(part))}\n` +
            `- Create a new stock item in ${formatRef(refOrFallback(location, "Location", input.location_id))}`;
        const detailedSummary = [
          summary,
          ...(input.batch ? [`- Batch: ${input.batch}`] : []),
          ...(input.packaging ? [`- Packaging: ${input.packaging}`] : []),
          ...(input.expiry_date ? [`- Expiry: ${input.expiry_date}`] : []),
          ...(input.notes ? [`- Notes: ${input.notes}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          [`/api/part/${input.part_id}/`, { category_detail: true, location_detail: true }],
          [`/api/stock/location/${input.location_id}/`, { path_detail: true }],
          ["/api/stock/", query],
        ];
        if (input.stock_item_id) checkPaths.push([`/api/stock/${input.stock_item_id}/`, { part_detail: true, location_detail: true, path_detail: true }]);
        const outputs: PlannedOutputInput[] | undefined = target
          ? undefined
          : [{
              name: "stock_item",
              entityType: "stock_item",
              requestIndex: 0,
              responsePaths: [[0, "pk"], ["pk"]],
              display: `${formatRef(partRef(part))} in ${formatRef(refOrFallback(location, "Location", input.location_id))}`,
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
        part_id: z.number().int().positive(),
        quantity: positiveQuantity,
        location_id: z.number().int().positive().optional(),
        stock_item_id: z.number().int().positive().optional(),
        strategy: z.enum(["fewest_items", "oldest_first"]).optional(),
        reason: z.enum(["used", "discarded", "lost", "other"]).default("used"),
        notes: optionalText,
      },
      annotations: mutationAnnotations(),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const part = await getPart(client, input.part_id);
        ensureUnlocked(part);
        const query = {
          part: input.part_id,
          location: input.location_id,
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
        if (input.stock_item_id) {
          const selected = await getStock(client, input.stock_item_id);
          if (numberValue(selected.part) !== input.part_id) throw new Error("The selected stock item belongs to another part");
          if (input.location_id && numberValue(selected.location) !== input.location_id) {
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
        const note = [input.reason, input.notes].filter(Boolean).join(": ");
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
          [`/api/part/${input.part_id}/`, { category_detail: true, location_detail: true }],
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
        destination_location_id: z.number().int().positive(),
        stock_item_id: z.number().int().positive().optional(),
        part_id: z.number().int().positive().optional(),
        source_location_id: z.number().int().positive().optional(),
        quantity: positiveQuantity.optional(),
        all: z.boolean().default(false),
        include_sublocations: z.boolean().default(false),
        notes: optionalText,
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
        const destination = await getLocation(client, input.destination_location_id);
        ensureStockDestination(destination);
        const query = {
          part: input.part_id,
          location: input.source_location_id,
          cascade: input.include_sublocations,
          in_stock: true,
          limit: 100,
          offset: 0,
          part_detail: true,
          location_detail: true,
          path_detail: true,
        };
        let items: JsonRecord[];
        if (input.stock_item_id) items = [await getStock(client, input.stock_item_id)];
        else items = pageResults(await client.get("/api/stock/", query));
        if (!items.length) throw new Error("No matching stock items found to move");
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
        const summary = [
          `Move stock to ${formatRef(refOrFallback(destination, "Location", input.destination_location_id))}:`,
          ...moveItems.map(({ item, quantity }) =>
            `- ${formatRef(stockPartRef(item))}: ${formatQuantity(quantity, optionalString(record(item.part_detail).units))} ` +
            `from ${formatRef(stockLocationRef(item))} [stock #${numberValue(item.pk)}]`,
          ),
          ...(moveItems.some(({ item, quantity }) => quantity < numberValue(item.quantity))
            ? ["- Partial move: InvenTree will split the source and assign a new stock-item ID at commit."]
            : ["- Full move: existing stock-item IDs are retained."]),
          ...(input.notes ? [`- Note: ${input.notes}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          [`/api/stock/location/${input.destination_location_id}/`, { path_detail: true }],
          ...moveItems.map(({ item }) => [`/api/stock/${numberValue(item.pk)}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>]),
        ];
        if (!input.stock_item_id) checkPaths.push(["/api/stock/", query]);
        return stageMutation(oauth, auth, input, summary, [{
          method: "POST",
          path: "/api/stock/transfer/",
          body: {
            items: moveItems.map(({ item, quantity }) => ({ pk: numberValue(item.pk), quantity: String(quantity) })),
            location: input.destination_location_id,
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
        counts: z.array(z.object({ stock_item_id: z.number().int().positive(), observed_quantity: z.number().nonnegative().finite() })).min(1).max(100),
        location_id: z.number().int().positive().optional(),
        notes: optionalText,
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const ids = input.counts.map((count) => count.stock_item_id);
        if (new Set(ids).size !== ids.length) throw new Error("Each stock_item_id may be counted only once");
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const items = await Promise.all(ids.map((id) => getStock(client, id)));
        if (input.location_id && items.some((item) => numberValue(item.location) !== input.location_id)) {
          throw new Error("One or more stock items are not in the stated stocktake location");
        }
        const changed = items.flatMap((item, index) => {
          const count = input.counts[index]!;
          return numberValue(item.quantity) === count.observed_quantity ? [] : [{ item, count }];
        });
        if (!changed.length) {
          return result(
            { status: "already_current", unchanged_stock_item_ids: ids },
            `All ${items.length} observed stock quantities are already current; no plan step was created.`,
          );
        }
        const summary = [
          `Count ${changed.length} changed stock item${changed.length === 1 ? "" : "s"}:`,
          ...changed.map(({ item, count }) => {
            const observed = count.observed_quantity;
            const current = numberValue(item.quantity);
            return `- ${formatRef(stockPartRef(item))} [stock #${numberValue(item.pk)}]: ${current} -> ${observed} (${observed - current >= 0 ? "+" : ""}${observed - current})`;
          }),
          ...(input.notes ? [`- Note: ${input.notes}`] : []),
        ].join("\n");
        return stageMutation(oauth, auth, input, summary, [{
          method: "POST",
          path: "/api/stock/count/",
          body: {
            items: changed.map(({ count }) => ({ pk: count.stock_item_id, quantity: String(count.observed_quantity) })),
            ...(input.location_id ? { location: input.location_id } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
          },
        }], await checksFor(
          client,
          changed.map(({ item }) => [`/api/stock/${numberValue(item.pk)}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>]),
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
        stock_item_ids: z.array(z.number().int().positive()).min(1).max(100),
        status: z.enum(["ok", "attention_needed", "damaged", "destroyed", "rejected", "lost", "quarantined", "returned"]),
        notes: optionalText,
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const ids = [...new Set(input.stock_item_ids)];
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const items = await Promise.all(ids.map((id) => getStock(client, id)));
        const statusCode = STATUS_CODES[input.status];
        const summary = [
          `Set stock status to ${input.status.replaceAll("_", " ")} (${statusCode}):`,
          ...items.map((item) => `- ${formatRef(stockPartRef(item))} [stock #${numberValue(item.pk)}]: ${optionalString(item.status_text) ?? item.status} -> ${input.status.replaceAll("_", " ")}`),
          ...(input.notes ? [`- Note: ${input.notes}`] : []),
        ].join("\n");
        return stageMutation(
          oauth,
          auth,
          input,
          summary,
          [{ method: "POST", path: "/api/stock/change_status/", body: { items: ids, status: statusCode, ...(input.notes ? { note: input.notes } : {}) } }],
          await checksFor(client, ids.map((id) => [`/api/stock/${id}/`, { part_detail: true, location_detail: true, path_detail: true }] as [string, Record<string, unknown>])),
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
        `Removed ${input.step_id}${input.cascade ? " and its dependent steps" : ""}. Plan ${plan.id} is now version ${plan.version} with ${plan.steps.length} steps.`,
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
      const committed = await commitPlan(oauth, auth, client, plan_id, expected_version);
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
    parent_id: z.number().int().positive().nullable().optional(),
    description: z.string().max(250).default(""),
    structural: z.boolean().default(false),
    default_location_id: z.number().int().positive().nullable().optional(),
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
        const parent = input.parent_id ? await getCategory(client, input.parent_id) : undefined;
        const location = input.default_location_id ? await getLocation(client, input.default_location_id) : undefined;
        if (location) ensureStockDestination(location);
        const siblingsQuery = {
          ...(input.parent_id ? { parent: input.parent_id } : { top_level: true }),
          name: input.name,
          limit: 20,
          offset: 0,
        };
        const siblings = await client.get("/api/part/category/", siblingsQuery);
        if (pageResults(siblings).some((item) => stringValue(item.name).localeCompare(input.name, undefined, { sensitivity: "base" }) === 0)) {
          throw new Error(`A category named ${input.name} already exists under the selected parent`);
        }
        const path = [parent ? stringValue(parent.pathstring) : "", input.name].filter(Boolean).join("/");
        const summary = [
          `Create part category ${displayPath(path)}`,
          `- Structural: ${input.structural ? "yes" : "no"}`,
          ...(input.description ? [`- Description: ${input.description}`] : []),
          ...(location ? [`- Default location: ${formatRef(refOrFallback(location, "Location", input.default_location_id!))}`] : []),
          ...(input.default_keywords ? [`- Default keywords: ${input.default_keywords}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [["/api/part/category/", siblingsQuery]];
        if (parent) checkPaths.push([`/api/part/category/${input.parent_id}/`, { path_detail: true }]);
        if (location) checkPaths.push([`/api/stock/location/${input.default_location_id}/`, { path_detail: true }]);
        return stageMutation(oauth, auth, input, summary, [{ method: "POST", path: "/api/part/category/", body: { name: input.name, parent: input.parent_id ?? null, description: input.description, structural: input.structural, ...(input.default_location_id !== undefined ? { default_location: input.default_location_id } : {}), ...(input.default_keywords !== undefined ? { default_keywords: input.default_keywords } : {}) } }], await checksFor(client, checkPaths), [{ name: "part_category", entityType: "part_category", requestIndex: 0, responsePaths: [["pk"]], display: displayPath(path) }]);
      }),
  );

  server.registerTool(
    "update_part_category",
    {
      title: "Prepare changes to a part category",
      description: "Prepare renaming, reparenting, or changing defaults for a part category, with descendant impact shown.",
      inputSchema: {
        ...planInputFields,
        category_id: z.number().int().positive(),
        changes: z.object({
          name: z.string().min(1).max(100).optional(),
          parent_id: z.number().int().positive().nullable().optional(),
          description: z.string().max(250).optional(),
          structural: z.boolean().optional(),
          default_location_id: z.number().int().positive().nullable().optional(),
          default_keywords: z.string().max(250).nullable().optional(),
        }),
      },
      annotations: mutationAnnotations(true),
      _meta: { securitySchemes: WRITE_SECURITY },
    },
    async (input, extra) =>
      safely(oauth, async () => {
        const { category_id, changes } = input;
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const category = await getCategory(client, category_id);
        if (changes.parent_id === category_id) throw new Error("A category cannot be its own parent");
        const newParent = changes.parent_id ? await getCategory(client, changes.parent_id) : undefined;
        if (
          newParent &&
          stringValue(newParent.pathstring).startsWith(`${stringValue(category.pathstring)}/`)
        ) {
          throw new Error("A category cannot be moved below one of its own descendants");
        }
        if (changes.default_location_id) ensureStockDestination(await getLocation(client, changes.default_location_id));
        let siblingCheck: Record<string, unknown> | undefined;
        if (changes.name !== undefined || changes.parent_id !== undefined) {
          const targetParent = changes.parent_id !== undefined ? changes.parent_id : category.parent;
          const siblingQuery = {
            ...(targetParent ? { parent: numberValue(targetParent) } : { top_level: true }),
            name: changes.name ?? stringValue(category.name),
            limit: 20,
            offset: 0,
          };
          siblingCheck = siblingQuery;
          const siblings = pageResults(await client.get("/api/part/category/", siblingQuery));
          if (
            siblings.some(
              (item) =>
                numberValue(item.pk) !== category_id &&
                stringValue(item.name).localeCompare(changes.name ?? stringValue(category.name), undefined, {
                  sensitivity: "base",
                }) === 0,
            )
          ) {
            throw new Error("A category with that name already exists under the selected parent");
          }
        }
        if (changes.structural === true && numberValue(category.part_count) > 0) {
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
          body[upstream] = value;
          return beforeAfter(label, category[upstream], value) ?? [];
        });
        if (!diffs.length) throw new Error("No category changes are required");
        const oldPath = stringValue(category.pathstring) || stringValue(category.name);
        const currentParentPath = oldPath.split("/").slice(0, -1).join("/");
        const newParentPath =
          changes.parent_id === undefined
            ? currentParentPath
            : newParent
              ? stringValue(newParent.pathstring)
              : "";
        const newPath = [newParentPath, changes.name ?? stringValue(category.name)].filter(Boolean).join("/");
        const summary = [
          `Update category ${formatRef(refOrFallback(category, "Category", category_id))}:`,
          ...(oldPath !== newPath ? [`- Path: ${displayPath(oldPath)} -> ${displayPath(newPath)}`] : []),
          ...diffs,
          `- Impact: ${numberValue(category.subcategories)} descendant categories; ${numberValue(category.part_count)} directly assigned parts`,
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [[`/api/part/category/${category_id}/`, { path_detail: true }]];
        if (newParent) checkPaths.push([`/api/part/category/${changes.parent_id}/`, { path_detail: true }]);
        if (siblingCheck) checkPaths.push(["/api/part/category/", siblingCheck]);
        return stageMutation(oauth, auth, input, summary, [{ method: "PATCH", path: `/api/part/category/${category_id}/`, body }], await checksFor(client, checkPaths));
      }),
  );

  const locationFields = {
    ...planInputFields,
    name: z.string().min(1).max(100),
    parent_id: z.number().int().positive().nullable().optional(),
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
        const parent = input.parent_id ? await getLocation(client, input.parent_id) : undefined;
        const siblingsQuery = {
          ...(input.parent_id ? { parent: input.parent_id } : { top_level: true }),
          name: input.name,
          limit: 20,
          offset: 0,
        };
        const siblings = await client.get("/api/stock/location/", siblingsQuery);
        if (pageResults(siblings).some((item) => stringValue(item.name).localeCompare(input.name, undefined, { sensitivity: "base" }) === 0)) {
          throw new Error(`A location named ${input.name} already exists under the selected parent`);
        }
        const path = [parent ? stringValue(parent.pathstring) : "", input.name].filter(Boolean).join("/");
        const summary = [
          `Create stock location ${displayPath(path)}`,
          `- Structural: ${input.structural ? "yes" : "no"}`,
          ...(input.description ? [`- Description: ${input.description}`] : []),
          ...(input.tags.length ? [`- Tags: ${input.tags.join(", ")}`] : []),
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [["/api/stock/location/", siblingsQuery]];
        if (parent) checkPaths.push([`/api/stock/location/${input.parent_id}/`, { path_detail: true }]);
        return stageMutation(oauth, auth, input, summary, [{ method: "POST", path: "/api/stock/location/", body: { name: input.name, parent: input.parent_id ?? null, description: input.description, structural: input.structural, tags: input.tags } }], await checksFor(client, checkPaths), [{ name: "stock_location", entityType: "stock_location", requestIndex: 0, responsePaths: [["pk"]], display: displayPath(path) }]);
      }),
  );

  server.registerTool(
    "update_stock_location",
    {
      title: "Prepare changes to a stock location",
      description: "Prepare renaming, reparenting, or changing a physical stock location, with descendant and item impact shown.",
      inputSchema: {
        ...planInputFields,
        location_id: z.number().int().positive(),
        changes: z.object({
          name: z.string().min(1).max(100).optional(),
          parent_id: z.number().int().positive().nullable().optional(),
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
        const { location_id, changes } = input;
        const { auth, client } = clientFor(oauth, extra.authInfo, "inventree.write");
        const location = await getLocation(client, location_id);
        if (changes.parent_id === location_id) throw new Error("A location cannot be its own parent");
        const newParent = changes.parent_id ? await getLocation(client, changes.parent_id) : undefined;
        if (
          newParent &&
          stringValue(newParent.pathstring).startsWith(`${stringValue(location.pathstring)}/`)
        ) {
          throw new Error("A location cannot be moved below one of its own descendants");
        }
        if (changes.structural === true && numberValue(location.items) > 0) {
          throw new Error("A location containing stock cannot be made structural");
        }
        let siblingCheck: Record<string, unknown> | undefined;
        if (changes.name !== undefined || changes.parent_id !== undefined) {
          const targetParent = changes.parent_id !== undefined ? changes.parent_id : location.parent;
          const siblingQuery = {
            ...(targetParent ? { parent: numberValue(targetParent) } : { top_level: true }),
            name: changes.name ?? stringValue(location.name),
            limit: 20,
            offset: 0,
          };
          siblingCheck = siblingQuery;
          const siblings = pageResults(await client.get("/api/stock/location/", siblingQuery));
          if (
            siblings.some(
              (item) =>
                numberValue(item.pk) !== location_id &&
                stringValue(item.name).localeCompare(changes.name ?? stringValue(location.name), undefined, {
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
          body[upstream] = value;
          return beforeAfter(label, location[upstream], value) ?? [];
        });
        if (!diffs.length) throw new Error("No location changes are required");
        const oldPath = stringValue(location.pathstring) || stringValue(location.name);
        const currentParentPath = oldPath.split("/").slice(0, -1).join("/");
        const newParentPath =
          changes.parent_id === undefined
            ? currentParentPath
            : newParent
              ? stringValue(newParent.pathstring)
              : "";
        const newPath = [newParentPath, changes.name ?? stringValue(location.name)].filter(Boolean).join("/");
        const summary = [
          `Update location ${formatRef(refOrFallback(location, "Location", location_id))}:`,
          ...(oldPath !== newPath ? [`- Path: ${displayPath(oldPath)} -> ${displayPath(newPath)}`] : []),
          ...diffs,
          `- Impact: ${numberValue(location.sublocations)} descendant locations; ${numberValue(location.items)} stock items`,
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [[`/api/stock/location/${location_id}/`, { path_detail: true }]];
        if (newParent) checkPaths.push([`/api/stock/location/${changes.parent_id}/`, { path_detail: true }]);
        if (siblingCheck) checkPaths.push(["/api/stock/location/", siblingCheck]);
        return stageMutation(oauth, auth, input, summary, [{ method: "PATCH", path: `/api/stock/location/${location_id}/`, body }], await checksFor(client, checkPaths));
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
        const reviewed = input.plan_id ? reviewPlan(oauth, auth, input.plan_id).plan : undefined;
        const resolved = await Promise.all(input.entities.map(async (selector) => {
          if ("ref" in selector) {
            if (!reviewed) throw new Error("plan_id is required when an entity selector uses ref");
            const output = reviewed.steps.flatMap((step) => step.outputs).find((candidate) => candidate.ref === selector.ref);
            if (!output) throw new Error(`Unknown plan reference: ${selector.ref}`);
            if (output.entityType !== expectedType) {
              throw new Error(`Plan reference ${selector.ref} is ${output.entityType}, not ${expectedType}`);
            }
            return { item: { __planRef: selector.ref }, label: output.display, suffix: `ref ${selector.ref}` };
          }
          const query = input.entity_type === "stock_item"
            ? { part_detail: true, location_detail: true, path_detail: true }
            : { path_detail: true };
          const value = record(await client.get(entityPaths[input.entity_type](selector.id), query));
          let label = optionalString(value.pathstring)
            ? displayPath(stringValue(value.pathstring))
            : optionalString(value.name) ?? optionalString(value.full_name);
          if (input.entity_type === "stock_item") {
            label = `${formatRef(stockPartRef(value))} in ${formatRef(stockLocationRef(value))}`;
          }
          return { item: selector.id, label: label ?? `${input.entity_type} #${selector.id}`, suffix: `#${selector.id}` };
        }));
        const summary = [
          `Print ${input.copies} cop${input.copies === 1 ? "y" : "ies"} of ${resolved.length} ${input.entity_type.replaceAll("_", " ")} label${resolved.length === 1 ? "" : "s"}:`,
          ...resolved.map(({ label, suffix }) => `- ${label} (${suffix})`),
          `- Template: ${stringValue(template.name)} (#${numberValue(template.pk)}, ${template.width}x${template.height}mm)`,
          `- Printer plugin: ${input.printer}`,
        ].join("\n");
        const checkPaths: Array<[string, Record<string, unknown>?]> = [
          ["/api/label/template/", query],
          ...input.entities.flatMap((selector) => "id" in selector
            ? [[entityPaths[input.entity_type](selector.id), input.entity_type === "stock_item" ? { part_detail: true, location_detail: true, path_detail: true } : { path_detail: true }] as [string, Record<string, unknown>]]
            : []),
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
