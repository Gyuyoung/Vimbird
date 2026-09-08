# Phase 2 — Vimbird architecture

Written: 2026-09-08
Premise: the findings in [`docs/research.md`](research.md), measured against a Thunderbird 155.0 build

---

## 1. Goals and constraints

### 1.1 Goals

1. `f` → hints appear on the clickable parts of the UI → type a hint → the element is really clicked. `Esc` cancels.
2. **No hardcoded button IDs.** Candidates come from a general DOM pipeline.
3. **Keep the hint engine separate from Thunderbird-specific code.**
4. A mode state machine that `j/k`, `gg/G`, `o`, `r`, `a`, `x`, `d` and `/` can be built on later.

### 1.2 Constraints settled by the research (the ones that shape the design)

| # | Constraint | Effect on the design |
|---|---|---|
| C1 | The `commands` API cannot register a bare `f` (`ShortcutUtils.validate` → `MODIFIER_REQUIRED`) | Keys are taken with a `keydown` listener inside the Experiment |
| C2 | Content scripts cannot be injected into chrome documents such as `about:3pane` | All chrome DOM access goes through the Experiment |
| C3 | `about:3pane` / `about:message` are not remote → synchronous access from the parent process | **No** JSWindowActor, frame script or IPC. Direct function calls |
| C4 | The target UI is spread over several documents (chrome window / about:3pane / about:message / compose) | A per-document engine with a per-window coordinator. Hint labels are **globally unique** |
| C5 | The thread list is virtualised | Only rendered rows are candidates. Scrolling or resizing invalidates the hints |
| C6 | No shadow DOM; mostly standard HTML with some XUL elements | `querySelectorAll` applies. XUL's `hidden`/`collapsed` attributes need separate handling |
| C7 | An Experiment suppression switch exists in the code (currently off, temporary installs exempt) | Minimise the Experiment surface and keep the pure logic separate |
| C8 | Whether key events cross document boundaries was unverified | Make the key-listening strategy **replaceable** (decided in Spike 0) |

---

## 2. The architecture as a whole

```
┌─────────────────────────────────────────────────────────────────────┐
│ WebExtension (ordinary privileges)                                  │
│                                                                     │
│  background.js  ── settings (storage), default keymap, diagnostics  │
│        │  browser.vimbird.* (calls into the Experiment API)         │
└────────┼────────────────────────────────────────────────────────────┘
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Experiment API (parent process / privileged)  experiments/vimbird/  │
│                                                                     │
│  implementation.js                                                  │
│   ├ WindowWatcher   attaches to mail:3pane / msgcompose /           │
│   │                 messageWindow via                               │
│   │                 ExtensionSupport.registerWindowListener         │
│   └ WindowSession (one per window)                                  │
│      ├ DocumentRegistry  enumerates the window's live documents     │
│      │    · messenger.xhtml (chrome)                                │
│      │    · tabmail.currentAbout3Pane                               │
│      │    · tabmail.currentAboutMessage                             │
│      ├ KeyBridge        receives keydown (strategy A or B, §6)      │
│      └ HintSession      owns one hint session's lifetime (§5)       │
└────────┬────────────────────────────────────────────────────────────┘
         │ synchronous function calls (C3)
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Per-document engine (runs inside each target document)              │
│                                                                     │
│  DocumentAgent  ← injected with Services.scriptloader.loadSubScript │
│   ├ collect()   find candidates  (dom/candidates.js + tb/targets.js)│
│   ├ render()    draw the hint overlay (dom/overlay.js)              │
│   ├ filter()    update the display as input arrives                 │
│   ├ activate()  the real click (dom/activate.js)                    │
│   └ clear()     tear down                                           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ core/ — pure logic, free of Thunderbird and the DOM (unit-tested)   │
│   hint-labels.js   label generation                                 │
│   hint-matcher.js  input → candidate filter state machine           │
│   placement.js     pushing overlapping labels apart                 │
│   ranking.js       ordering candidates by screen position           │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 The layering rule

| Layer | Knows about Thunderbird | Needs the DOM | How it is tested |
|---|---|---|---|
| `core/` | No | No | Node unit tests |
| `dom/` | No (general DOM rules only) | Yes | Unit tests against injected fake adapters |
| `tb/` | **Only here** (selectors, XUL exceptions, virtual scrolling) | Yes | Manual testing in Thunderbird |
| `experiments/` | Window and document lifetimes | Yes | Manual testing in Thunderbird |

The measure of whether this separation worked: "when Thunderbird rearranges its UI again, only `tb/targets.js` changes".

---

## 3. Reaching Thunderbird's UI

### 3.1 Attaching to windows

```js
ExtensionSupport.registerWindowListener("vimbird", {
  chromeURLs: [
    "chrome://messenger/content/messenger.xhtml",              // mail:3pane
    "chrome://messenger/content/messengercompose/messengercompose.xhtml", // msgcompose
    "chrome://messenger/content/messageWindow.xhtml",          // standalone message window
  ],
  onLoadWindow(win) { sessions.set(win, new WindowSession(win)); },
  onUnloadWindow(win) { sessions.get(win)?.dispose(); sessions.delete(win); },
});
```

Why `ExtensionSupport` (`modules/ExtensionSupport.sys.mjs`): it handles both windows that are already open and windows opened later, and being Thunderbird's own utility for add-ons, it deals with window-initialisation timing itself. `Services.wm.getMostRecentWindow()` only ever returns one window at this instant, so it misses multiple and new windows — it is for diagnostics and one-off access only.

### 3.2 Enumerating documents (`DocumentRegistry`)

```js
*documents() {
  yield { id: "chrome", doc: win.document, win };              // toolbar, tabs, menu bar
  const tabmail = win.document.getElementById("tabmail");
  const a3p = tabmail?.currentAbout3Pane;                       // tabmail.js:1441
  if (a3p) yield { id: "about3pane", doc: a3p.document, win: a3p };
  const am = tabmail?.currentAboutMessage;                      // tabmail.js:1454
  if (am) yield { id: "aboutmessage", doc: am.document, win: am };
}
```

- **`tabmail.currentAbout3Pane` and `currentAboutMessage` are accessors Thunderbird provides officially**, so the current tab's documents come back without guessing at internal DOM structure.
- On a tab that is not a 3-pane (settings, calendar, a content tab) `currentAbout3Pane` is `null`, and only the chrome document is hinted, which is the right thing anyway.
- In a compose window the enumeration covers the chrome document and `getBrowser().contentDocument` (the body editor). The MVP excludes the inside of the body editor from hinting (§9 scope).
- The message **body** — the `<browser id="messagepane" type="content">` inside `about:message` — is a Phase 2 extension. It is a content document, so the proper route is the standard `scripting.messageDisplay` API rather than forcing it through the Experiment.

### 3.3 Injecting the per-document agent

```js
Services.scriptloader.loadSubScriptWithOptions(
  extension.rootURI.resolve("src/agent/agent.js"),  // core/dom/tb modules, in order
  { target: targetWindow, allowUnsafeURL: true }    // creates the Vimbird namespace on this window
);
```

Building the agent on the target window's global with `loadSubScript` is the pattern tbkeys proved when it injects Mousetrap. The reasons:

- The overlay can be drawn **directly in each document's own coordinate system**, so no coordinate conversion is needed.
- Key listeners can be attached inside the document, which supports strategy B in §6 unchanged.
- It runs into fewer cross-compartment wrapper problems than driving another document's DOM remotely from the parent.

Thanks to C3 (synchronous access), the parent and the agents talk by **direct function call rather than message passing**.

---

## 4. Event and key handling

### 4.1 The mode state machine (`VimbirdWindow.decide()`)

```
        ┌──────────┐   f (not editing)      ┌──────────┐
        │  normal  │ ─────────────────────▶ │   hint   │
        │          │ ◀───────────────────── │          │
        └──────────┘   Esc / activated      └──────────┘
             │                                   │
   Phase 5:  │ j k g G o r a x d /               │ [a-z] accumulates, Backspace deletes
             ▼                                   ▼
        (command dispatch)              (filter → activate on a unique match)
```

- Mode transitions and key routing are pure functions; the side effects (drawing hints, clicking) are performed by the caller, which keeps them unit-testable.
- The state machine carries a `pending` buffer and a timeout from the start, for multi-key sequences like Phase 5's `gg`.

### 4.2 Which keys are consumed

| Situation | Handling |
|---|---|
| `normal` + `f` + not an editing context | Consume (`preventDefault` + `stopPropagation`) and enter hint mode |
| `normal` + any other key | **Not consumed** (Thunderbird's own shortcuts are preserved) |
| `hint` + a hint character | Consumed, filter updated |
| `hint` + `Esc` | Consumed, cancelled |
| `hint` + `Backspace` | Consumed, last character removed |
| `hint` + an unrelated key | Consumed and hint mode ends (Vimium's behaviour) — avoiding a misfire comes first |
| Focus in an editing context | **No key is consumed** (test 11) |

### 4.3 Deciding what counts as an editing context (`isEditableTarget`)

```js
target.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")
  || target.isContentEditable
  || doc.designMode === "on"
  || ["textbox","searchbox","combobox"].includes(target.getAttribute?.("role"))
  || XUL: target.localName === "editor" || an ancestor is <search-bar>/global-search-bar
```

Thunderbird's own handlers do not guard this way (research §6.3), so we have to. The decision lives in `core` and takes the element-query functions by injection, which makes it testable.

---

## 5. The hint pipeline

The pipeline that was asked for is used directly as the module boundary.

```
DOM
 ↓  tb/targets.js       the selector set (HTML + XUL + TB custom elements)
visible elements
 ↓  dom/visibility.js   rect, style, XUL hidden/collapsed, viewport intersection, occlusion
clickable elements
 ↓  dom/candidates.js   drop duplicates and nested repeats, skip disabled elements
candidate filtering
 ↓  core/ranking.js     global ordering by screen position (mozInnerScreenX/Y corrected)
hint generation
 ↓  core/hint-labels.js balanced label generation (globally unique)
hint overlay
 ↓  dom/overlay.js      absolutely positioned in a per-document overlay container
keyboard matching
 ↓  core/hint-matcher.js prefix-matching state machine
element activation
 ↓  dom/activate.js     the activation strategy chain
```

### 5.1 Candidate selectors (`tb/targets.js`) — no hardcoded IDs

```js
export const CLICKABLE_SELECTORS = [
  // standard HTML
  "a[href]", "button", "summary", "select", "input:not([type='hidden'])", "textarea",
  "[role='button']", "[role='link']", "[role='tab']", "[role='checkbox']",
  "[role='menuitem']", "[role='treeitem']", "[role='option']",
  "[onclick]", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
  // XUL (message header toolbar, menu bar, tab bar and so on)
  "toolbarbutton", "tab", "menu", "menulist", "checkbox", "radio", "richlistitem",
  // Thunderbird custom elements — by tag and attribute, never by individual ID
  "button[is]",            // unified-toolbar-button and the various *-button elements
  "li[is='folder-tree-row']",
  "tr[is]",                // the tree-view-table-row family
  "thread-card",
];
```

- Individual button IDs such as `#hdrReplyButton` appear **nowhere**. Only roles, tags and `is=` attributes are used.
- When Thunderbird adds a new custom element, the `button[is]` and `[role=…]` rules usually pick it up automatically.
- This file is the single place where Thunderbird knowledge is concentrated (which is what C7 asks for).

### 5.2 Visibility and clickability (`dom/visibility.js`)

In order, cheapest first:

1. `rect = el.getBoundingClientRect()` → `width*height > 0`
2. Viewport intersection: the intersection area with the document viewport must be > 0 (this excludes what is scrolled away and fits C5's virtual scrolling naturally)
3. `style.visibility !== "hidden"`, `display !== "none"`, `opacity > 0.05`
4. XUL only: check `el.hidden`, `el.getAttribute("collapsed")`, `el.getAttribute("disabled")`
5. Occlusion: `doc.elementFromPoint()` at the rect's centre and four nearby points; it passes if the result is the candidate itself or one of its ancestors or descendants (the same heuristic Vimium uses)
6. Nesting: when a rect's IoU with an already-accepted candidate is above a threshold (0.9, say) and the two are in an ancestor-descendant relationship, **only the outer one is kept**

DOM access arrives as an injected adapter object (`{ rect, style, elementFromPoint }`), so this is unit-tested against fakes.

### 5.3 Label generation (`core/hint-labels.js`)

The same balanced-tree approach as Vimium:

```js
export function generateLabels(count, chars = "asdfghjklqwertyuiop") {
  const hints = [""]; let offset = 0;
  while (hints.length - offset < count || hints.length === 1) {
    const base = hints[offset++];
    for (const c of chars) hints.push(c + base);
  }
  return hints.slice(offset, offset + count)
              .map(s => [...s].reverse().join(""))
              .sort(byLengthThenAlphabetOrder);   // alphabet order = order of preference
}
```

Properties it guarantees (all covered by tests):

- One label per candidate, all unique
- **Prefix-free**: no label is a prefix of another, so "click as soon as it matches exactly" is unambiguous (test 15)
- Lengths differ by at most one (balanced)
- **Sorted by length first, then by the alphabet's own order.** Sorting as text would put the two-character `aa` ahead of the single-character `d`, which hands the element at the very top of the window the label that takes two keystrokes.
- The size of the alphabet decides the label length: n characters cover n² elements in two keystrokes. **Measured**: a 1952×1092 window with 12 folders and 60 messages produces 80 hints, so nine home-row characters (81 labels) were not enough. The home row plus the row above it — 19 characters, 361 labels — never reaches three. Because the order of the string is the order of preference, the awkward `q` and `p` only appear when there are many hints.

**Handing labels out** is `core/ranking.js`'s job: candidates are sorted top-to-bottom and left-to-right by screen position (with each document's `mozInnerScreenX/Y` offset applied), then labels are assigned in that order. Labels are therefore **globally unique across documents** (C4), and elements nearer the top get the shorter labels.

### 5.4 The overlay (`dom/overlay.js`)

- Container: a `<div id="vimbird-hint-layer">` appended to `doc.documentElement`. **Measured**: the layer renders correctly in both `messenger.xhtml` and `about:3pane` (`visibility: visible`), lands exactly at the coordinates given, and thanks to `pointer-events: none` leaves `elementFromPoint()` at a target's centre still returning the target.
- **Namespace**: `document.createElement("div")` was measured to return the XHTML namespace in both documents, since the root is `<html>`. Even so, `createElementNS(XHTML_NS, ...)` is used **explicitly** — `messenger.xhtml` mixes in a XUL default namespace (`<html:body xmlns="…there.is.only.xul">` at `messenger.xhtml:302`), and the explicit call prevents silently creating XUL elements if the container is ever attached elsewhere or a XUL document becomes a target.
- Position: `position: fixed; left: rect.left px; top: rect.top px;` — each document's own coordinate system, so no conversion.
- **Resolving overlaps** (`core/placement.js`): left exactly on an element's corner, labels for elements that sit close together — inline links, narrow toolbar buttons — **cover one another**. So labels are drawn at their anchors first, measured once at their real size, and only the colliding ones move to the nearest free spot (up, then down, then sideways, at most three steps). The movement is bounded so a label never loses its association with its element, and a label that finds no free spot stays where it was. The placement calculation is a pure function independent of the DOM, so it is unit-tested. Measured: on a message header with 14 recipients, 9 pairs overlapped at the anchors and none do after spreading.
- Styling: one inline `<style>` is injected and every rule is scoped under `#vimbird-hint-layer`. Colours, fonts and shadows are stated explicitly to avoid inheriting the theme.
- The typed characters and the remaining ones are separate `<span>`s in different colours (Vimium's approach), so progress through a multi-character hint is visible (test 14).
- `z-index` is at maximum. Native `menupopup` content lives in an OS widget layer that cannot be covered, which is stated as out of scope for the MVP.
- Invalidation: `resize`, `scroll` (capture, passive), `TabSelect` and document unload **end the hint session immediately** (tests 12 and 13). Ending is safer than recomputing positions and matches what Vimium does.

### 5.5 Activation (`dom/activate.js`) — **settled by measurement**

> Four strategies were applied to real widgets in a headless TB 155 instance and judged by observable results (the app menu panel opening, a compose window appearing, the folder selection changing). See `docs/verification.md` for the scripts.

| Strategy | XUL `toolbarbutton`<br>(`#button-appmenu`) | HTML `button`<br>(`#folderPaneWriteMessage`) | Folder row<br>(`li[is=folder-tree-row]`) | Thread row<br>(`tr[is=tree-view-table-row]`) | Verdict |
|---|---|---|---|---|---|
| `el.click()` | ✅ panel opens | ✅ compose window appears | ✅ folder switches | **❌ nothing** | Fallback only |
| `createEvent("MouseEvent")` + `initMouseEvent`, mousedown→mouseup→click | ✅ | ✅ | ✅ | ✅ message displayed | **First choice** |
| `createEvent("XULCommandEvent")` + `initCommandEvent` | ❌ nothing | ❌ | — | — | Not used |
| `windowUtils.sendMouseEvent(...)` | **the API does not exist** | — | — | — | **Impossible** |

The resulting strategy chain:

1. XUL `menu` (a dropdown): `el.openMenu?.(true)` — opening a popup explicitly is more reliable than synthesising a click
2. **A trusted mousedown → mouseup → click sequence** (`button: 0`, `detail: 1`, at the element's centre). Built with `doc.createEvent("MouseEvent")` in a privileged context, these are trusted events
3. Fallback: `el.click()`, only when building the sequence fails

**Why `el.click()` is not the first choice** (found through a bug in real use): the thread list's handler returns immediately when `event.button !== 0 || event.detail !== 1` (`tree-view.mjs:1387-1392`), and the event `HTMLElement.click()` produces carries `detail: 0`. The folder tree has no such check, which is why the problem was invisible at first.

An important correction: **`nsIDOMWindowUtils.sendMouseEvent` does not exist in TB 155.** What remains, as measured, is `sendNativeMouseEvent` (OS level, screen coordinates, asynchronous) and `dispatchDOMEventViaPresShellForTesting`. The `sendMouseEvent`-based click synthesis common in older add-ons and documentation **simply fails on the current version**, so it is not used.

- `F` (open in a new context) will extend the fallback path by setting the Ctrl/Shift flags on `initMouseEvent`.
- The hint layer is removed just before activation, and the layer carries `pointer-events: none` anyway (measured: with the layer up, `elementFromPoint` at a target's centre still returns the target).

---

## 6. The key-listening strategy — **settled by measurement (strategy A)**

The unverified item C8 was measured on a headless Thunderbird 155 with real key input (Marionette `PerformActions`).

**Measurement 1 — crossing the document boundary**: with focus on `#folderTree` in `about:3pane` and `f` pressed, listeners fired in this order:

```
1. chromeWin.capture     target=about:3pane <ul>   ← the outer chrome window is first
2. a3pWin.capture        target=about:3pane <ul>
3. chromeDoc.bubble      target=about:3pane <ul>
4. chromeWin.sysgroup    target=about:3pane <ul>
5. a3pWin.sysgroup       target=about:3pane <ul>
```

→ **A key event in the inner document does reach the outer chrome window's capture listener, and reaches it first.** (The chrome event handler path of an in-process `<browser>`; `isRemoteBrowser === false` was confirmed by measurement.) **Strategy A, one listener per window, is therefore enough.**

**Measurement 2 — consuming the key**: calling `preventDefault() + stopPropagation()` from the chrome window's capture listener:

| Listener | `f` (consumed) | `j` (not consumed) |
|---|---|---|
| `chromeWin.capture` | fires | fires |
| `a3pWin.capture` | **blocked** ✅ | fires |
| `folderTree`'s own handler | **blocked** ✅ | fires |
| `a3pWin.sysgroup` | fires (not blocked) | fires |

→ Propagation in the default group is blocked completely, so **keys do not leak into Thunderbird behaviour such as folder-tree type-ahead**. The **system group is a separate dispatch group that `stopPropagation` does not reach**, so the chrome window gets **two** listeners (default-group capture and system-group capture) and consumes the key in both. XUL `<key>` handlers check `defaultPrevented`, so `preventDefault()` suppresses most of them as well.

**The final shape**:

```js
const opts = [{ capture: true }, { capture: true, mozSystemGroup: true }];
for (const o of opts) win.addEventListener("keydown", onKeyDown, o);
```

`KeyBridge` still exists as an interface (`attach`/`detach`), because if Thunderbird ever moves the 3-pane to a remote (Fission) browser, it has to be swappable for per-document attachment (strategy B). With `tb-fission` (Bugzilla #1646648) under way, that is not a theoretical flourish.

---

## 7. The hint session's lifetime

```
[f pressed]
  1. HintSession.start()
  2. iterate registry.documents()
       · inject with loadSubScript if the document has no agent yet
       · agent.collect() → candidate array (element references stay in the
         document; the parent only holds handles)
  3. order globally with core/ranking.js → generate labels with core/hint-labels.js
  4. agent.render(labelAssignments) per document
  5. on every keystroke, update the state with core/hint-matcher.js
       · several candidates → agent.filter(prefix)   (hide the ones that no longer match)
       · a unique match     → owner.agent.activate(handle) → end()
       · no match           → end()
  6. end(): every agent.clear(), listeners restored, back to normal mode
```

- **Element references never reach the parent.** The agent inside the document keeps a `Map<handleId, Element>` and the parent only handles `{docId, handleId, screenRect, tag}`, which avoids cross-compartment reference leaks and GC problems.
- A session always converges on `end()`, and is force-cleaned on document unload, window close and `onShutdown`.

---

## 8. File layout

```
Vimbird/
├── manifest.json                 # MV3, declares experiment_apis
├── package.json                  # test and build scripts only (no runtime dependencies)
├── README.md
├── docs/
│   ├── research.md               # Phase 1
│   ├── design.md                 # this document
│   ├── verification.md           # what was measured (Marionette)
│   └── testing.md                # how to run the tests + the manual checklist
├── scripts/
│   └── build.mjs                 # writes dist/vimbird-<version>.xpi (dependency-free zip writer)
├── src/
│   ├── background/background.js  # status logging only (no hint logic here)
│   ├── core/                     # pure logic (no TB, no DOM)
│   │   ├── hint-labels.js
│   │   ├── hint-matcher.js
│   │   ├── ranking.js
│   │   ├── placement.js
│   │   └── editable.js
│   ├── dom/                      # needs the DOM, but not Thunderbird
│   │   ├── visibility.js
│   │   ├── candidates.js
│   │   ├── overlay.js
│   │   └── activate.js
│   ├── tb/
│   │   └── targets.js            # ★ the one place for Thunderbird selectors and exceptions
│   └── agent/
│       └── agent.js              # the agent injected into a document (uses dom/ + tb/)
├── experiments/
│   └── vimbird/
│       ├── schema.json
│       └── implementation.js     # window attachment / document enumeration / keys / sessions
└── test/
    ├── *.test.js                 # unit tests (node --test)
    └── e2e/
        ├── marionette.py         # a dependency-free Marionette client
        └── run_e2e.py            # launches headless Thunderbird and checks the scenarios
```

**There is no bundling step.** Each module is a classic script attaching to the `var Vimbird = ...` namespace, so the Experiment loads them into the target document individually, in the order it needs:

```js
Services.scriptloader.loadSubScriptWithOptions(this.extension.rootURI.resolve(path), {
  target,            // the target window (for an agent) or a plain object (for the parent's core)
  allowUnsafeURL: true,
});
```

`allowUnsafeURL` is **required**: plain `loadSubScript` rejects extension resource URLs (`file://`, `jar:file://`) with "Trying to load untrusted URI". This is the same call the framework uses to load experiment scripts themselves (`ExtensionCommon.sys.mjs:1702`). Both a temporary install from a source directory and a packaged XPI were confirmed to work.

The same files are also loaded by Node's `require` for the unit tests, which is why each module ends with a `module.exports` guard.

---

## 9. Manifest decisions

```json
{
  "manifest_version": 3,
  "name": "Vimbird",
  "browser_specific_settings": {
    "gecko": { "id": "vimbird@gyuyoung", "strict_min_version": "128.0" }
  },
  "background": { "scripts": ["src/background/background.js"] },
  "permissions": ["storage"],
  "experiment_apis": {
    "vimbird": {
      "schema": "experiments/vimbird/schema.json",
      "parent": {
        "scopes": ["addon_parent"],
        "paths": [["vimbird"]],
        "script": "experiments/vimbird/implementation.js",
        "events": ["startup"]
      }
    }
  }
}
```

The reasoning:

- **MV3**: fully supported since TB 128 ESR and working completely on 155. The build confirms that the `experiment_apis` schema places no manifest_version restriction (research §4.1). If it ever causes trouble, reverting to MV2 costs a few manifest lines, since our code depends on no MV3-only API.
- **`events: ["startup"]`**: the Experiment loads when the extension starts and attaches the window listeners in `onStartup()`. That way **hint mode does not die when the MV3 event page is terminated for being idle** — hanging logic off the background page's lifetime is the most common MV3 trap.
- **Minimal permissions**: `storage` is the only standard permission the MVP needs. Everything else comes from the Experiment, at the price of the full-access warning at install time, which the README states plainly.
- **`strict_min_version: 128.0`**: the floor at which MV3, `currentAbout3Pane` and the unified toolbar structure all hold. The README says plainly that verification only happened on 155.

---

## 10. What is in the MVP, and what is not

**In**
- `f` hint mode (show → type → click → `Esc`/`Backspace`)
- Targets: unified toolbar buttons, tabs, the menu bar, folder rows, thread rows, message header buttons
- The 3-pane window and the compose window (the same code path, both checked)
- Multi-character hints with labels that never collide on a prefix
- Doing nothing while focus is in a text field

**Out (for later)**
- Hints for **HTML links in the message body** (a Phase 2 extension, through `scripting.messageDisplay`)
- `j/k`, `gg/G`, `o`, `r`, `a`, `x`, `d`, `/` (Phase 5)
- A preferences UI and keymap customisation (the defaults start as constants in the code)
- Hints for items inside native `menupopup`s
- Tracking hint positions while scrolling (the session ends instead)

---

## 11. Test strategy

### 11.1 Automated tests (`node --test`, no dependencies)

| Under test | What is checked |
|---|---|
| `hint-labels` | Count, uniqueness, **prefix-freedom**, length balance, shortest-first ordering, a custom alphabet, and the boundaries at 0/1/19/20/361/362 |
| `hint-matcher` | Single and multi-character matching, a shared prefix (test 15), Backspace, Esc, ending on no match |
| `ranking` | Stability of the screen-position sort, composing offsets across documents, ties |
| `editable` | Input elements, `contenteditable`, the XUL search bar (test 11) |
| `visibility` | Fake adapters for a zero rect, outside the viewport, `display:none`, XUL `hidden`/`collapsed`, occlusion, nested removal |

### 11.2 Automated end-to-end tests (a real Thunderbird)

Thunderbird's built-in **Marionette** is used to connect to the chrome process, send real key events and inspect the real DOM (`test/e2e/`). A throwaway profile is created and launched headless, keeping the user's own profile entirely out of it.

Thirteen scenarios cover: hints appearing across documents, label uniqueness and prefix-freedom, labels not overlapping, activating a toolbar button, `Esc` cancelling, switching folders by hint with a partial input that only narrows, message header hints, activating a thread row, protecting text input, compose window hints, dismissal on scroll and resize, and keys not leaking.

**Limits**: headless has no window manager, so OS focus cannot leave the 3-pane window. The two compose-window scenarios only exercise the code path, through a synthetic `keydown`, and need manual confirmation (`docs/testing.md`).

### 11.3 Manual tests (`docs/testing.md`)

The fifteen requested scenarios are laid out as a checklist, each marked with whether it is automated. What a person has to look at: the **visual position and legibility** of the hints, how fast it feels in a large folder, and situations where OS focus really moves.

### 11.4 Diagnostics

The Experiment exposes `messenger.vimbird.dumpCandidates()`, which returns per-document candidate counts and a tag breakdown without drawing any hints. When Thunderbird's UI changes and some button stops getting a hint, this shows what was missed before anyone edits the selectors in `src/tb/targets.js`. `getStatus()` shows which windows the extension is attached to.

---

## 12. Implementation order (Phase 3)

Spikes 0 to 3 were completed with **headless Thunderbird 155 and Marionette before any extension code was written** (`docs/verification.md`). Their results are folded into §5.5 and §6, so the implementation started from settled facts.

| Step | Content | Status |
|---|---|---|
| ~~Spike 0~~ | Key events across the document boundary, and consuming them | ✅ done → strategy A |
| ~~Spike 1~~ | Rendering an overlay in two documents | ✅ done |
| ~~Spike 2~~ | Reaching `currentAbout3Pane` and scanning candidates | ✅ done (60 visible candidates in chrome, 6 in about:3pane) |
| ~~Spike 3~~ | Comparing activation strategies | ✅ done → the trusted mouse sequence is first choice |
| ~~M1~~ | Hint mode end to end in a single (chrome) document | ✅ done |
| ~~M2~~ | Extending to several documents (3pane, message) with global labels | ✅ done — chrome/about:3pane/about:message/compose hinted together |
| ~~M3~~ | Edge cases (editing focus, ending on scroll/resize, the compose window) | ✅ done — 43 unit tests and 13 E2E scenarios passing |

Three things the measurements corrected during implementation:

1. `Services.scriptloader.loadSubScript` rejects extension resources → `loadSubScriptWithOptions(..., allowUnsafeURL: true)` (§8)
2. The session must not end before activation — ending it releases the agent's element references, so the order is `activate()` then `endSession()`
3. `el.click()` is silently ignored by the thread list, so activation is a trusted mouse sequence rather than a plain click (§5.5)

---

## 13. Risks and responses

| Risk | Impact | Response |
|---|---|---|
| ~~Key events do not cross the document boundary (C8)~~ | — | **Resolved** (§6, measured). The `KeyBridge` abstraction stays, in case of a move to Fission |
| ~~Synthetic clicks do not wake the widgets~~ | — | **Resolved** (§5.5, measured). A trusted MouseEvent sequence, with `el.click()` as the fallback |
| Widget kinds not yet exercised (menu items, less common custom elements) | Some targets do nothing | The activation strategy chain plus a console warning on failure |
| Thunderbird rearranges its UI again | Missed candidates | Selectors concentrated in `tb/targets.js`, plus the diagnostic dump |
| The Experiment suppression policy is switched on | Distributed builds blocked | Development uses temporary installs (exempt); the minimal surface leaves room to move to standard APIs later; point users at the ESR channel |
| The MV3 event page terminates and takes the feature with it | Hints stop responding | The logic lives in the Experiment's `onStartup`, not in the background page |
| The overlay interferes with accessibility or focus | Worse usability | `pointer-events: none`, `aria-hidden="true"`, no focus movement |
| snap sandbox restrictions | Install or debugging fails | Use the `~/snap/thunderbird/common/.thunderbird/` profile path, stated in the README |
