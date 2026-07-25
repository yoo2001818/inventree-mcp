import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeCursor,
  encodeCursor,
  formatLocationInventory,
  formatPartSearch,
  formatTree,
  normalizePart,
  normalizePartSearchQuery,
  page,
  partImagePath,
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
    assert.match(text, /^Results 1-1 of 1 part:/);
    assert.match(text, /Electronics > Resistors \(#15\)/);
    assert.match(text, /Living room > Drawer A3 \(#81\): 200 pcs \[stock #991\]/);
    assert.doesNotMatch(text, /pricing|purchase|assembly/);
  });

  it("normalizes conversational resistance values for InvenTree search", () => {
    for (const query of ["10 kOhm resistor", "10 kΩ resistor", "10kohm resistor", "10 kiloohm resistor"]) {
      assert.equal(normalizePartSearchQuery(query), "10kΩ resistor");
    }
    assert.equal(normalizePartSearchQuery("4,7 megaohms"), "4.7MΩ");
    assert.equal(normalizePartSearchQuery("10 mΩ shunt"), "10mΩ shunt");
    assert.equal(normalizePartSearchQuery("1 MOhm resistor"), "1MΩ resistor");
    assert.equal(normalizePartSearchQuery("precision resistor"), "precision resistor");
  });

  it("uses absolute item numbers on subsequent part-search pages", () => {
    const summaries = [
      { id: 1, name: "First", totalQuantity: 1 },
      { id: 2, name: "Second", totalQuantity: 1 },
    ];
    const text = formatPartSearch(page({ count: 15 }, summaries, 5));

    assert.match(text, /^Results 6-7 of 15 parts:/);
    assert.match(text, /^6\. First/m);
    assert.match(text, /^7\. Second/m);
  });

  it("does not treat InvenTree's blank thumbnail sentinel as a part image", () => {
    const withoutImage = normalizePart({
      pk: 238,
      name: "Solder",
      image: null,
      thumbnail: "/static/img/blank_image.thumbnail.png",
    });
    const withImage = normalizePart({
      pk: 124,
      name: "Pen",
      image: "/media/part_images/pen.jpg",
      thumbnail: "/media/part_images/pen.thumbnail.jpg",
    });

    assert.equal(withoutImage.hasImage, undefined);
    assert.equal(withImage.hasImage, true);
  });

  it("accepts only relative InvenTree media paths as part images", () => {
    assert.equal(partImagePath("/media/part_images/part.png"), "/media/part_images/part.png");
    for (const rejected of [
      "/static/img/blank_image.thumbnail.png",
      "/static/img/custom-part.png",
      "/media-not-really/part.png",
      "https://inventree.example/media/part_images/part.png",
      "media/part_images/part.png",
      "/media/../static/part.png",
      "/media/part_images/part.png?download=1",
      "",
      null,
    ]) {
      assert.equal(partImagePath(rejected), undefined);
    }
  });

  it("labels location pagination as a stock-item range and page-local part count", () => {
    const text = formatLocationInventory(
      { id: 81, name: "Drawer A3" },
      [
        { stockItemId: 991, location: { id: 81, name: "Drawer A3" }, quantity: 2 },
        { stockItemId: 992, location: { id: 81, name: "Drawer A3" }, quantity: 3 },
      ],
      new Map([
        [991, { id: 203, name: "10k resistor" }],
        [992, { id: 203, name: "10k resistor" }],
      ]),
      { count: 15, offset: 10 },
    );

    assert.match(text, /Showing stock items 11-12 of 15 \(1 part on this page\)\./);
  });

  it("uses opaque, validated pagination cursors", () => {
    const cursor = encodeCursor(40);
    assert.equal(decodeCursor(cursor), 40);
    assert.throws(() => decodeCursor("not-a-valid-offset"), /Invalid cursor/);
  });
});
