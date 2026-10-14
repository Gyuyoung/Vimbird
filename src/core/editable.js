/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.editable = (() => {
  const NON_TEXT_INPUT_TYPES = new Set([
    "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
  ]);
  const EDITABLE_TAGS = new Set([
    "textarea", "select", "editor", "search-textbox", "menulist",
  ]);
  const EDITABLE_ROLES = new Set([
    "textbox", "searchbox", "combobox", "spinbutton",
  ]);

  /**
   * Whether typing into this element should reach the application instead of
   * Vimbird. Kept DOM-light so it can be unit tested with plain objects.
   *
   * @param {any} element
   * @returns {boolean}
   */
  function isEditable(element) {
    if (!element) {
      return false;
    }

    const tag = String(element.localName || "").toLowerCase();
    if (tag === "input") {
      const type = String(attr(element, "type") || element.type || "text").toLowerCase();
      return !NON_TEXT_INPUT_TYPES.has(type);
    }
    if (EDITABLE_TAGS.has(tag)) {
      return true;
    }
    if (element.isContentEditable === true) {
      return true;
    }
    if (EDITABLE_ROLES.has(String(attr(element, "role") || "").toLowerCase())) {
      return true;
    }
    if (element.ownerDocument && element.ownerDocument.designMode === "on") {
      return true;
    }
    return false;
  }

  /**
   * Walk up from the event target: focus often lands on a child of the widget
   * that actually holds the text (e.g. the input inside a search bar).
   *
   * @param {any} element
   * @param {number} [maxDepth]
   */
  function isInEditableContext(element, maxDepth = 6) {
    let node = element;
    for (let depth = 0; node && depth < maxDepth; depth++) {
      if (isEditable(node)) {
        return true;
      }
      node = node.parentNode || null;
    }
    return false;
  }

  /**
   * Whether a key event was typed into an editing context. Thunderbird's
   * search bars keep their <input> in a shadow root, so a listener on the
   * chrome window sees `target` retargeted to the <search-bar> host, and
   * `composedPath()` stops at the <browser> of an inner document. Gecko's
   * chrome-only `originalTarget` is the <input> in both cases (measured on
   * Thunderbird 155, see docs/verification.md).
   *
   * @param {any} event
   * @returns {boolean}
   */
  function isEditableKeyEvent(event) {
    return isInEditableContext(event.originalTarget || event.target);
  }

  function attr(element, name) {
    return typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
  }

  return { isEditable, isInEditableContext, isEditableKeyEvent };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
