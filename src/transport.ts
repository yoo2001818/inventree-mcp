import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

/**
 * The MCP TypeScript SDK currently preserves app auth metadata under `_meta`,
 * while ChatGPT's Apps SDK also consumes a top-level `securitySchemes` field.
 * Mirror it on tools/list responses until the SDK exposes the field directly.
 */
export class ChatGptStreamableTransport extends StreamableHTTPServerTransport {
  override async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
    if ("result" in message && message.result && typeof message.result === "object") {
      const result = message.result as { tools?: Array<Record<string, unknown>> };
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          const meta = tool._meta as { securitySchemes?: unknown } | undefined;
          if (meta?.securitySchemes) tool.securitySchemes = meta.securitySchemes;
        }
      }
    }
    await super.send(message, options);
  }
}
