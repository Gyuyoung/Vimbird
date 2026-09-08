"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.visibility = (() => {
  const MIN_SIZE = 4;

  /**
   * The part of an element that is actually on screen, or null when the element
   * is hidden, empty, off-viewport or covered by something else.
   *
   * `env` isolates every DOM read so the logic can be unit tested with fakes:
   *   { rect(el), style(el), viewport(), elementFromPoint(x, y) }
   *
   * @returns {{left: number, top: number, width: number, height: number}|null}
   */
  function visibleRect(element, env, options = {}) {
    const minSize = options.minSize ?? MIN_SIZE;

    if (element.hidden === true) {
      return null;
    }
    for (const name of ["hidden", "collapsed", "disabled"]) {
      const value = attr(element, name);
      if (value === "true" || value === "") {
        return null;
      }
    }
    if (element.disabled === true) {
      return null;
    }

    const rect = env.rect(element);
    if (!rect || rect.width < minSize || rect.height < minSize) {
      return null;
    }

    const style = env.style(element);
    if (style) {
      if (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none") {
        return null;
      }
      if (Number.parseFloat(style.opacity) < 0.1) {
        return null;
      }
    }

    const viewport = env.viewport();
    const clipped = intersect(rect, viewport);
    if (!clipped || clipped.width < minSize || clipped.height < minSize) {
      return null;
    }

    if (!isOnTop(element, clipped, env)) {
      return null;
    }

    return clipped;
  }

  /** Hit test a few points so partially covered elements still get a hint. */
  function isOnTop(element, rect, env) {
    if (!env.elementFromPoint) {
      return true;
    }
    const inset = 3;
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + inset, rect.top + inset],
      [rect.left + rect.width - inset, rect.top + inset],
      [rect.left + inset, rect.top + rect.height - inset],
    ];
    for (const [x, y] of points) {
      const hit = env.elementFromPoint(x, y);
      if (hit && (hit === element || contains(element, hit) || contains(hit, element))) {
        return true;
      }
    }
    return false;
  }

  function contains(ancestor, node) {
    return typeof ancestor.contains === "function" ? ancestor.contains(node) : false;
  }

  function intersect(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.left + a.width, b.left + b.width);
    const bottom = Math.min(a.top + a.height, b.top + b.height);
    if (right <= left || bottom <= top) {
      return null;
    }
    return { left, top, width: right - left, height: bottom - top };
  }

  function attr(element, name) {
    return typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
  }

  /** Build the DOM-reading environment for a real window. */
  function domEnv(win) {
    return {
      rect: el => el.getBoundingClientRect(),
      style: el => {
        try {
          return win.getComputedStyle(el);
        } catch {
          return null;
        }
      },
      viewport: () => ({ left: 0, top: 0, width: win.innerWidth, height: win.innerHeight }),
      elementFromPoint: (x, y) => {
        try {
          return win.document.elementFromPoint(x, y);
        } catch {
          return null;
        }
      },
    };
  }

  return { visibleRect, domEnv, MIN_SIZE };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
