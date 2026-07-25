import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatRef, partImagePath } from "../inventoryDomain.js";
import type { OAuthService } from "../oauth.js";
import type { PartImageUploads } from "../partImages.js";
import { clientFor, result, safely, WRITE_SECURITY } from "../mcpSupport.js";
import {
  MutationPrimitiveRegistry,
  authenticatedCredentialsId,
  checksFor,
  ensureUnlocked,
  entityIdSchema,
  getPart,
  mutationAnnotations,
  mutationPath,
  normalizeEntityId,
  partRef,
  planInputFields,
  plannedLabel,
  plannedOutput,
  stageMutation,
} from "./shared.js";

export function registerImageWriteTools(
  server: McpServer,
  primitives: MutationPrimitiveRegistry,
  oauth: OAuthService,
  imageUploads: PartImageUploads,
): void {
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
            `The URL expires at ${expiresAt}. After uploading, call get_part_image_upload_status or create a plan containing a set_part_image action with the upload reference.`,
          ].join("\n\n"),
        );
      }),
  );

  server.registerTool(
    "get_part_image_upload_status",
    {
      title: "Check a part-image upload",
      description: "Check whether an expiring part-image upload reference is pending or ready for a set_part_image action in create_inventory_plan.",
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

  primitives.register(
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
        const currentImage = part ? partImagePath(part.image) ?? partImagePath(part.thumbnail) : undefined;
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

}
