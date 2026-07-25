import type { Express } from "express";
import type { Config } from "./config.js";
import { ownerPasswordFingerprint } from "./config.js";

type HttpServerConfig = Pick<Config, "bindHost" | "port" | "resourceUrl" | "ownerPassword">;

export interface HttpServerOptions {
  logger?: Pick<Console, "log" | "error">;
  onFatalError?: (error: NodeJS.ErrnoException) => void;
}

export function startHttpServer(
  app: Express,
  config: HttpServerConfig,
  options: HttpServerOptions = {},
) {
  const logger = options.logger ?? console;
  const onFatalError = options.onFatalError ?? ((error: NodeJS.ErrnoException) => {
    throw error;
  });

  const server = app.listen(config.port, config.bindHost, (error?: Error) => {
    if (error) {
      const startupError = error as NodeJS.ErrnoException;
      if (startupError.code === "EADDRINUSE") {
        logger.error(
          `Cannot start InvenTree MCP: ${config.bindHost}:${config.port} is already in use`,
        );
      } else {
        logger.error(`Cannot start InvenTree MCP: ${startupError.message}`);
      }
      onFatalError(startupError);
      return;
    }

    logger.log(`InvenTree MCP listening on ${config.bindHost}:${config.port}`);
    logger.log(`Public MCP endpoint: ${config.resourceUrl}`);
    logger.log(`Owner password fingerprint: ${ownerPasswordFingerprint(config)}`);
  });

  return server;
}
