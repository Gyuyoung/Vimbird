"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ranking } = require("../src/core/ranking.js");
const { sortByScreenPosition } = ranking;

const named = (name, screenX, screenY) => ({ name, screenX, screenY });

test("orders top to bottom", () => {
  const sorted = sortByScreenPosition([
    named("bottom", 10, 500),
    named("top", 10, 10),
    named("middle", 10, 200),
  ]);
  assert.deepEqual(sorted.map(item => item.name), ["top", "middle", "bottom"]);
});

test("orders left to right inside one visual row", () => {
  const sorted = sortByScreenPosition([
    named("right", 300, 42),
    named("left", 20, 40),
    named("center", 150, 45),
  ]);
  assert.deepEqual(sorted.map(item => item.name), ["left", "center", "right"]);
});

test("candidates from different documents interleave by screen position", () => {
  const sorted = sortByScreenPosition([
    named("folderRow", 60, 300),
    named("toolbarButton", 400, 20),
    named("headerButton", 900, 160),
  ]);
  assert.deepEqual(sorted.map(item => item.name), ["toolbarButton", "headerButton", "folderRow"]);
});

test("does not mutate the input array", () => {
  const input = [named("b", 0, 100), named("a", 0, 0)];
  const copy = [...input];
  sortByScreenPosition(input);
  assert.deepEqual(input, copy);
});

test("rows further apart than the band do not merge", () => {
  const sorted = sortByScreenPosition([named("lowerLeft", 5, 60), named("upperRight", 900, 10)]);
  assert.deepEqual(sorted.map(item => item.name), ["upperRight", "lowerLeft"]);
});
