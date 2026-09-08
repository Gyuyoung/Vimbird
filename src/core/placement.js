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
 * Each label starts at its element's corner and, if that spot is taken, moves
 * to the nearest free one: first stepping above and below, then sideways, so a
 * label never drifts far from the element it belongs to.
 */
Vimbird.placement = (() => {
  const GAP = 2;
  const MAX_STEPS = 3;

  /**
   * @param {{left: number, top: number, width: number, height: number}[]} labels
   *   anchor position and measured size of each label, in ranking order
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

  return { layoutLabels, GAP, MAX_STEPS };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
