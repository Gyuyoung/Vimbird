/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { labels } = require("../src/core/hint-labels.js");
const { generateLabels, DEFAULT_CHARS } = labels;

test("generates exactly as many labels as requested", () => {
  for (const count of [0, 1, 2, 8, 9, 10, 81, 82, 500]) {
    assert.equal(generateLabels(count).length, count, `count=${count}`);
  }
});

test("labels are unique", () => {
  for (const count of [1, 9, 10, 90, 300]) {
    const result = generateLabels(count);
    assert.equal(new Set(result).size, count, `count=${count}`);
  }
});

test("labels are prefix-free, so an exact match is never ambiguous", () => {
  for (const count of [2, 9, 10, 11, 90, 200]) {
    const result = generateLabels(count);
    for (const a of result) {
      for (const b of result) {
        if (a !== b) {
          assert.ok(!b.startsWith(a), `"${a}" is a prefix of "${b}" (count=${count})`);
        }
      }
    }
  }
});

test("label lengths differ by at most one", () => {
  for (const count of [5, 10, 40, 95, 400]) {
    const lengths = generateLabels(count).map(label => label.length);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1, `count=${count}`);
  }
});

test("two keystrokes cover a whole window's worth of hints", () => {
  // A maximised 3-pane window with a dozen folders and a full message list
  // measures around 80-100 hints, so three-character labels must stay well out
  // of reach. The alphabet allows n^2 two-character labels.
  const capacity = DEFAULT_CHARS.length ** 2;
  assert.ok(capacity >= 300, `alphabet covers only ${capacity} elements in two keystrokes`);
  for (const count of [100, 200, capacity]) {
    const longest = Math.max(...generateLabels(count).map(label => label.length));
    assert.equal(longest, 2, `count=${count}`);
  }
  assert.ok(generateLabels(capacity + 1).some(label => label.length === 3));
});

test("the shortest labels come first, so top elements cost fewest keystrokes", () => {
  for (const count of [10, 20, 100, 400]) {
    const lengths = generateLabels(count).map(label => label.length);
    const sorted = [...lengths].sort((a, b) => a - b);
    assert.deepEqual(lengths, sorted, `count=${count}`);
  }
});

test("labels follow the alphabet's order of preference, not the ASCII order", () => {
  // "q" sits after the home row in the alphabet, so it must not be handed out
  // before "s" just because it sorts earlier as text.
  const result = generateLabels(30);
  assert.equal(result[0], "s");
  assert.ok(result.indexOf("l") < result.indexOf("q"));
  assert.deepEqual(generateLabels(2, "zy"), ["z", "y"]);
});

test("uses single characters while the alphabet lasts", () => {
  const alphabetSize = DEFAULT_CHARS.length;
  assert.ok(generateLabels(alphabetSize).every(label => label.length === 1));
  assert.ok(generateLabels(alphabetSize + 1).some(label => label.length === 2));
});

test("honours a custom alphabet", () => {
  const result = generateLabels(4, "xy");
  assert.deepEqual(result, ["xx", "xy", "yx", "yy"]);
  assert.ok(result.every(label => [...label].every(char => "xy".includes(char))));
});

test("rejects an unusable alphabet", () => {
  assert.throws(() => generateLabels(3, "a"), /at least two characters/);
});
