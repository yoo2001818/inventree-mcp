import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeCursor,
  encodeCursor,
  formatPartSearch,
  formatTree,
  normalizePart,
  page,
} from "../src/inventoryDomain.js";

describe("AI-facing inventory formatting", () => {
  it("renders category hierarchy with stable IDs and structural markers", () => {
    const text = formatTree(
      [
        { pk: 14, name: "Capacitors", pathstring: "Electronics/Capacitors", structural: false },
        { pk: 13, name: "Electronics", pathstring: "Electronics", structural: true },
      ],
      { kind: "category" },
    );

    assert.equal(text, "- Electronics (#13) [structural]\n  - Capacitors (#14)");
  });

  it("renders a compact part result with quantity, category path, location, and stock IDs", () => {
    const summary = normalizePart(
      {
        pk: 203,
        name: "10 kOhm resistor, 1%, 0603",
        IPN: "R-10K-0603-1P",
        units: "pcs",
        total_in_stock: 200,
        category_detail: { pk: 15, name: "Resistors", pathstring: "Electronics/Resistors" },
      },
      [
        {
          pk: 991,
          quantity: 200,
          status_text: "OK",
          location_detail: { pk: 81, name: "Drawer A3", pathstring: "Living room/Drawer A3" },
        },
      ],
    );
    const text = formatPartSearch(page({ count: 1 }, [summary], 0));

    assert.match(text, /10 kOhm resistor, 1%, 0603 \(#203\) — 200 pcs total/);
    assert.match(text, /Electronics > Resistors \(#15\)/);
    assert.match(text, /Living room > Drawer A3 \(#81\): 200 pcs \[stock #991\]/);
    assert.doesNotMatch(text, /pricing|purchase|assembly/);
  });

  it("uses opaque, validated pagination cursors", () => {
    const cursor = encodeCursor(40);
    assert.equal(decodeCursor(cursor), 40);
    assert.throws(() => decodeCursor("not-a-valid-offset"), /Invalid cursor/);
  });
});
