/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { placement } = require("../src/core/placement.js");
const { anchor, layoutLabels } = placement;

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

test("a label rests on the middle of its element's height", () => {
  // A message list row: 28px tall, label 16px → 6px of row above and below.
  assert.deepEqual(anchor({ left: 40, top: 100, width: 600, height: 28 }, LABEL), {
    left: 40,
    top: 106,
  });
});

test("a label on a short element straddles it evenly", () => {
  // A 10px element is shorter than the label, so the label overhangs equally
  // rather than being pushed onto one edge.
  assert.deepEqual(anchor({ left: 0, top: 200, width: 30, height: 10 }, LABEL), {
    left: 0,
    top: 197,
  });
});

test("a label never leaves its element's left edge", () => {
  for (const height of [1, 16, 28, 200]) {
    const { left } = anchor({ left: 314, top: 0, width: 50, height }, LABEL);
    assert.equal(left, 314, `height=${height}`);
  }
});

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

test("a label never leaves the row it points at", () => {
  // Three labels anchored on the same spot inside one 28px message row. Without
  // the bound the loser would be pushed 18px down, onto the next row, where it
  // reads as that row's label and clicks the wrong message.
  const row = { top: 100, bottom: 128 };
  const labels = [
    { ...label(0, 106), bounds: row },
    { ...label(0, 106), bounds: row },
    { ...label(0, 106), bounds: row },
  ];
  for (const position of layoutLabels(labels, VIEWPORT)) {
    assert.ok(
      position.top >= row.top - 1 && position.top + LABEL.height <= row.bottom + 1,
      `label at ${position.top} left the row ${JSON.stringify(row)}`
    );
  }
});

test("labels on elements no taller than themselves still spread out", () => {
  // Inline links in a message header: their neighbours are alongside, not above
  // and below, so confining them would only bring the overlaps back.
  const labels = [100, 112, 124].map(left => ({
    ...label(left, 200),
    bounds: { top: 198, bottom: 216 },
  }));
  assertNoOverlaps(layoutLabels(labels, VIEWPORT));
});

test("an impossible cluster still returns one position per label", () => {
  const labels = Array.from({ length: 60 }, () => label(500, 400));
  const positions = layoutLabels(labels, VIEWPORT);
  assert.equal(positions.length, labels.length);
  for (const position of positions) {
    assert.ok(Number.isFinite(position.left) && Number.isFinite(position.top));
  }
});
