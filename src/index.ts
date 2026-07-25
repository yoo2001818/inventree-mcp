import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./httpServer.js";

const config = loadConfig();
const { app } = createApp(config);

const server = startHttpServer(app, config);

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
