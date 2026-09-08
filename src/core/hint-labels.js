/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.labels = (() => {
  // Home row first, then the row above it. The order is the order of
  // preference: labels are handed out from the front, so the easiest keys are
  // used first and the pinky reaches at the end only turn up in busy windows.
  // The size matters more than the letters: n characters cover n^2 elements in
  // two keystrokes, and a full 3-pane window runs to about a hundred hints, so
  // nine characters (81) was not enough and nineteen (361) always is.
  const DEFAULT_CHARS = "asdfghjklqwertyuiop";

  /**
   * Generate `count` hint labels that are unique, prefix-free and as short as
   * the alphabet allows.
   *
   * Returned shortest first, and within one length in the alphabet's own order
   * rather than alphabetically, so a caller that hands them out in ranked order
   * gives the fewest, easiest keystrokes to the most prominent elements.
   *
   * @param {number} count
   * @param {string} [chars] - hint alphabet, at least two characters
   * @returns {string[]}
   */
  function generateLabels(count, chars = DEFAULT_CHARS) {
    if (count <= 0) {
      return [];
    }
    const alphabet = [...chars];
    if (alphabet.length < 2) {
      throw new Error("Vimbird: hint alphabet needs at least two characters");
    }

    const hints = [""];
    let offset = 0;
    while (hints.length - offset < count || hints.length === 1) {
      const base = hints[offset++];
      for (const char of alphabet) {
        hints.push(char + base);
      }
    }

    const rank = new Map(alphabet.map((char, index) => [char, index]));
    return hints
      .slice(offset, offset + count)
      .map(hint => [...hint].reverse().join(""))
      .sort((a, b) => {
        if (a.length !== b.length) {
          return a.length - b.length;
        }
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) {
            return rank.get(a[i]) - rank.get(b[i]);
          }
        }
        return 0;
      });
  }

  return { generateLabels, DEFAULT_CHARS };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
