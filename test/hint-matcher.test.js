/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { matcher } = require("../src/core/hint-matcher.js");
const { resolve, isHintKey } = matcher;

const LABELS = ["aa", "as", "ad", "sa", "ss"];

test("empty input keeps every hint alive", () => {
  const result = resolve(LABELS, "");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.matches, [0, 1, 2, 3, 4]);
});

test("a shared prefix narrows without selecting", () => {
  const result = resolve(LABELS, "a");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.matches.map(i => LABELS[i]), ["aa", "as", "ad"]);
  assert.equal(result.index, -1);
});

test("a complete label selects exactly one element", () => {
  const result = resolve(LABELS, "as");
  assert.equal(result.status, "exact");
  assert.equal(LABELS[result.index], "as");
  assert.deepEqual(result.matches, [1]);
});

test("input that matches nothing is reported, not silently ignored", () => {
  const result = resolve(LABELS, "x");
  assert.equal(result.status, "none");
  assert.deepEqual(result.matches, []);
});

test("multi-character input is resolved step by step", () => {
  let input = "";
  input += "s";
  assert.equal(resolve(LABELS, input).status, "partial");
  input += "s";
  const final = resolve(LABELS, input);
  assert.equal(final.status, "exact");
  assert.equal(LABELS[final.index], "ss");
});

test("backspace-style shortening restores the wider match", () => {
  assert.equal(resolve(LABELS, "ss").status, "exact");
  assert.equal(resolve(LABELS, "s").status, "partial");
  assert.equal(resolve(LABELS, "").matches.length, LABELS.length);
});

test("hint keys exclude modifiers and characters outside the alphabet", () => {
  assert.ok(isHintKey({ key: "a" }, "asdf"));
  assert.ok(isHintKey({ key: "A" }, "asdf"), "shifted letters still match their key");
  assert.ok(!isHintKey({ key: "z" }, "asdf"));
  assert.ok(!isHintKey({ key: "a", ctrlKey: true }, "asdf"));
  assert.ok(!isHintKey({ key: "a", altKey: true }, "asdf"));
  assert.ok(!isHintKey({ key: "a", metaKey: true }, "asdf"));
  assert.ok(!isHintKey({ key: "Enter" }, "asdf"));
});
