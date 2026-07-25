import { z } from "zod";
import { DomainError } from "../domainErrors.js";
import {
  formatQuantity,
  formatRef,
  numberValue,
  pageResults,
  stringValue,
  type JsonRecord,
} from "../inventoryDomain.js";
import type { PlannedOutputInput } from "../mutationPlans.js";
import type { OAuthService } from "../oauth.js";
import { clientFor, safely, WRITE_SECURITY } from "../mcpSupport.js";
import type { MutationRequest } from "../store.js";
import {
  MutationPrimitiveRegistry,
  beforeAfter,
  checksFor,
  ensurePartCategory,
  ensureStockDestination,
  ensureUnlocked,
  entityIdSchema,
  getCategory,
  getLocation,
  getPart,
  metadataBoolean,
  mutationAnnotations,
  mutationPath,
  mutationValue,
  normalizeEntityId,
  nullableEntityIdSchema,
  optionalText,
  partRef,
  partUnitsSchema,
  planInputFields,
  plannedLabel,
  plannedOutput,
  positiveQuantity,
  refOrFallback,
  stageMutation,
  validatePartUnits,
  type EntityId,
} from "./shared.js";

export function registerPartPrimitives(primitives: MutationPrimitiveRegistry, oauth: OAuthService): void {
  primitives.register(
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
          units: partUnitsSchema,
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
        await validatePartUnits(client, input.part.units);
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

  primitives.register(
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
          units: partUnitsSchema,
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
        await validatePartUnits(client, changes.units);
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

}
