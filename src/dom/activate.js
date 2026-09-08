"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

/**
 * Activation simulates a real primary-button click: mousedown → mouseup →
 * click, created with document.createEvent from privileged code so the events
 * are trusted, with button 0 and detail 1.
 *
 * `element.click()` is NOT the primary strategy even though it is simpler: it
 * dispatches a click with `detail: 0`, and Thunderbird's message list bails out
 * on exactly that (`tree-view.mjs`: "Bail out on non primary or double clicks",
 * `event.button !== 0 || event.detail !== 1`). Hints over the thread pane would
 * silently do nothing. See docs/verification.md.
 */
Vimbird.activate = (() => {
  function activateElement(element, win, options = {}) {
    try {
      const menu = openMenu(element);
      if (menu) {
        return menu;
      }
      return syntheticMouse(element, win, options);
    } catch (error) {
      win.console?.warn?.("Vimbird: mouse simulation failed, falling back to click()", error);
      try {
        element.click();
        return "click";
      } catch (fallbackError) {
        win.console?.warn?.("Vimbird: activation failed", fallbackError);
        return null;
      }
    }
  }

  /** Popups open more reliably by asking the widget than by faking a click. */
  function openMenu(element) {
    const tag = String(element.localName || "").toLowerCase();
    if ((tag === "menu" || tag === "menulist") && typeof element.openMenu === "function") {
      element.openMenu(true);
      return "openMenu";
    }
    return null;
  }

  function syntheticMouse(element, win, options) {
    const doc = element.ownerDocument;
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const screenX = (win.mozInnerScreenX ?? 0) + clientX;
    const screenY = (win.mozInnerScreenY ?? 0) + clientY;
    const ctrl = Boolean(options.newContext);
    const shift = Boolean(options.shift);

    for (const type of ["mousedown", "mouseup", "click"]) {
      const event = doc.createEvent("MouseEvent");
      event.initMouseEvent(
        type,
        /* canBubble */ true,
        /* cancelable */ true,
        win,
        /* detail (click count) */ 1,
        screenX, screenY,
        clientX, clientY,
        ctrl,
        /* altKey */ false,
        shift,
        /* metaKey */ false,
        /* button */ 0,
        /* relatedTarget */ null
      );
      element.dispatchEvent(event);
    }
    return "syntheticMouse";
  }

  return { activateElement };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
