import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthService } from "./oauth.js";
import type { PartImageUploads } from "./partImages.js";
import { registerImageWriteTools } from "./write/imageTools.js";
import { registerLabelPrimitives } from "./write/labelPrimitives.js";
import { registerPartPrimitives } from "./write/partPrimitives.js";
import { registerInventoryPlanTools } from "./write/planTools.js";
import { MutationPrimitiveRegistry } from "./write/shared.js";
import { registerStockPrimitives } from "./write/stockPrimitives.js";
import { registerStockEditing } from "./write/stockEditing.js";
import { registerStructurePrimitives } from "./write/structurePrimitives.js";
import { registerCatalogPrimitives } from "./write/catalogPrimitives.js";
import { registerPurchaseOrderPrimitives } from "./write/purchaseOrderPrimitives.js";

export function registerWriteTools(
  server: McpServer,
  oauth: OAuthService,
  imageUploads: PartImageUploads,
): void {
  const primitives = new MutationPrimitiveRegistry();

  registerPartPrimitives(primitives, oauth);
  registerCatalogPrimitives(primitives, oauth);
  registerPurchaseOrderPrimitives(primitives, oauth);
  registerImageWriteTools(server, primitives, oauth, imageUploads);
  registerStockPrimitives(primitives, oauth);
  registerStockEditing(primitives, oauth);
  registerStructurePrimitives(primitives, oauth);
  registerLabelPrimitives(primitives, oauth);
  registerInventoryPlanTools(server, oauth, imageUploads, primitives);
}
