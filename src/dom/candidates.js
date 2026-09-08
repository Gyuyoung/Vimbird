/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.candidates = (() => {
  const MAX_CANDIDATES = 400;
  const MIN_ROW = 8;
  // A child stacked below its parent spans the parent's width; a button sitting
  // on the parent's own first line does not. Only the first kind marks where
  // the parent's row ends.
  const STACKED_WIDTH = 0.6;

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

    return clipToOwnRow(dropDuplicateRects(found));
  }

  /**
   * A folder row's `<li>` wraps the whole subtree beneath it, so its box runs
   * from its own row down past every child row. Clip a candidate's box where
   * the first candidate stacked below it starts: what is left is the strip a
   * user sees as that element, which is where its hint belongs and where a
   * synthetic click has to land. Without this, the hint for "Local Folders"
   * sits in the middle of its children and its click lands on one of them.
   *
   * Only full-width children count. A message card carries a star button on its
   * own first line, and treating that as the end of the row would clip the card
   * to a sliver and drag its label up to the top edge.
   */
  function clipToOwnRow(items) {
    return items.map(item => {
      const { element, rect } = item;
      let bottom = rect.top + rect.height;
      for (const other of items) {
        // Cheap numeric tests first; `contains` is the expensive part.
        if (other === item || other.rect.top <= rect.top || other.rect.top >= bottom) {
          continue;
        }
        if (other.rect.width < rect.width * STACKED_WIDTH) {
          continue;
        }
        if (element.contains?.(other.element)) {
          bottom = other.rect.top;
        }
      }
      const height = bottom - rect.top;
      if (height >= rect.height || height < MIN_ROW) {
        return item;
      }
      return { element, rect: { ...rect, height } };
    });
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

  return { collect, clipToOwnRow, MAX_CANDIDATES, MIN_ROW, STACKED_WIDTH };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
