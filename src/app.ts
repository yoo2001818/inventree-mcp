import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import type { Config } from "./config.js";
import { DomainError } from "./domainErrors.js";
import { partImageUploadPage } from "./html.js";
import { InvenTreeClient } from "./inventree.js";
import { createMcpServer } from "./mcp.js";
import { logMcpToolCalls } from "./mcpRequestLogger.js";
import { inspectImage, PartImageUploads } from "./partImages.js";
import { OAuthService } from "./oauth.js";
import { createRequestLogger } from "./requestLogger.js";
import { JsonStore } from "./store.js";
import { ChatGptStreamableTransport } from "./transport.js";

export interface AppServices {
  config: Config;
  store: JsonStore;
  oauth: OAuthService;
  imageUploads: PartImageUploads;
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
  const imageUploads = new PartImageUploads(config.imageUploadMaxBytes, config.imageMaxPixels);
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
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Accept",
        "Authorization",
        "Content-Type",
        "Last-Event-ID",
        "MCP-Protocol-Version",
        "MCP-Session-Id",
        "X-File-Name",
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
      part_image_upload: "Use the prepare_part_image_upload MCP tool to create an expiring upload URL.",
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
        `Bearer resource_metadata="${resourceMetadataUrl}", scope="inventree.read inventree.write"`,
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

  app.get("/part-images/upload", (req, res) => {
    res.set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.set("Cache-Control", "no-store");
    const token = typeof req.query.token === "string" ? req.query.token : "";
    try {
      const session = imageUploads.uploadSession(token);
      res.type("html").send(partImageUploadPage({ status: session.status, expiresAt: session.expiresAt }));
    } catch (error) {
      res.status(404).type("html").send(partImageUploadPage({ status: "invalid", message: (error as Error).message }));
    }
  });

  app.put(
    "/part-images/upload",
    express.raw({ type: ["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"], limit: config.imageUploadMaxBytes }),
    (req, res) => {
      try {
        const token = typeof req.query.token === "string" ? req.query.token : "";
        const upload = imageUploads.complete(
          token,
          Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          req.header("content-type")?.split(";")[0]?.trim().toLowerCase(),
          req.header("x-file-name") ?? undefined,
        );
        const session = imageUploads.uploadSession(token);
        res.status(201).json({
          data: {
            status: "ready",
            upload_ref: upload.ref,
            filename: upload.filename,
            mime_type: upload.mimeType,
            byte_size: upload.byteSize,
            width: upload.width,
            height: upload.height,
            expires_at: new Date(session.expiresAt).toISOString(),
          },
        });
      } catch (error) {
        const domain = error as { data?: Record<string, unknown>; message?: string };
        const domainStatus = domain.data?.status;
        const status = domainStatus === "not_found" ? 404 : domainStatus === "conflict" ? 409 : 400;
        res.status(status).json({ data: domain.data ?? { status: "invalid_image" }, message: domain.message ?? "Invalid image upload" });
      }
    },
  );

  app.get("/part-images/download", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const session = imageUploads.download(token);
      const client = new InvenTreeClient(oauth.getCredentialsById(session.credentialsId));
      const downloaded = await client.downloadMedia(session.mediaPath, imageUploads.maxBytes);
      const metadata = inspectImage(downloaded.bytes);
      if (downloaded.contentType && downloaded.contentType !== metadata.mimeType) {
        throw new Error(`InvenTree returned ${downloaded.contentType}, but the downloaded file is ${metadata.mimeType}`);
      }
      const filename = session.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140) || `part-image.${metadata.extension}`;
      res
        .set("Content-Type", metadata.mimeType)
        .set("Content-Length", String(downloaded.bytes.length))
        .set("Content-Disposition", `inline; filename="${filename}"`)
        .send(downloaded.bytes);
    } catch (error) {
      const status = error instanceof DomainError ? 404 : 502;
      res.status(status).json({
        data: error instanceof DomainError ? error.data : { status: "image_download_failed" },
        message: (error as Error).message,
      });
    }
  });

  app.post("/mcp", authenticate, async (req, res) => {
    logMcpToolCalls(req.body, options.requestLogStream);
    const server = createMcpServer(oauth, imageUploads);
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
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    const bodyError = error as { type?: string };
    if (req.path === "/part-images/upload" && bodyError.type === "entity.too.large") {
      res.status(413).json({ data: { status: "image_too_large", max_bytes: config.imageUploadMaxBytes } });
      return;
    }
    next(error);
  });

  return { app, services: { config, store, oauth, imageUploads } satisfies AppServices };
}
