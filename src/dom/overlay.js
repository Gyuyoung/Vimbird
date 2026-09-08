"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

Vimbird.overlay = (() => {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const LAYER_ID = "vimbird-hint-layer";

  const CSS = `
#${LAYER_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  margin: 0;
  padding: 0;
}
#${LAYER_ID} .vimbird-hint {
  position: fixed;
  display: block;
  background: linear-gradient(#fff8b0, #ffd94a);
  color: #1a1a00;
  border: 1px solid #b58900;
  border-radius: 3px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  font: bold 11px/14px ui-monospace, "DejaVu Sans Mono", monospace;
  letter-spacing: 0.5px;
  padding: 0 3px;
  text-transform: uppercase;
  white-space: nowrap;
}
#${LAYER_ID} .vimbird-hint-typed {
  color: #c05000;
  opacity: 0.55;
}
#${LAYER_ID} .vimbird-hint[hidden] {
  display: none;
}
`;

  /**
   * Draw hints for one document.
   *
   * @param {Window} win
   * @param {{id: string, label: string, rect: object}[]} items
   */
  function show(win, items) {
    const doc = win.document;
    hide(win);

    const layer = doc.createElementNS(XHTML, "div");
    layer.id = LAYER_ID;
    layer.setAttribute("aria-hidden", "true");

    const style = doc.createElementNS(XHTML, "style");
    style.textContent = CSS;
    layer.appendChild(style);

    for (const item of items) {
      const hint = doc.createElementNS(XHTML, "div");
      hint.className = "vimbird-hint";
      hint.dataset.vimbirdLabel = item.label;
      hint.dataset.vimbirdId = item.id;

      const typed = doc.createElementNS(XHTML, "span");
      typed.className = "vimbird-hint-typed";
      const rest = doc.createElementNS(XHTML, "span");
      rest.className = "vimbird-hint-rest";
      rest.textContent = item.label;
      hint.append(typed, rest);

      const anchorLeft = Math.round(item.rect.left);
      const anchorTop = Math.round(item.rect.top);
      hint.dataset.vimbirdAnchor = `${anchorLeft},${anchorTop}`;
      hint.style.left = `${anchorLeft}px`;
      hint.style.top = `${anchorTop}px`;
      layer.appendChild(hint);
    }

    doc.documentElement.appendChild(layer);
    spreadOverlapping(win, layer);
    return items.length;
  }

  /**
   * Labels are first drawn on their element's corner, which collides whenever
   * elements sit close together (a row of inline links, narrow toolbar
   * buttons). Measure the drawn labels once, then move the colliding ones to
   * the nearest free spot.
   */
  function spreadOverlapping(win, layer) {
    const hints = [...layer.querySelectorAll(".vimbird-hint")];
    if (hints.length < 2) {
      return;
    }

    const labels = hints.map(hint => {
      const rect = hint.getBoundingClientRect();
      return {
        left: Number.parseFloat(hint.style.left),
        top: Number.parseFloat(hint.style.top),
        width: rect.width,
        height: rect.height,
      };
    });

    const viewport = { width: win.innerWidth, height: win.innerHeight };
    const positions = Vimbird.placement.layoutLabels(labels, viewport);

    hints.forEach((hint, index) => {
      hint.style.left = `${positions[index].left}px`;
      hint.style.top = `${positions[index].top}px`;
    });
  }

  /** Reflect typed input: grey out what was typed, hide labels that no longer match. */
  function update(win, input) {
    const layer = win.document.getElementById(LAYER_ID);
    if (!layer) {
      return;
    }
    for (const hint of layer.querySelectorAll(".vimbird-hint")) {
      const label = hint.dataset.vimbirdLabel;
      const matches = label.startsWith(input);
      hint.hidden = !matches;
      if (matches) {
        hint.querySelector(".vimbird-hint-typed").textContent = input;
        hint.querySelector(".vimbird-hint-rest").textContent = label.slice(input.length);
      }
    }
  }

  function hide(win) {
    win.document.getElementById(LAYER_ID)?.remove();
  }

  return { show, update, hide, LAYER_ID, XHTML };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
