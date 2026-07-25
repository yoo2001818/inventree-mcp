import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { OAuthService } from "./oauth.js";
import { createRequestLogger } from "./requestLogger.js";
import { JsonStore } from "./store.js";
import { ChatGptStreamableTransport } from "./transport.js";

export interface AppServices {
  config: Config;
  store: JsonStore;
  oauth: OAuthService;
}

export interface AppOptions {
  requestLogStream?: { write(message: string): void };
}

export function createApp(
  config: Config,
  store = new JsonStore(config.dataFile),
  options: AppOptions = {},
) {
  const app = express();
  const oauth = new OAuthService(config, store);
  const resourceMetadataUrl = `${config.publicUrl.origin}/.well-known/oauth-protected-resource`;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(createRequestLogger(options.requestLogStream));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'unsafe-inline'"],
          formAction: ["'self'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use("/mcp", (req, res, next) => {
    const origin = req.header("origin");
    if (origin && !config.allowedMcpOrigins.includes(origin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Invalid Origin header: ${origin}` },
        id: null,
      });
      return;
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(
          null,
          origin !== undefined && config.allowedMcpOrigins.includes(origin),
        );
      },
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Accept",
        "Authorization",
        "Content-Type",
        "Last-Event-ID",
        "MCP-Protocol-Version",
        "MCP-Session-Id",
      ],
      exposedHeaders: ["Location", "MCP-Session-Id", "WWW-Authenticate"],
      maxAge: 600,
      optionsSuccessStatus: 204,
    }),
  );
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
      res.status(401).json({
        error: "invalid_token",
        error_description: "Bearer token required",
      });
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
      res.status(401).json({
        error: "invalid_token",
        error_description: (error as Error).message,
      });
    }
  };

  app.post("/mcp", authenticate, async (req, res) => {
    const server = createMcpServer(oauth);
    const transport = new ChatGptStreamableTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
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
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .set("Allow", "POST")
      .status(405)
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
  };
  app.get("/mcp", authenticate, methodNotAllowed);
  app.delete("/mcp", authenticate, methodNotAllowed);
  app.all("/mcp", authenticate, methodNotAllowed);

  return { app, services: { config, store, oauth } satisfies AppServices };
}
