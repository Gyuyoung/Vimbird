/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.candidates = (() => {
  const MAX_CANDIDATES = 400;

  /**
   * Find hintable elements in a document.
   *
   * @param {Window} win
   * @param {object} selectors - from Vimbird.targets
   * @param {object} [options]
   * @returns {{element: Element, rect: {left: number, top: number, width: number, height: number}}[]}
   */
  function collect(win, selectors, options = {}) {
    const doc = win.document;
    const env = Vimbird.visibility.domEnv(win);
    const limit = options.limit ?? MAX_CANDIDATES;

    const found = [];
    const seen = new Set();

    for (const element of doc.querySelectorAll(selectors.CANDIDATE_SELECTOR)) {
      if (found.length >= limit) {
        break;
      }
      if (seen.has(element) || element.matches(selectors.NOISE_SELECTOR)) {
        continue;
      }
      if (!isIntrinsic(element, selectors) && hasCandidateDescendant(element, selectors)) {
        continue;
      }

      const rect = Vimbird.visibility.visibleRect(element, env, options);
      if (!rect) {
        continue;
      }

      seen.add(element);
      found.push({ element, rect });
    }

    return dropDuplicateRects(found);
  }

  function isIntrinsic(element, selectors) {
    try {
      return element.matches(selectors.INTRINSIC_SELECTOR);
    } catch {
      return false;
    }
  }

  function hasCandidateDescendant(element, selectors) {
    try {
      return element.querySelector(selectors.INTRINSIC_SELECTOR) !== null;
    } catch {
      return false;
    }
  }

  /**
   * A wrapper and its only child often share the same box. Keep the innermost
   * one so activation lands on the element that carries the handler.
   */
  function dropDuplicateRects(items) {
    const kept = [];
    for (const item of items) {
      const twinIndex = kept.findIndex(other => sameBox(other.rect, item.rect));
      if (twinIndex === -1) {
        kept.push(item);
        continue;
      }
      const twin = kept[twinIndex];
      if (twin.element.contains?.(item.element)) {
        kept[twinIndex] = item;
      }
    }
    return kept;
  }

  function sameBox(a, b, tolerance = 2) {
    return (
      Math.abs(a.left - b.left) <= tolerance &&
      Math.abs(a.top - b.top) <= tolerance &&
      Math.abs(a.width - b.width) <= tolerance &&
      Math.abs(a.height - b.height) <= tolerance
    );
  }

  return { collect, MAX_CANDIDATES };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
