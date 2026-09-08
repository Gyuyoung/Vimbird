/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { candidates } = require("../src/dom/candidates.js");
const { clipToOwnRow } = candidates;

/** A fake element that knows its descendants, which is all clipping asks of it. */
function node(name, children = []) {
  const element = { name, children };
  element.contains = other => other === element || children.some(child => child.contains(other));
  return element;
}

const item = (element, top, height, left = 0, width = 264) => ({
  element,
  rect: { left, top, width, height },
});

test("a row that wraps its children is clipped to its own strip", () => {
  // The folder tree: <li Local Folders> contains the <li>s for Trash and Inbox,
  // so its own box is 84px tall while the row itself is 28px.
  const trash = node("trash");
  const inbox = node("inbox");
  const server = node("server", [trash, inbox]);

  const clipped = clipToOwnRow([
    item(server, 57, 84),
    item(trash, 85, 28),
    item(inbox, 113, 28),
  ]);

  assert.equal(clipped[0].rect.height, 28, "the server row keeps only its own strip");
  assert.equal(clipped[0].rect.top, 57, "the top never moves");
  assert.equal(clipped[1].rect.height, 28, "leaf rows are untouched");
  assert.equal(clipped[2].rect.height, 28);
});

test("the clipped strip is where the hint and the click land", () => {
  const child = node("child");
  const parent = node("parent", [child]);
  const [clippedParent] = clipToOwnRow([item(parent, 100, 200), item(child, 128, 28)]);

  const centre = clippedParent.rect.top + clippedParent.rect.height / 2;
  assert.ok(centre < 128, `centre ${centre} fell inside the child row`);
});

test("elements with no nested candidate keep their box", () => {
  const a = node("a");
  const b = node("b");
  const clipped = clipToOwnRow([item(a, 0, 40), item(b, 40, 40)]);
  assert.deepEqual(clipped.map(entry => entry.rect.height), [40, 40]);
});

test("a candidate starting at the same top does not clip its parent away", () => {
  const inner = node("inner");
  const outer = node("outer", [inner]);
  const clipped = clipToOwnRow([item(outer, 200, 30), item(inner, 200, 30)]);
  assert.equal(clipped[0].rect.height, 30);
});

test("clipping never leaves a sliver too small to hint", () => {
  // A descendant 3px below the top would leave a 3px strip; keep the box.
  const inner = node("inner");
  const outer = node("outer", [inner]);
  const clipped = clipToOwnRow([item(outer, 0, 60), item(inner, 3, 57)]);
  assert.equal(clipped[0].rect.height, 60);
});

test("a message card with buttons on its own first line is not clipped", () => {
  // The card is 84px tall and carries a star button 10px down, on the same line
  // as the sender. Clipping there would drag the card's label to its top edge.
  // The button is narrow, so it does not mark the end of a row.
  const star = node("star");
  const card = node("card", [star]);
  const clipped = clipToOwnRow([item(card, 93, 84, 0, 330), item(star, 103, 16, 240, 16)]);
  assert.equal(clipped[0].rect.height, 84);
});

test("a wide nested row still clips even when rows are short", () => {
  // Row height varies with the display density, so the rule cannot be a pixel
  // threshold: what marks the end of a row is a child spanning the full width.
  const child = node("child");
  const parent = node("parent", [child]);
  const clipped = clipToOwnRow([item(parent, 0, 54, 0, 200), item(child, 18, 36, 0, 200)]);
  assert.equal(clipped[0].rect.height, 18);
});

test("a nested candidate outside the parent's box is ignored", () => {
  const inner = node("inner");
  const outer = node("outer", [inner]);
  const clipped = clipToOwnRow([item(outer, 0, 28), item(inner, 400, 28)]);
  assert.equal(clipped[0].rect.height, 28);
});
