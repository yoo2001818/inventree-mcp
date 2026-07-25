import { z } from "zod";
import {
  formatQuantity,
  formatRef,
  numberValue,
  optionalString,
  pageResults,
  record,
  stringValue,
  type JsonRecord,
} from "../inventoryDomain.js";
import type { PlannedOutputInput } from "../mutationPlans.js";
import type { OAuthService } from "../oauth.js";
import { clientFor, result, safely, WRITE_SECURITY } from "../mcpSupport.js";
import type { MutationCheck, MutationOutput, MutationRequest } from "../store.js";
import {
  STATUS_CODES,
  MutationPrimitiveRegistry,
  checksFor,
  ensureStockDestination,
  ensureUnlocked,
  entityIdSchema,
  getLocation,
  getPart,
  getStock,
  metadataBoolean,
  mutationAnnotations,
  mutationValue,
  normalizeEntityId,
  optionalText,
  partRef,
  planInputFields,
  plannedLabel,
  plannedOutput,
  positiveQuantity,
  refOrFallback,
  stageMutation,
  stockLocationRef,
  stockPartRef,
} from "./shared.js";

export function registerStockPrimitives(primitives: MutationPrimitiveRegistry, oauth: OAuthService): void {
  primitives.register(
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

  primitives.register(
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

  primitives.register(
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

  primitives.register(
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

  primitives.register(
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

}
