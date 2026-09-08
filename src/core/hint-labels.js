/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.labels = (() => {
  const DEFAULT_CHARS = "asdfghjkl";

  /**
   * Generate `count` hint labels that are unique, prefix-free and length-balanced.
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

    return hints
      .slice(offset, offset + count)
      .map(hint => [...hint].reverse().join(""))
      .sort();
  }

  return { generateLabels, DEFAULT_CHARS };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
