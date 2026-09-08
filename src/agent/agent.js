"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

/**
 * One agent lives in each hintable document. It owns the element references and
 * the overlay for that document; the coordinator in the Experiment API only
 * ever sees plain data (ids, labels, screen coordinates).
 */
Vimbird.createAgent = function createAgent(win) {
  let counter = 0;
  const prefix = `d${Math.random().toString(36).slice(2, 7)}`;
  /** @type {Map<string, Element>} */
  let elements = new Map();

  return {
    /** @returns {{id: string, screenX: number, screenY: number, tag: string}[]} */
    collect(options) {
      elements = new Map();
      const found = Vimbird.candidates.collect(win, Vimbird.targets, options);
      const offsetX = win.mozInnerScreenX ?? 0;
      const offsetY = win.mozInnerScreenY ?? 0;

      return found.map(({ element, rect }) => {
        const id = `${prefix}-${counter++}`;
        elements.set(id, { element, rect });
        return {
          id,
          screenX: Math.round(offsetX + rect.left),
          screenY: Math.round(offsetY + rect.top),
          tag: element.localName,
        };
      });
    },

    /** @param {{id: string, label: string}[]} assignments */
    render(assignments) {
      const items = [];
      for (const { id, label } of assignments) {
        const entry = elements.get(id);
        if (entry) {
          items.push({ id, label, rect: entry.rect });
        }
      }
      Vimbird.overlay.show(win, items);
      return items.length;
    },

    filter(input) {
      Vimbird.overlay.update(win, input);
    },

    activate(id, options) {
      const entry = elements.get(id);
      if (!entry) {
        return null;
      }
      Vimbird.overlay.hide(win);
      return Vimbird.activate.activateElement(entry.element, win, options ?? {});
    },

    clear() {
      Vimbird.overlay.hide(win);
      elements = new Map();
    },

    dispose() {
      this.clear();
      // `var Vimbird` is a non-configurable global, so drop the agent instead
      // of trying to delete the namespace.
      if (win.Vimbird) {
        win.Vimbird.agent = null;
      }
    },
  };
};

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
