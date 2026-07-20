import { createApp } from "./app.js";
import { loadConfig, ownerPasswordFingerprint } from "./config.js";

const config = loadConfig();
const { app } = createApp(config);

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`InvenTree MCP listening on port ${config.port}`);
  console.log(`Public MCP endpoint: ${config.resourceUrl}`);
  console.log(`Owner password fingerprint: ${ownerPasswordFingerprint(config)}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
