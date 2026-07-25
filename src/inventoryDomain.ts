export type JsonRecord = Record<string, unknown>;

export interface Page<T> {
  count: number;
  offset: number;
  results: T[];
  nextCursor?: string;
}

export interface EntityRef {
  id: number;
  name: string;
  path?: string;
}

export interface StockPlacement {
  stockItemId: number;
  location: EntityRef | null;
  quantity: number;
  units?: string;
  batch?: string;
  serial?: string;
  packaging?: string;
  status?: string;
  expiryDate?: string;
  allocated?: number;
  expired?: boolean;
}

export interface PartSummary {
  id: number;
  name: string;
  description?: string;
  ipn?: string;
  category?: EntityRef;
  totalQuantity: number;
  units?: string;
  minimumStock?: number;
  defaultLocation?: EntityRef;
  active?: boolean;
  locked?: boolean;
  trackable?: boolean;
  hasImage?: true;
  placements?: StockPlacement[];
}

export function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function optionalString(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text || undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function pageResults(data: unknown): JsonRecord[] {
  return records(record(data).results);
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(decoded)) throw new Error("Invalid cursor");
  return Number.parseInt(decoded, 10);
}

export function page<T>(data: unknown, items: T[], offset: number): Page<T> {
  const source = record(data);
  const count = numberValue(source.count, items.length);
  const consumed = offset + items.length;
  return {
    count,
    offset,
    results: items,
    ...(consumed < count ? { nextCursor: encodeCursor(consumed) } : {}),
  };
}

export function displayPath(path: string): string {
  return path.split("/").filter(Boolean).join(" > ");
}

export function entityRef(value: unknown): EntityRef | undefined {
  const item = record(value);
  const id = numberValue(item.pk);
  const name = optionalString(item.name);
  if (!id || !name) return undefined;
  const rawPath = optionalString(item.pathstring);
  return { id, name, ...(rawPath ? { path: displayPath(rawPath) } : {}) };
}

export function formatRef(ref: EntityRef | undefined | null): string {
  if (!ref) return "Unassigned";
  return `${ref.path || ref.name} (#${ref.id})`;
}

export function formatQuantity(quantity: number, units?: string): string {
  const value = Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toLocaleString("en-US", { maximumFractionDigits: 5, useGrouping: false });
  return units ? `${value} ${units}` : value;
}

export function categoryRef(part: JsonRecord): EntityRef | undefined {
  const detail = entityRef(part.category_detail);
  if (detail) return detail;
  const id = numberValue(part.category);
  const name = optionalString(part.category_name);
  return id && name ? { id, name } : undefined;
}

export function locationRef(stockOrPart: JsonRecord): EntityRef | undefined {
  const detail = entityRef(stockOrPart.location_detail ?? stockOrPart.default_location_detail);
  if (detail) return detail;
  const id = numberValue(stockOrPart.location ?? stockOrPart.default_location);
  return id ? { id, name: `Location ${id}` } : undefined;
}

export function normalizeStock(stock: unknown, fallbackUnits?: string): StockPlacement {
  const item = record(stock);
  const part = record(item.part_detail);
  return {
    stockItemId: numberValue(item.pk),
    location: locationRef(item) ?? null,
    quantity: numberValue(item.quantity),
    ...(optionalString(part.units) || fallbackUnits
      ? { units: optionalString(part.units) ?? fallbackUnits }
      : {}),
    ...(optionalString(item.batch) ? { batch: optionalString(item.batch) } : {}),
    ...(optionalString(item.serial) ? { serial: optionalString(item.serial) } : {}),
    ...(optionalString(item.packaging) ? { packaging: optionalString(item.packaging) } : {}),
    ...(optionalString(item.status_text) && optionalString(item.status_text) !== "OK"
      ? { status: optionalString(item.status_text) }
      : {}),
    ...(optionalString(item.expiry_date) ? { expiryDate: optionalString(item.expiry_date) } : {}),
    ...(numberValue(item.allocated) > 0 ? { allocated: numberValue(item.allocated) } : {}),
    ...(item.expired === true ? { expired: true } : {}),
  };
}

export function normalizePart(partValue: unknown, stockValues: unknown[] = []): PartSummary {
  const part = record(partValue);
  const units = optionalString(part.units);
  const placements = stockValues.map((stock) => normalizeStock(stock, units));
  const upstreamTotal = part.total_in_stock ?? part.in_stock;
  const totalQuantity =
    upstreamTotal === undefined
      ? placements.reduce((total, placement) => total + placement.quantity, 0)
      : numberValue(upstreamTotal);
  return {
    id: numberValue(part.pk),
    name: optionalString(part.name) ?? `Part ${numberValue(part.pk)}`,
    ...(optionalString(part.description) ? { description: optionalString(part.description) } : {}),
    ...(optionalString(part.IPN) ? { ipn: optionalString(part.IPN) } : {}),
    ...(categoryRef(part) ? { category: categoryRef(part) } : {}),
    totalQuantity,
    ...(units ? { units } : {}),
    ...(numberValue(part.minimum_stock) > 0 ? { minimumStock: numberValue(part.minimum_stock) } : {}),
    ...(entityRef(part.default_location_detail)
      ? { defaultLocation: entityRef(part.default_location_detail) }
      : {}),
    ...(part.active === false ? { active: false } : {}),
    ...(part.locked === true ? { locked: true } : {}),
    ...(part.trackable === true ? { trackable: true } : {}),
    ...(optionalString(part.image) || optionalString(part.thumbnail) ? { hasImage: true as const } : {}),
    ...(placements.length ? { placements } : {}),
  };
}

function differentiators(placement: StockPlacement): string {
  const details = [
    placement.batch ? `batch ${placement.batch}` : "",
    placement.serial ? `serial ${placement.serial}` : "",
    placement.packaging ? placement.packaging : "",
    placement.status && placement.status !== "OK" ? placement.status : "",
    placement.expiryDate ? `expires ${placement.expiryDate}` : "",
  ].filter(Boolean);
  return details.length ? `; ${details.join("; ")}` : "";
}

export function formatPartSearch(resultPage: Page<PartSummary>): string {
  if (resultPage.results.length === 0) return "No matching parts found.";
  const first = resultPage.offset + 1;
  const last = resultPage.offset + resultPage.results.length;
  const lines = [`Results ${first}-${last} of ${resultPage.count} part${resultPage.count === 1 ? "" : "s"}:`, ""];
  resultPage.results.forEach((part, index) => {
    lines.push(
      `${index + 1}. ${part.name} (#${part.id}) — ${
        part.totalQuantity > 0 ? `${formatQuantity(part.totalQuantity, part.units)} total` : "out of stock"
      }`,
    );
    if (part.category) lines.push(`   Category: ${formatRef(part.category)}`);
    if (part.placements?.length) {
      lines.push(
        `   Stock: ${part.placements
          .map(
            (placement) =>
              `${formatRef(placement.location)}: ${formatQuantity(placement.quantity, placement.units)} ` +
              `[stock #${placement.stockItemId}${differentiators(placement)}]`,
          )
          .join("; ")}`,
      );
    }
    if (part.ipn) lines.push(`   IPN: ${part.ipn}`);
    if (part.description) lines.push(`   Description: ${part.description}`);
  });
  if (resultPage.nextCursor) lines.push(`Next cursor: ${resultPage.nextCursor}`);
  return lines.join("\n");
}

export function formatPartInventory(part: PartSummary, notes?: string, parameters?: unknown[]): string {
  const lines = [
    `## ${part.name} (#${part.id})`,
    "",
    ...(part.category ? [`- Category: ${formatRef(part.category)}`] : []),
    ...(part.description ? [`- Description: ${part.description}`] : []),
    ...(part.ipn ? [`- IPN: ${part.ipn}`] : []),
    `- Stock: ${formatQuantity(part.totalQuantity, part.units)} across ${part.placements?.length ?? 0} stock item${
      part.placements?.length === 1 ? "" : "s"
    }`,
    ...(part.minimumStock !== undefined
      ? [`- Minimum: ${formatQuantity(part.minimumStock, part.units)}`]
      : []),
    ...(part.defaultLocation ? [`- Default location: ${formatRef(part.defaultLocation)}`] : []),
    ...(part.active === false ? ["- Status: inactive"] : []),
    ...(part.locked ? ["- Editing: locked"] : []),
    ...(part.trackable ? ["- Tracking: serialized"] : []),
    ...(part.hasImage ? ["- Image: available via get_part_image"] : []),
    "",
    "Stock:",
  ];
  if (!part.placements?.length) {
    lines.push("- No stock items.");
  } else {
    for (const placement of part.placements) {
      lines.push(
        `- ${formatRef(placement.location)}: ${formatQuantity(placement.quantity, placement.units)} ` +
          `[stock #${placement.stockItemId}${differentiators(placement)}]`,
      );
    }
  }
  if (parameters?.length) {
    lines.push("", "Parameters:");
    for (const value of parameters) {
      const parameter = record(value);
      const template = record(parameter.template_detail);
      const name = optionalString(template.name) ?? `Parameter ${numberValue(parameter.template)}`;
      lines.push(`- ${name}: ${stringValue(parameter.data) || stringValue(parameter.value) || "—"}`);
    }
  }
  if (notes) lines.push("", "Notes:", notes);
  return lines.join("\n");
}

export function formatTree(
  values: unknown[],
  options: {
    kind: "category" | "location";
    search?: string;
    includeCounts?: boolean;
    includeDescriptions?: boolean;
  },
): string {
  if (values.length === 0) return `No matching ${options.kind === "category" ? "categories" : "locations"} found.`;
  const sorted = values.map(record).sort((left, right) =>
    stringValue(left.pathstring).localeCompare(stringValue(right.pathstring), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  const baseDepth = Math.min(
    ...sorted.map((node) =>
      (stringValue(node.pathstring) || stringValue(node.name)).split("/").filter(Boolean).length,
    ),
  );
  return sorted
    .map((node) => {
      const path = stringValue(node.pathstring) || stringValue(node.name);
      const segments = path.split("/").filter(Boolean);
      const indent = options.search ? "" : "  ".repeat(Math.max(0, segments.length - baseDepth));
      const name = options.search ? displayPath(path) : optionalString(node.name) ?? path;
      const markers: string[] = [];
      if (node.structural === true) markers.push("structural");
      const countField = options.kind === "category" ? "part_count" : "items";
      if (options.includeCounts && node[countField] !== undefined && node[countField] !== null) {
        const count = numberValue(node[countField]);
        markers.push(`${count} ${options.kind === "category" ? `part${count === 1 ? "" : "s"}` : `stock item${count === 1 ? "" : "s"}`}`);
      }
      const description = options.includeDescriptions ? optionalString(node.description) : undefined;
      const suffix = [markers.length ? `[${markers.join("; ")}]` : "", description ? `— ${description}` : ""]
        .filter(Boolean)
        .join(" ");
      return `${indent}- ${name} (#${numberValue(node.pk)})${suffix ? ` ${suffix}` : ""}`;
    })
    .join("\n");
}

export function formatLocationInventory(
  location: EntityRef,
  placements: StockPlacement[],
  parts: Map<number, EntityRef>,
  page?: { count: number; offset: number },
): string {
  const lines = [`## ${formatRef(location)}`, ""];
  if (placements.length === 0) lines.push("- No stock items.");
  for (const placement of placements) {
    const part = parts.get(placement.stockItemId);
    lines.push(
      `- ${part ? `${part.name} (#${part.id})` : `Stock item #${placement.stockItemId}`}: ` +
        `${formatQuantity(placement.quantity, placement.units)} at ${formatRef(placement.location)} ` +
        `[stock #${placement.stockItemId}]`,
    );
  }
  const uniqueParts = new Set([...parts.values()].map((part) => part.id)).size;
  const range = page && placements.length
    ? `Showing stock items ${page.offset + 1}-${page.offset + placements.length} of ${page.count}`
    : `${placements.length} stock item${placements.length === 1 ? "" : "s"}`;
  lines.push("", `${range} (${uniqueParts} part${uniqueParts === 1 ? "" : "s"} on this page).`);
  return lines.join("\n");
}
