"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { editable } = require("../src/core/editable.js");
const { isEditable, isInEditableContext } = editable;

function element(localName, attributes = {}, extra = {}) {
  return {
    localName,
    getAttribute: name => attributes[name] ?? null,
    ...extra,
  };
}

test("text-entry widgets swallow keys", () => {
  assert.ok(isEditable(element("input", { type: "text" })));
  assert.ok(isEditable(element("input", {})), "input defaults to a text field");
  assert.ok(isEditable(element("input", { type: "search" })));
  assert.ok(isEditable(element("textarea")));
  assert.ok(isEditable(element("select")));
  assert.ok(isEditable(element("editor")), "XUL editor in the compose window");
  assert.ok(isEditable(element("div", {}, { isContentEditable: true })));
  assert.ok(isEditable(element("div", { role: "searchbox" })), "Thunderbird search bar");
});

test("clickable widgets do not", () => {
  assert.ok(!isEditable(element("button")));
  assert.ok(!isEditable(element("toolbarbutton")));
  assert.ok(!isEditable(element("input", { type: "checkbox" })));
  assert.ok(!isEditable(element("input", { type: "button" })));
  assert.ok(!isEditable(element("li", { is: "folder-tree-row" })));
  assert.ok(!isEditable(null));
});

test("a document in design mode is editable", () => {
  const body = element("body", {}, { ownerDocument: { designMode: "on" } });
  assert.ok(isEditable(body));
});

test("focus on a child of a text widget still counts as editing", () => {
  const input = element("input", { type: "text" });
  const wrapper = element("div", {}, { parentNode: input });
  const icon = element("span", {}, { parentNode: wrapper });
  assert.ok(isInEditableContext(icon));
});

test("focus inside a toolbar does not count as editing", () => {
  const toolbar = element("toolbar");
  const button = element("button", {}, { parentNode: toolbar });
  const label = element("span", {}, { parentNode: button });
  assert.ok(!isInEditableContext(label));
});

test("the ancestor walk is bounded", () => {
  let node = element("input", { type: "text" });
  for (let depth = 0; depth < 20; depth++) {
    node = element("div", {}, { parentNode: node });
  }
  assert.ok(!isInEditableContext(node), "a far-away ancestor must not block hint mode");
});
