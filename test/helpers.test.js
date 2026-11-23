import test from "node:test";
import assert from "node:assert/strict";
import { escapeRegex, isOid, pageParams, str } from "../src/utils/helpers.js";

test("escapeRegex escapes user search input", () => {
  assert.equal(escapeRegex("pizza.*"), "pizza\\.\\*");
});

test("isOid accepts only MongoDB ObjectId strings", () => {
  assert.equal(isOid("507f1f77bcf86cd799439011"), true);
  assert.equal(isOid("not-an-id"), false);
});

test("pageParams clamps page and limit", () => {
  assert.deepEqual(pageParams({ page: "-2", limit: "100" }, 10, 50), {
    page: 1,
    limit: 50,
    skip: 0,
  });
});

test("str trims strings and rejects non-strings", () => {
  assert.equal(str("  pizza  "), "pizza");
  assert.equal(str(42), "");
});
