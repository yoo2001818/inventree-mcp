import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const artifacts = resolve(root, ".e2e");
export const envFile = resolve(artifacts, "stack.env");

export function testEnvironment() {
  return Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((line) => line && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
