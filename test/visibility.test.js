/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { visibility } = require("../src/dom/visibility.js");
const { visibleRect } = visibility;

const VIEWPORT = { left: 0, top: 0, width: 1000, height: 800 };

/** Build an element plus the DOM-reading environment around it. */
function scene({ rect, style = {}, attributes = {}, extra = {}, topElement = "self" }) {
  const element = {
    localName: "button",
    getAttribute: name => attributes[name] ?? null,
    contains: node => node === element,
    ...extra,
  };
  const env = {
    rect: () => rect,
    style: () => ({ visibility: "visible", display: "block", opacity: "1", ...style }),
    viewport: () => VIEWPORT,
    elementFromPoint: () => (topElement === "self" ? element : topElement),
  };
  return { element, env };
}

test("a normal on-screen element is hintable", () => {
  const { element, env } = scene({ rect: { left: 100, top: 50, width: 80, height: 24 } });
  assert.deepEqual(visibleRect(element, env), { left: 100, top: 50, width: 80, height: 24 });
});

test("zero-sized and sub-pixel elements are skipped", () => {
  for (const rect of [
    { left: 0, top: 0, width: 0, height: 0 },
    { left: 10, top: 10, width: 100, height: 1 },
  ]) {
    const { element, env } = scene({ rect });
    assert.equal(visibleRect(element, env), null, JSON.stringify(rect));
  }
});

test("CSS-hidden elements are skipped", () => {
  for (const style of [{ display: "none" }, { visibility: "hidden" }, { opacity: "0" }]) {
    const { element, env } = scene({ rect: { left: 0, top: 0, width: 50, height: 20 }, style });
    assert.equal(visibleRect(element, env), null, JSON.stringify(style));
  }
});

test("XUL hidden, collapsed and disabled attributes are respected", () => {
  for (const attributes of [{ hidden: "true" }, { collapsed: "true" }, { disabled: "true" }]) {
    const { element, env } = scene({ rect: { left: 0, top: 0, width: 50, height: 20 }, attributes });
    assert.equal(visibleRect(element, env), null, JSON.stringify(attributes));
  }
  const viaProperty = scene({
    rect: { left: 0, top: 0, width: 50, height: 20 },
    extra: { hidden: true },
  });
  assert.equal(visibleRect(viaProperty.element, viaProperty.env), null);
});

test("elements scrolled out of view are skipped", () => {
  const { element, env } = scene({ rect: { left: 10, top: 900, width: 100, height: 30 } });
  assert.equal(visibleRect(element, env), null);
});

test("a partially visible row is hinted at its visible part", () => {
  const { element, env } = scene({ rect: { left: -20, top: 780, width: 200, height: 40 } });
  assert.deepEqual(visibleRect(element, env), { left: 0, top: 780, width: 180, height: 20 });
});

test("elements covered by something unrelated are skipped", () => {
  const other = { localName: "div", contains: () => false };
  const { element, env } = scene({
    rect: { left: 100, top: 100, width: 60, height: 24 },
    topElement: other,
  });
  assert.equal(visibleRect(element, env), null);
});

test("a hit on a child of the element still counts as visible", () => {
  const child = { localName: "span", contains: () => false };
  const { element, env } = scene({
    rect: { left: 100, top: 100, width: 60, height: 24 },
    extra: { contains: node => node === child },
    topElement: child,
  });
  assert.ok(visibleRect(element, env));
});
