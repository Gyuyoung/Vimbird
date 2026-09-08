"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.matcher = (() => {
  /**
   * @typedef {object} MatchResult
   * @property {"exact"|"partial"|"none"} status
   * @property {number} index - index of the exact match, -1 otherwise
   * @property {number[]} matches - indices still reachable with more input
   */

  /**
   * Resolve typed input against a prefix-free label set.
   *
   * @param {string[]} labels
   * @param {string} input
   * @returns {MatchResult}
   */
  function resolve(labels, input) {
    if (!input) {
      return { status: "partial", index: -1, matches: labels.map((_, i) => i) };
    }

    const matches = [];
    let exact = -1;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label === input) {
        exact = i;
        matches.push(i);
      } else if (label.startsWith(input)) {
        matches.push(i);
      }
    }

    if (exact !== -1) {
      return { status: "exact", index: exact, matches: [exact] };
    }
    if (matches.length) {
      return { status: "partial", index: -1, matches };
    }
    return { status: "none", index: -1, matches: [] };
  }

  /**
   * Whether a keydown event should be treated as hint input.
   *
   * @param {{key: string, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean}} event
   * @param {string} alphabet
   */
  function isHintKey(event, alphabet) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }
    return event.key.length === 1 && alphabet.includes(event.key.toLowerCase());
  }

  return { resolve, isHintKey };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
