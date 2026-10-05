import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { root, artifacts, envFile, testEnvironment } from "./environment.mjs";
export const composeArgs = ["compose", "--env-file", envFile, "-f", resolve(root, "scripts/e2e/compose.yaml")];

function initializeEnvironment() {
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  if (existsSync(envFile)) return;
  const inventreePort = process.env.E2E_INVENTREE_PORT || "18000";
  const mcpPort = process.env.E2E_MCP_PORT || "18300";
  const env = {
    // InvenTree 1.5.6, API 530. Pin the tested image; opt into upgrades explicitly.
    INVENTREE_IMAGE: process.env.E2E_INVENTREE_IMAGE || "inventree/inventree@sha256:b61e6a7534bf82e70b72d8de53d0983ecda1343554e090baf70246944da65588",
    INVENTREE_SITE_URL: `http://localhost:${inventreePort}`, INVENTREE_ALLOWED_HOSTS: "*",
    INVENTREE_DB_ENGINE: "postgresql", INVENTREE_DB_HOST: "db", INVENTREE_DB_PORT: "5432",
    INVENTREE_DB_NAME: "inventree_e2e", INVENTREE_DB_USER: "inventree_e2e", INVENTREE_DB_PASSWORD: randomBytes(24).toString("base64url"),
    INVENTREE_CACHE_ENABLED: "True", INVENTREE_CACHE_HOST: "cache", INVENTREE_CACHE_PORT: "6379",
    INVENTREE_AUTO_UPDATE: "False", INVENTREE_PLUGINS_ENABLED: "False", INVENTREE_LOG_LEVEL: "WARNING",
    INVENTREE_ADMIN_USER: "e2e_admin", INVENTREE_ADMIN_EMAIL: "e2e@example.test", INVENTREE_ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
    PUBLIC_URL: `http://localhost:${mcpPort}`, ENCRYPTION_KEY: randomBytes(32).toString("base64"), OWNER_PASSWORD: randomBytes(24).toString("base64url"),
    ALLOWED_REDIRECT_ORIGINS: "http://localhost:*,http://127.0.0.1:*", ALLOWED_MCP_ORIGINS: `http://localhost:${mcpPort}`,
    E2E_INVENTREE_PORT: inventreePort, E2E_MCP_PORT: mcpPort,
  };
  writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
}

export function compose(args, logName) {
  const log = logName ? openSync(resolve(artifacts, logName), "a", 0o600) : undefined;
  const result = spawnSync("docker", [...composeArgs, ...args], { cwd: root, encoding: "utf8",
    stdio: log === undefined ? "inherit" : ["ignore", log, log] });
  if (log !== undefined) closeSync(log);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker compose ${args[0]} failed (exit ${result.status})${logName ? `; see .e2e/${logName}` : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    initializeEnvironment();
    const command = process.argv[2] || "test";
    if (command === "down") {
      // Preserve test volumes for inspection. Only this fixed project is stopped.
      compose(["down"]);
    } else if (command === "run") {
      await import("./run.mjs");
    } else if (command === "test" || command === "up") {
      console.log("Pulling the isolated InvenTree test images (.e2e/pull.log)...");
      compose(["pull", "server", "db", "cache", "proxy"], "pull.log");
      console.log("Starting the test database and cache...");
      compose(["up", "-d", "--wait", "--wait-timeout", "120", "db", "cache"]);
      console.log("Initializing the test InvenTree database (.e2e/initialization.log)...");
      compose(["run", "--rm", "--no-deps", "server", "invoke", "update", "--skip-backup"], "initialization.log");
      console.log("Building the MCP image (.e2e/build.log)...");
      compose(["build", "mcp"], "build.log");
      console.log("Starting InvenTree, its worker/proxy, and MCP...");
      compose(["up", "-d", "--wait", "--wait-timeout", "240"]);
      const env = testEnvironment();
      console.log(`InvenTree: ${env.INVENTREE_SITE_URL}; MCP: ${env.PUBLIC_URL}/mcp`);
      if (command === "test") await import("./run.mjs");
    } else throw new Error("Usage: node scripts/e2e/stack.mjs [test|up|run|down]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
