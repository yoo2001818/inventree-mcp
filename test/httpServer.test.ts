import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import express from "express";
import { startHttpServer } from "../src/httpServer.js";

describe("HTTP server startup", () => {
  it("reports a fatal error when the configured port is occupied", async () => {
    const occupiedServer = createServer();
    await new Promise<void>((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));

    try {
      const port = (occupiedServer.address() as AddressInfo).port;
      const logs: string[] = [];
      const errors: string[] = [];
      let conflictingServer: ReturnType<typeof startHttpServer> | undefined;
      const startupError = await new Promise<NodeJS.ErrnoException>((resolve) => {
        conflictingServer = startHttpServer(
          express(),
          {
            bindHost: "127.0.0.1",
            port,
            resourceUrl: `http://localhost:${port}/mcp`,
            ownerPassword: "owner-secret-long-enough",
          },
          {
            logger: {
              log: (message) => logs.push(String(message)),
              error: (message) => errors.push(String(message)),
            },
            onFatalError: resolve,
          },
        );
      });

      assert.equal(startupError.code, "EADDRINUSE");
      assert.equal(conflictingServer?.listening, false);
      assert.deepEqual(logs, []);
      assert.deepEqual(errors, [
        `Cannot start InvenTree MCP: 127.0.0.1:${port} is already in use`,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupiedServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
