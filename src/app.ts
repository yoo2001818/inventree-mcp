import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { OAuthService } from "./oauth.js";
import { JsonStore } from "./store.js";

export interface AppServices {
  config: Config;
  store: JsonStore;
  oauth: OAuthService;
}

export function createApp(config: Config, store = new JsonStore(config.dataFile)) {
  const app = express();
  const oauth = new OAuthService(config, store);
  const resourceMetadataUrl = `${config.publicUrl.origin}/.well-known/oauth-protected-resource`;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "1mb" }));
  app.use(oauth.router);

  app.get("/", (_req, res) => {
    res.json({
      name: "InvenTree MCP",
      mcp_endpoint: config.resourceUrl,
      authorization_server: config.publicUrl.origin,
      status: "ok",
    });
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/i.exec(authorization);
    if (!match?.[1]) {
      res.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${resourceMetadataUrl}", scope="inventree.read"`,
      );
      res.status(401).json({ error: "invalid_token", error_description: "Bearer token required" });
      return;
    }
    try {
      req.auth = oauth.verifyAccessToken(match[1]);
      next();
    } catch (error) {
      res.set(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="${String((error as Error).message).replaceAll('"', "")}", resource_metadata="${resourceMetadataUrl}"`,
      );
      res.status(401).json({ error: "invalid_token", error_description: (error as Error).message });
    }
  };

  app.post("/mcp", authenticate, async (req, res) => {
    const server = createMcpServer(oauth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });
  app.get("/mcp", authenticate, (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
  app.delete("/mcp", authenticate, (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

  return { app, services: { config, store, oauth } satisfies AppServices };
}
