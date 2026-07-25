import { z } from "zod";
import {
  displayPath,
  formatRef,
  numberValue,
  pageResults,
  stringValue,
} from "../inventoryDomain.js";
import type { OAuthService } from "../oauth.js";
import { clientFor, safely, WRITE_SECURITY } from "../mcpSupport.js";
import {
  MutationPrimitiveRegistry,
  beforeAfter,
  checksFor,
  ensureStockDestination,
  entityIdSchema,
  getCategory,
  getLocation,
  metadataBoolean,
  mutationAnnotations,
  mutationPath,
  mutationValue,
  normalizeEntityId,
  nullableEntityIdSchema,
  pathSegments,
  planInputFields,
  plannedLabel,
  plannedOutput,
  refOrFallback,
  stageMutation,
  type EntityId,
} from "./shared.js";

export function registerStructurePrimitives(primitives: MutationPrimitiveRegistry, oauth: OAuthService): void {
  const categoryFields = {
    ...planInputFields,
    name: z.string().min(1).max(100),
    parent_id: nullableEntityIdSchema().optional(),
    description: z.string().max(250).default(""),
    structural: z.boolean().default(false),
    default_location_id: nullableEntityIdSchema().optional(),
    default_keywords: z.string().max(250).nullable().optional(),
  };
  primitives.register(
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

  primitives.register(
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
  primitives.register(
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

  primitives.register(
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

