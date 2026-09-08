"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.ranking = (() => {
  const ROW_BAND = 12;

  /**
   * Order candidates the way a reader scans the screen: top to bottom, then
   * left to right within a horizontal band. Candidates carry absolute screen
   * coordinates so items from different documents interleave correctly.
   *
   * @template {{screenX: number, screenY: number}} T
   * @param {T[]} items
   * @param {number} [band] - height in px treated as the same visual row
   * @returns {T[]} new sorted array
   */
  function sortByScreenPosition(items, band = ROW_BAND) {
    return [...items].sort((a, b) => {
      const rowA = Math.floor(a.screenY / band);
      const rowB = Math.floor(b.screenY / band);
      if (rowA !== rowB) {
        return rowA - rowB;
      }
      if (a.screenX !== b.screenX) {
        return a.screenX - b.screenX;
      }
      return a.screenY - b.screenY;
    });
  }

  return { sortByScreenPosition, ROW_BAND };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
