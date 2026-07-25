import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logMcpToolCalls } from "../src/mcpRequestLogger.js";

describe("MCP semantic request logging", () => {
  it("logs complete tool names and arguments while redacting secrets", () => {
    const messages: string[] = [];
    logMcpToolCalls(
      {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "count_stock",
          arguments: {
            counts: [{ stock_item_id: 265, observed_quantity: 2 }],
            notes: "Physical count",
            access_token: "must-not-leak",
            callback: "https://example.test/upload?token=also-secret&mode=test",
          },
        },
      },
      { write: (message) => messages.push(message) },
      new Date("2026-07-25T00:00:00.000Z"),
    );

    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /^2026-07-25T00:00:00\.000Z MCP tools\/call /);
    assert.match(messages[0]!, /"name":"count_stock"/);
    assert.match(messages[0]!, /"stock_item_id":265/);
    assert.match(messages[0]!, /"notes":"Physical count"/);
    assert.doesNotMatch(messages[0]!, /must-not-leak|also-secret/);
    assert.match(messages[0]!, /"access_token":"\[redacted\]"/);
  });

  it("ignores non-tool protocol chatter and handles batches", () => {
    const messages: string[] = [];
    logMcpToolCalls(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "find_parts", arguments: { query: "capacitor" } } },
      ],
      { write: (message) => messages.push(message) },
    );

    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /"name":"find_parts"/);
  });
});
