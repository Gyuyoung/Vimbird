"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { placement } = require("../src/core/placement.js");
const { layoutLabels } = placement;

const VIEWPORT = { width: 1000, height: 800 };
const LABEL = { width: 22, height: 16 };

const label = (left, top) => ({ left, top, ...LABEL });

function overlaps(a, b) {
  return (
    a.left < b.left + LABEL.width &&
    b.left < a.left + LABEL.width &&
    a.top < b.top + LABEL.height &&
    b.top < a.top + LABEL.height
  );
}

function assertNoOverlaps(positions) {
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      assert.ok(
        !overlaps(positions[i], positions[j]),
        `labels ${i} and ${j} overlap: ${JSON.stringify(positions[i])} ${JSON.stringify(positions[j])}`
      );
    }
  }
}

test("labels that do not collide keep their anchor position", () => {
  const positions = layoutLabels([label(10, 10), label(400, 300)], VIEWPORT);
  assert.deepEqual(positions, [{ left: 10, top: 10 }, { left: 400, top: 300 }]);
});

test("adjacent inline links get separated", () => {
  // Three links side by side, each narrower than its label.
  const positions = layoutLabels([label(100, 200), label(112, 200), label(124, 200)], VIEWPORT);
  assertNoOverlaps(positions);
  assert.deepEqual(positions[0], { left: 100, top: 200 }, "the first label stays put");
});

test("a dense cluster is fully separated", () => {
  const labels = [];
  for (let i = 0; i < 12; i++) {
    labels.push(label(300 + i * 4, 400 + (i % 3)));
  }
  assertNoOverlaps(layoutLabels(labels, VIEWPORT));
});

test("labels stay close to the element they belong to", () => {
  const labels = [label(500, 400), label(504, 400), label(508, 400)];
  const positions = layoutLabels(labels, VIEWPORT);
  positions.forEach((position, index) => {
    const distance = Math.hypot(position.left - labels[index].left, position.top - labels[index].top);
    assert.ok(distance < 90, `label ${index} moved ${Math.round(distance)}px from its element`);
  });
});

test("labels are kept inside the viewport", () => {
  const positions = layoutLabels(
    [label(-30, -20), label(VIEWPORT.width + 50, VIEWPORT.height + 50)],
    VIEWPORT
  );
  for (const position of positions) {
    assert.ok(position.left >= 0 && position.top >= 0, JSON.stringify(position));
    assert.ok(position.left + LABEL.width <= VIEWPORT.width, JSON.stringify(position));
    assert.ok(position.top + LABEL.height <= VIEWPORT.height, JSON.stringify(position));
  }
});

test("rows of the message list are left alone", () => {
  // Rows are taller than a label, so nothing should move.
  const labels = [label(0, 100), label(0, 128), label(0, 156)];
  assert.deepEqual(
    layoutLabels(labels, VIEWPORT),
    labels.map(({ left, top }) => ({ left, top }))
  );
});

test("an impossible cluster still returns one position per label", () => {
  const labels = Array.from({ length: 60 }, () => label(500, 400));
  const positions = layoutLabels(labels, VIEWPORT);
  assert.equal(positions.length, labels.length);
  for (const position of positions) {
    assert.ok(Number.isFinite(position.left) && Number.isFinite(position.top));
  }
});
