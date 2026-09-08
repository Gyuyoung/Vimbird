"use strict";

// eslint-disable-next-line no-var
var Vimbird = typeof Vimbird === "object" && Vimbird ? Vimbird : {};

/**
 * The only place that carries Thunderbird-specific UI knowledge. Everything is
 * expressed as tag names, ARIA roles and `is=` custom element attributes, never
 * as individual element ids, so the engine keeps working when Thunderbird
 * renames or rearranges its widgets.
 *
 * Verified against Thunderbird 155 (messenger.xhtml, about:3pane, about:message).
 */
Vimbird.targets = (() => {
  // Elements that are clickable because of what they are.
  const INTRINSIC = [
    // HTML
    "a[href]", "button", "summary", "select", "textarea",
    "input:not([type='hidden'])",
    // ARIA
    "[role='button']", "[role='link']", "[role='tab']", "[role='checkbox']",
    "[role='menuitem']", "[role='menuitemcheckbox']", "[role='menuitemradio']",
    "[role='option']", "[role='treeitem']", "[role='switch']",
    // XUL widgets still used in the menu bar, tab bar and message header
    "toolbarbutton", "tab", "menu", "menuitem", "menulist", "checkbox", "radio", "richlistitem",
    // Thunderbird custom elements: unified toolbar buttons, folder rows,
    // thread rows and message cards all declare themselves with `is=`
    "button[is]", "li[is]", "tr[is]", "thread-card",
    // explicit click handlers
    "[onclick]", "[oncommand]",
  ];

  // Focusable containers and decorations that are not click targets.
  const NOISE = [
    "ul[is]", "ol[is]",
    "li.unselectable",
    "label:not([role]):not([onclick])",
    "[aria-hidden='true']",
    "#vimbird-hint-layer, #vimbird-hint-layer *",
  ];

  const INTRINSIC_SELECTOR = INTRINSIC.join(",");
  const NOISE_SELECTOR = NOISE.join(",");
  // Focusable-but-not-intrinsic elements are candidates only when they hold no
  // other candidate (see candidates.js): that keeps scroll containers out.
  const CANDIDATE_SELECTOR = `${INTRINSIC_SELECTOR},[tabindex]:not([tabindex='-1'])`;

  return { INTRINSIC_SELECTOR, NOISE_SELECTOR, CANDIDATE_SELECTOR };
})();

if (typeof module === "object" && module.exports) {
  module.exports = Vimbird;
}
