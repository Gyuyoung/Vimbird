/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

/**
 * Keeps hint labels readable when their elements sit close together — a row of
 * inline links or narrow toolbar buttons would otherwise stack labels on top of
 * each other.
 *
 * Each label starts at its element's resting place and, if that spot is taken,
 * moves to the nearest free one: first stepping above and below, then sideways,
 * so a label never drifts far from the element it belongs to.
 */
Vimbird.placement = (() => {
  const GAP = 2;
  const MAX_STEPS = 3;
  // How much taller than its label an element has to be before its label is
  // confined to it.
  const BOUNDS_FACTOR = 1.5;

  /**
   * Where a label rests on its element: against the left edge, centred on the
   * element's height. Sitting on the top edge instead puts the label on the
   * border between two rows, where it reads as belonging to the row above.
   *
   * @param {{left: number, top: number, width: number, height: number}} target
   * @param {{height: number}} label - the label's measured size
   * @returns {{left: number, top: number}}
   */
  function anchor(target, label) {
    return {
      left: target.left,
      // A label taller than its element straddles it evenly rather than being
      // pushed off one end.
      top: target.top + (target.height - label.height) / 2,
    };
  }

  /**
   * @param {{left: number, top: number, width: number, height: number,
   *          bounds?: {top: number, bottom: number}}[]} labels
   *   anchor position and measured size of each label, in ranking order.
   *   `bounds` is the element's own vertical extent, when it has one.
   * @param {{width: number, height: number}} viewport
   * @returns {{left: number, top: number}[]} positions in the same order
   */
  function layoutLabels(labels, viewport, options = {}) {
    const gap = options.gap ?? GAP;
    const maxSteps = options.maxSteps ?? MAX_STEPS;
    const placed = [];
    const positions = [];

    for (const label of labels) {
      let chosen = null;
      for (const [dx, dy] of candidateOffsets(label, gap, maxSteps)) {
        const box = clamp({ ...label, left: label.left + dx, top: label.top + dy }, viewport);
        // A label that leaves its own element lands on the neighbour and is
        // read as the neighbour's: better to sit at the anchor than to lie.
        if (!within(box, label.bounds)) {
          continue;
        }
        if (!placed.some(other => overlaps(other, box))) {
          chosen = box;
          break;
        }
      }
      // Every nearby spot is taken: keep the label on its element rather than
      // banishing it somewhere unrelated.
      chosen = chosen ?? clamp(label, viewport);
      placed.push(chosen);
      positions.push({ left: chosen.left, top: chosen.top });
    }

    return positions;
  }

  function* candidateOffsets(label, gap, maxSteps) {
    yield [0, 0];
    const stepY = label.height + gap;
    const stepX = label.width + gap;
    for (let step = 1; step <= maxSteps; step++) {
      yield [0, -step * stepY];
      yield [0, step * stepY];
    }
    for (let step = 1; step <= maxSteps; step++) {
      yield [step * stepX, 0];
      yield [-step * stepX, 0];
      yield [step * stepX, -stepY];
      yield [step * stepX, stepY];
    }
  }

  /**
   * Whether a label may sit here. Rows are the case that matters: a label
   * nudged out of a 28px message row lands on the row below and is read as
   * that row's, so on anything comfortably taller than the label the search is
   * confined to the element itself. Links and buttons about the size of their
   * label have no room to give and keep the full search — their neighbours are
   * alongside, not above and below.
   */
  function within(box, bounds) {
    if (!bounds || bounds.bottom - bounds.top < box.height * BOUNDS_FACTOR) {
      return true;
    }
    return box.top >= bounds.top - 1 && box.top + box.height <= bounds.bottom + 1;
  }

  function overlaps(a, b) {
    return (
      a.left < b.left + b.width &&
      b.left < a.left + a.width &&
      a.top < b.top + b.height &&
      b.top < a.top + a.height
    );
  }

  function clamp(box, viewport) {
    const left = Math.round(Math.min(Math.max(box.left, 0), Math.max(viewport.width - box.width, 0)));
    const top = Math.round(Math.min(Math.max(box.top, 0), Math.max(viewport.height - box.height, 0)));
    return { left, top, width: box.width, height: box.height };
  }

  return { anchor, layoutLabels, GAP, MAX_STEPS, BOUNDS_FACTOR };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
