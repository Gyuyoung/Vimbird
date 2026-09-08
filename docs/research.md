# Phase 1 — Research into Thunderbird extension development (Vimbird)

Written: 2026-09-08
Subject: a Thunderbird extension providing Vimium-style hint mode (Vimbird)

---

## 0. Method and reliability markers

The facts in this document come from three kinds of source, and every item says which.

| Marker | Meaning |
|---|---|
| **[build-verified]** | Read directly out of `omni.ja` in the Thunderbird 155.0 build installed on this machine (the most reliable) |
| **[official docs]** | developer.thunderbird.net / webextension-api.thunderbird.net / MDN and the like |
| **[unverified]** | Supported only by documentation or community reports, with no observed behaviour → needs a spike before implementation |

Environment:

- Install path: `/snap/thunderbird/current/usr/lib/thunderbird/` (snap, `latest/stable`, rev 1240)
- `application.ini`: `Version=155.0`, `BuildID=20260828084831`, `SourceStamp=d7ad5b5220b8af757553f3cc02971f7ba76e3a45` **[build-verified]**
- Profile: `~/snap/thunderbird/common/.thunderbird/` — the snap sandbox path, **not** the usual `~/.thunderbird` **[build-verified]**
- Method: `unzip omni.ja`, then grep through `chrome/messenger/content/messenger/**`, `modules/**` and `defaults/pref/**`

Documentation from the XUL era (pre-2015 Muttator, XUL overlays and so on) was not used as evidence. Thunderbird rewrote its interface substantially in 115 "Supernova", and the XUL `<tree>` widget is already gone.

---

## 1. Current Thunderbird version and release channel

- The installed build is **Thunderbird 155.0, on the Monthly Release channel**. **[build-verified]**
- Since September 2026 Thunderbird has followed the same **fortnightly release cadence** as Firefox. The ESR line continues separately at 153.x. **[official docs]**
- Why the distinction matters: the **Experiment API suppression policy described below was aimed at the Monthly Release channel and does not apply to ESR**. Our development environment (155 Monthly) is therefore on the front line of that policy change.

---

## 2. How extensions are written today — MailExtensions

Thunderbird's current, and only, extension format is the **MailExtension**: the WebExtension standard plus Thunderbird-specific APIs (the `messenger.*` namespace, with `browser.*` as an alias). **[official docs]**

- Legacy XUL overlay extensions (Muttator, the old Vimperator family) are **completely impossible**. They are worth reading, not porting.
- **Both manifest_version 2 and 3 are supported.** MV3 has been fully supported since TB 128 ESR, and unlike Chrome, Mozilla and Thunderbird have announced no date for retiring MV2. **[official docs]**
- Even under MV3, the background is not a Chrome-style service worker but a **Limited Event Page**: a background page with a DOM that is terminated when idle and restarted by events. The DOM and `window` are available there. **[official docs]**
- Main MV3 changes: `browser_action` → `action`, `_execute_browser_action` → `_execute_action`. **[official docs]**

### Development and debugging environment (prefs read from the installed build) **[build-verified]**

| pref | Value | Meaning |
|---|---|---|
| `devtools.chrome.enabled` | `true` (`all-thunderbird.js:362`) | **The Browser Toolbox can inspect the chrome DOM directly** — essential for working out what to hint |
| `devtools.debugger.remote-enabled` | `true` (`all-thunderbird.js:363`) | Remote debugging is available |
| `xpinstall.signatures.required` | `false` (`greprefs.js:1165`) | This build installs unsigned XPIs, though signing through ATN is still the recommendation for distribution |
| `extensions.autoDisableScopes` | `15` (`all-thunderbird.js:58`) | Externally installed extensions start disabled → development uses the temporary install in `about:debugging` |

The standard development loop is **`about:debugging` → "This Thunderbird" → "Load Temporary Add-on"**, pointed at `manifest.json`. That path is also an **exception** to the Experiment suppression policy described below, which makes it doubly convenient.

---

## 3. What the standard WebExtension APIs can do

The Thunderbird-specific parent APIs present in the installed build **[build-verified]** (`chrome/messenger/content/messenger/parent/`):

```
ext-accounts, ext-addressBook, ext-browserAction, ext-chrome-settings-overrides,
ext-cloudFile, ext-commands, ext-composeAction, ext-compose, ext-extensionScripts,
ext-folders, ext-identities, ext-mail, ext-mailTabs, ext-menus,
ext-messageDisplayAction, ext-messageDisplay, ext-messages, ext-messengerSettings,
ext-messengerUtilities, ext-oauth_provider, ext-pkcs11, ext-scripting-tb,
ext-sessions, ext-spaces, ext-spacesToolbar, ext-tabs, ext-theme, ext-windows
```

The key conclusion: **every one of these works at the data or model level.** They expose folder objects, message headers, tab metadata and layout settings, but **not one of them returns a live DOM node for a toolbar button, a folder row or a thread row.** "Find every visible clickable element and put a hint on it" is therefore impossible in principle with the standard APIs alone.

The standard APIs that are of some use to Vimbird:

| API | Use | Limit |
|---|---|---|
| `tabs`, `windows` | Identify the active window or tab kind (3pane / message / compose) | No DOM access |
| `mailTabs` | Read and set the displayed folder and selected message | Could implement part of Phase 5's `j/k` through the API |
| `messageDisplay` | The currently displayed message | Not the header button DOM |
| `commands` | Register shortcuts | **The fatal limit below** |
| `scripting.messageDisplay` (MV3) / `messageDisplayScripts` (MV2) | Inject scripts into the message **body** document | Body only. Cannot reach the chrome UI, and an already-open message needs an explicit `executeScript` |

### 3.1 The `commands` API cannot register a bare `f` (decisive)

The validation logic in the installed build **[build-verified]** (`modules/ShortcutUtils.sys.mjs:271-333`):

```js
const BASIC_KEYS = /^([A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right)$/;
const FUNCTION_KEYS_BASIC = /^(F[1-9]|F1[0-2])$/;
...
switch (modifiers.length) {
  case 0:
    // A lack of modifiers is only allowed with function keys.
    if (!FUNCTION_KEYS.test(key)) {
      return this.MODIFIER_REQUIRED;   // ← "F" is rejected here
    }
```

The example table in the comments is explicit as well: `"Shift+F"` → `MODIFIER_REQUIRED`.

So **Vim-style bindings without a modifier — `f`, `j`, `k`, `g`, `/` — can never be registered through the `commands` API.** (The request for this, Bugzilla #1591730, has been open since 2019.) This is the **first decisive reason** Vimbird has no choice but to use an Experiment API.

### 3.2 Content scripts cannot reach the chrome UI

`about:3pane`, `about:message` and `messenger.xhtml` are **privileged chrome documents**. `content_scripts.matches` in `manifest.json` cannot target them; the official documentation says so in as many words. A content script gets a reduced API surface — roughly `runtime`, `i18n`, `menus` and `storage` — and has to relay everything else through the background. **[official docs]**

→ **The second decisive reason**: reaching the chrome DOM requires an Experiment API.

---

## 4. WebExtension Experiment APIs

### 4.1 Structure **[official docs]**

`manifest.json`:

```json
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
```

- `implementation.js` defines a class extending `ExtensionCommon.ExtensionAPI` and returns the API object from `getAPI(context)`.
- The script runs in the **privileged parent-process context** with access to `Services`, `ChromeUtils` and all of XPCOM. `Services.wm.getMostRecentWindow("mail:3pane")` hands back the main window's DOM to work with directly.
- There is a loading constraint: top-level declarations must use `var` rather than `let`/`const`, because the script may be loaded repeatedly into the same scope.
- **Unlike Firefox, Thunderbird allows Experiments on the release channel.** (Firefox restricts them to Nightly and unbranded builds.)
- Permission model: not fine-grained permissions but a single install-time warning about "full access to Thunderbird and your computer".
- The schema puts **no `min/max_manifest_version` limit** on `experiment_apis`, so they work under both MV2 and MV3. **[build-verified]** (`chrome/toolkit/content/extensions/schemas/experiments.json:17-22` sets only `"privileged": true`)

### 4.2 The Experiment suppression mechanism already present in TB 155 (important) **[build-verified]**

Prefs in the installed build (`defaults/pref/all-thunderbird.js:63-66`):

```js
pref("extensions.experiments.enabled", true);
pref("extensions.experiments.suppressed", false);
pref("extensions.experiments.allowed", "tbpro-add-on@thunderbird.net,owl@beonex.com");
```

The decision logic in `modules/ExtensionUtilities.sys.mjs:126-131`:

```js
const isExperiment = !!data.manifest.experiment_apis;
const isSuppressedExperiment =
  isExperiment &&
  lazy.EXPERIMENTS_SUPPRESSED &&
  !lazy.EXPERIMENTS_ALLOWED.includes(addon.id) &&
  !addon.temporarilyInstalled;
```

When an add-on is judged suppressed, `updateBlocklistForSuppressedExperiments()` **blocks it by putting `id:version` into a local blocklist stash**, and `MailGlue.sys.mjs:1006-1012` observes the pref at runtime so a change takes effect immediately.

What this code tells us:

1. **With the TB 155 default of `suppressed=false`, Experiment add-ons work normally.** The switch exists but is off.
2. Thunderbird announced a policy of phasing Experiment support out on the Monthly Release channel, then **postponed it by a year** after community pushback (June 2026 development digest). ESR is not affected. **[official docs]**
3. **Thanks to the `!addon.temporarilyInstalled` condition, an add-on installed temporarily through `about:debugging` is exempt even when suppression is on.** The development and test workflow therefore survives the policy change. **[build-verified]**

**What this means for Vimbird**: Experiment APIs are usable now and remain safe for development, but carry policy risk for distribution. The design must therefore **keep the Experiment surface minimal** — a single thin bridge — and keep the hint engine itself as pure logic that knows nothing about Experiments, so that a policy change means replacing the bridge and nothing else.

---

## 5. Thunderbird's UI and document structure (measured on TB 155)

### 5.1 The main window — `messenger.xhtml` **[build-verified]**

`chrome/messenger/content/messenger/messenger.xhtml:48-55`:

```xml
<html id="messengerWindow" xmlns="http://www.w3.org/1999/xhtml"
      ...
      windowtype="mail:3pane"
```

- **`windowtype="mail:3pane"` is still valid.** `Services.wm.getMostRecentWindow("mail:3pane")` remains the correct way in.
- The root element, however, is now **`<html>`**, not `<window>`. XUL elements (`<toolbar>`, `<hbox>`, `<vbox>`, `<menupopup>`) are mixed into the XHTML document under the XUL namespace. Think of it as **an XHTML document containing XUL elements, not a XUL document**.
- Structure at the top: `navigation-toolbox` → `titlebar` (containing `<html:unified-toolbar>`) → `toolbar-menubar` → `tabs-toolbar`; the body is `messengerBody` → `tabmail-container` → `<tabmail>`.

### 5.2 The unified toolbar **[build-verified]**

- Location: `chrome/messenger/content/messenger/unifiedtoolbar/` (`unified-toolbar.mjs`, `unified-toolbar-button.mjs`, `extension-action-button.mjs` and so on)
- `unified-toolbar-button.mjs:269`:
  ```js
  customElements.define("unified-toolbar-button", UnifiedToolbarButton, { extends: "button" });
  ```
  The real DOM is therefore **`<button is="unified-toolbar-button">`**, and it **does not use shadow DOM**.
- The common claim that this is built on Lit is wrong. It is vanilla web components cloning a `<template>`.
- **Good news for Vimbird**: because toolbar buttons are ordinary `<button>` elements, `querySelectorAll` and `getBoundingClientRect()` work as they are. No shadow-DOM piercing is needed.
- Some areas, though — the message header toolbar among them — still use XUL `toolbarbutton` (`aboutMessage.xhtml:819`, `class="toolbarbutton-1 message-header-view-button"`). **The candidate finder has to recognise both HTML `<button>` and XUL `toolbarbutton`.**

### 5.3 The 3-pane itself — `about:3pane` **[build-verified]**

Not part of the main window but **a separate document loaded into a `<browser>` inside the tab**. `messenger.xhtml:6600-6607`:

```xml
<html:template id="mail3PaneTabTemplate">
  <stack flex="1">
    <browser flex="1" src="about:3pane" autocompletepopup="PopupAutoComplete"
             messagemanagergroup="single-page"/>
  </stack>
</html:template>
```

The significant nodes in `about3Pane.xhtml`:

| Area | DOM | Evidence |
|---|---|---|
| Folder pane | `<div id="folderPane">` → `<ul id="folderTree" is="tree-listbox">` | `about3Pane.xhtml:64,85-86` |
| Folder row | `<li is="folder-tree-row" id="[mode]-[uri]" data-server-key=... >` (children `.name`, `.icon`, `.unread-count`) | `folder-tree-row.mjs` |
| Thread pane | `<div id="threadPane">` → `<tree-view id="threadTree">` | `about3Pane.xhtml:124,294` |
| Thread row | `<tr is="tree-view-table-row">` (table view) or `<thread-card>` (card view) | `about3Pane.xhtml:435-469`, `tree-view.mjs` |
| Message pane | `<message-pane id="messagePane">` | `about3Pane.xhtml:519` |

- **There is no XUL `<tree>`.** TB 115's "deforestation" (Bugzilla #1724841) replaced them all with HTML lists and tables, which makes finding hint targets ordinary DOM work.
- **Note that the thread list is virtualised.** `tree-view.mjs` only creates DOM rows near the viewport (`#firstBufferRowIndex`/`#lastBufferRowIndex` plus spacers). Messages off screen cannot be hint targets, and scrolling requires a rescan. That happens to match Vimium's philosophy of hinting only what is visible.

### 5.4 Message display — `about:message` **[build-verified]**

- `message-pane.mjs` keeps three sibling `<browser>` elements — `#webBrowser` (web content), `#messageBrowser` (`about:message`) and `#multiMessageBrowser` (multi-selection summary) — and shows one of them.
- Inside `about:message` there is another **`<browser id="messagepane" type="content">`**, which renders the actual message body (`aboutMessage.xhtml:1824-1829`).
- The message header buttons (Reply, Forward, Archive and so on) live in the `about:message` document: `<html:header id="messageHeader">` → `<div id="header-view-toolbox" role="toolbar">` → `<hbox id="header-view-toolbar">` holding `toolbarbutton-1 message-header-view-button` (`aboutMessage.xhtml:806-827`).
- So the **message header buttons in the MVP scope sit in `about:message` and must be reached separately from the 3-pane document.**

### 5.5 Document boundaries and the process model (the most important part for the design) **[build-verified]**

```
messenger.xhtml  (chrome, mail:3pane)        ← window, tab bar, unified toolbar, menu bar
 └ <browser src="about:3pane">               ← no remote attribute = in-process parent chrome
    ├ #folderTree, #threadTree               ← MVP targets
    └ <message-pane>
       └ <browser id="messageBrowser" src="about:message">   ← in-process chrome
          └ <browser id="messagepane" type="content">        ← message body (Phase 2 target)
```

- The `<browser>` elements in `mail3PaneTabTemplate`/`mailMessageTabTemplate` carry **no `remote="true"`**. On top of that, `message-pane.mjs` calls `this.messageBrowser.contentDocument` and `.contentWindow.displayMessage(...)` **synchronously** (`message-pane.mjs:159-163, 330, 503`). So `about:3pane` and `about:message` are **synchronously reachable from the parent process**.
- **This is the best news in the whole design.** Experiment code can get there without frame scripts, JSWindowActors or IPC:
  ```js
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;   // tabmail.js:1441
  const aboutMessage = win.document.getElementById("tabmail").currentAboutMessage; // tabmail.js:1454
  ```
  `currentAbout3Pane` and `currentAboutMessage` are **accessors Thunderbird provides officially on tabmail**. **[build-verified]**
- Only the message body `#messagepane` is `type="content"` (and may be remote); Phase 2 handles it separately. The proper route to the body is the standard `scripting.messageDisplay` API.
- **The multiplicity of documents remains, though.** Each `<browser>` has its own `document`/`window`, so hint overlays and key listeners have to be handled per document.

### 5.6 The compose window **[build-verified]**

- `mail/components/compose/content/messengercompose.xhtml`, root `<html id="msgcomposeWindow" ... windowtype="msgcompose">` — **an independent top-level chrome window**, not a `mail:3pane`.
- The body editor is a separate `<browser>` reached through `getBrowser().contentDocument`.
- Vimbird therefore needs a structure that attaches the same engine per window type (`mail:3pane`, `msgcompose`, `mail:messageWindow`).
- The standard way to attach to windows is Thunderbird's own `ExtensionSupport.registerWindowListener({ chromeURLs, onLoadWindow, onUnloadWindow })` (`modules/ExtensionSupport.sys.mjs:34`). **[build-verified]** It covers both windows opened later and windows already open.

---

## 6. Intercepting keyboard events

### 6.1 The options and how they rate

| Approach | Assessment |
|---|---|
| `commands` API | **Impossible.** As in §3.1, a bare `f` cannot be registered |
| Injecting XUL `<keyset>`/`<key>` | Possible, but a poor fit for single characters and a modal state machine (`gg`, accumulating hint characters) |
| `addEventListener("keydown", h, true)` on the window/document from an Experiment | **Chosen.** The same thing Thunderbird itself does |
| A global `nsIObserver`/XPCOM key hook | Needlessly invasive |

Thunderbird's own code uses the same pattern: `InitMsgWindow()` in `mailWindow.js` attaches
`document.addEventListener("keypress", handler, { mozSystemGroup: true })` to the chrome document to handle F7 (caret browsing) and friends.

### 6.2 What had to be settled by a spike **[unverified at the time]**

Even though `about:3pane` is in-process, **whether a keydown raised in the inner document reaches a listener on the outer `messenger.xhtml` window** depends on how Gecko's chrome event handler behaves and cannot be settled from documentation. Two hypotheses:

- (A) It does — propagation reaches the parent chrome window through the chrome event handler path, `mozSystemGroup` included. One listener per window would then be enough.
- (B) It does not — it stops at the document boundary the way a web iframe does, in which case **each document needs its own listener**.

→ **Spike 0 attached logging listeners in both places, focused the thread tree and pressed a key.** The design assumed (B) as the safe default and simplified if (A) turned out to hold. (A) does hold; see §10 and [`verification.md`](verification.md) §3.

### 6.3 Ignoring keys during text input

Thunderbird's own handlers do not check whether `event.target` is an input element; they rely on the order of default actions. Vimbird **has to implement that guard itself**: hint mode must not start when focus is in an `input`/`textarea`/`[contenteditable]`/`select`, an element with `role="textbox"`, the search bar (`global-search-bar`), or the compose window's body editor. This is manual test scenario 11.

---

## 7. Prior work

### 7.1 Vim-flavoured extensions for Thunderbird

| Project | What it is | Relation to Vimbird |
|---|---|---|
| **tbkeys / tbkeys-lite** (github.com/wshanks/tbkeys) | The most important precedent. Uses an Experiment API to inject the **Mousetrap** library into the main window, giving arbitrary single-key and sequence bindings, with GMail-style defaults | **The reference for the key-capture architecture** and proof that the `commands` limitation can be worked around with an Experiment. No hint mode, though |
| **tbhints** (github.com/wshanks/tbhints) | Puts hints on the **links inside an open message body** and opens them in an external browser (Ctrl+Shift+E) | The closest in name, but scoped to body links, unlike our MVP's whole chrome UI |
| **ThunderVim** (ATN) | Vim text-editing keys inside the compose window | Text editing only; no navigation or hints |
| **thunderbird-vim** (github.com/LQR471814) | A JSON keymap profile for tbkeys | Useful as a keymap reference |
| **Muttator** (vimperator-labs) | A modal Vim client for Thunderbird, historically | **Died with XUL overlays.** Not portable; only the feature ideas are of use |

**Conclusion: no extension currently puts Vimium-style hints on Thunderbird's whole chrome UI.** Vimbird fills that gap, and is roughly a superset of tbkeys (key capture) and tbhints (hint UI, body only).

### 7.2 Real uses of Experiment APIs (code references)

- **thunderbird/webext-experiments**, **thunderbird/webext-support**, **thunderbird/webext-examples** — official and semi-official example and utility repositories maintained by the Thunderbird add-ons team. The primary reference for Experiment scaffolding.
- **DKIM Verifier** (github.com/lieser/dkim_verifier) — a clean plumbing example declaring four `experiment_apis`.
- **Provider for Google Calendar** (github.com/kewisch/gdata-provider) — a large Experiment with a test setup (Jest plus a WebExtension mock).
- **Quick Folder Move** — older versions were Experiment-based, the current one moved to standard APIs. Worth reading as a migration case.

### 7.3 Vimium's hint mode architecture (algorithm reference)

github.com/philc/vimium — `content_scripts/link_hints.js`:

1. **Finding candidates**: natively clickable tags (`a, button, select, textarea, input, object, embed, details`), `onclick`/`jsaction`/`ng-click` attributes, ARIA roles (button/link/tab/checkbox), `contenteditable`, `tabindex`, and class-name heuristics (`btn`, `button`).
2. **Visibility**: `getVisibleClientRect()` plus `elementFromPoint()` at the element's centre and corners to test for occlusion.
3. **Generating hint strings**: `hintStrings()` over `linkHintCharacters` (the home row by default). Characters are prepended to grow the set of combinations, and sorting and reversal **give the short hints to prominent elements** while spreading shared prefixes across the screen.
4. **The overlay**: markers are absolutely positioned `<div>`s in a separate container rather than inside the target (some elements cannot take children), with the typed and remaining characters split into `<span>`s for two-colour display.
5. **Matching and activation**: keystrokes accumulate in a queue, filter the candidates by prefix, and activate when one remains. `Space` cycles overlapping hints, `Esc` cancels.

**Vimbird adopts this pipeline as it is** and replaces only the candidate finder to suit Thunderbird's DOM (§5: `button[is=unified-toolbar-button]`, XUL `toolbarbutton`, `li[is=folder-tree-row]`, `tr[is=tree-view-table-row]`, `thread-card`, tabs and so on).

### 7.4 Other prior art

- **Tridactyl** (Firefox), **Surfingkeys** (cross-browser), **Vimium C** (a Vimium fork) — for comparing hint algorithms.
- **LinkHints** (lydell.github.io/LinkHints) — hints and nothing else, in TypeScript. **The closest match to Vimbird's "hints only" design.**

---

## 8. Language choice: JavaScript with JSDoc types

**Decision: plain JavaScript (ESM `.mjs` plus `.js`) with JSDoc type annotations. No TypeScript compilation pipeline.**

Reasons:

1. **The Experiment `implementation.js` is loaded into a privileged context under unusual rules** — top-level `var`, `ChromeUtils.importESModule`, extending `ExtensionCommon.ExtensionAPI`. Bundler or transpiler output collides easily with that loading scheme, and it makes the code seen in the Browser Toolbox differ from the source.
2. The Thunderbird codebase itself is **plain ESM (`.sys.mjs`) annotated with JSDoc**. Matching it helps both maintenance and cross-referencing.
3. The source directory can be loaded into `about:debugging` with no build step, which gives **the shortest possible development loop** — edit, reload.
4. Where type safety matters (the hint engine's pure logic), `// @ts-check` plus JSDoc and a `tsc --noEmit` check in CI recovers most of TypeScript's benefit.
5. The hint engine under unit test is separated into DOM-free pure functions, so Node and its built-in test runner suffice.

---

## 9. Architectural conclusions (input to Phase 2)

The constraints this research settled:

1. Registering a bare `f` is **impossible** with the standard APIs → **an Experiment API is required** (verified in `ShortcutUtils.validate`)
2. Reaching the chrome UI DOM is **impossible** with the standard APIs → **an Experiment API is required**
3. Experiments **work** on TB 155, but a suppression switch exists in the code → **minimise the surface and keep the temporary-install development workflow**
4. `about:3pane` and `about:message` are **synchronously reachable from the parent process** → no IPC or frame scripts; use `tabmail.currentAbout3Pane` / `currentAboutMessage`
5. The target UI is **standard HTML DOM** throughout (with some XUL elements mixed in) and uses no shadow DOM → `querySelectorAll` and `getBoundingClientRect` apply
6. The thread list is **virtualised** → hint only the rendered rows, and recompute on scroll
7. There are several documents (window, 3pane, message, compose) → the structure needs **a per-document engine with a per-window coordinator**
8. Whether key events cross document boundaries → **settled**: a key in an inner document reaches the outer chrome window's capture listener first (see §10)

---

## 10. Facts measured during implementation

Confirmed by driving a real Thunderbird 155 through Marionette. The full record is in [`verification.md`](verification.md).

| Item | Result | Difference from what the research predicted |
|---|---|---|
| Is the `about:3pane` browser remote? | `isRemoteBrowser === false` | As expected. Confirms that no IPC or frame script is needed |
| Do key events cross the document boundary? | The outer chrome window's capture listener receives them **first** | The design assumed per-document attachment to be safe, but **one listener per window is enough** |
| What `stopPropagation` covers | The default group is fully blocked; **the system group is not** | A new finding → two listeners on the chrome window |
| `windowUtils.sendMouseEvent` | **Does not exist** (only `sendNativeMouseEvent` remains) | The draft design's activation strategy was invalid as a whole |
| `el.click()` | Works on XUL `toolbarbutton`, HTML `button` and folder rows, but **silently fails on thread rows** | Found through a user report: `tree-view.mjs` rejects clicks with `detail !== 1`. Activation is now a trusted mousedown → mouseup → click sequence (`verification.md` §4.0) |
| `createEvent("XULCommandEvent")` | Does not work | Sending only a `command` event to XUL widgets fails |
| `Services.scriptloader.loadSubScript` | Refuses extension resource URLs ("untrusted URI") | `loadSubScriptWithOptions(..., allowUnsafeURL: true)` is needed — the call the framework itself uses |
| Installing an unsigned extension | Works as a temporary install from **both** a source directory and an XPI | Settles the development workflow |
| The snap sandbox | The profile has to live inside `$HOME` | Test profiles go under `~/snap/thunderbird/common/` |
| Hints in a full window | 80 on a 1952×1092 window with 12 folders and 60 messages | Nine home-row characters cover only 81 labels in two keystrokes, so the alphabet was widened to 19 characters |

Open questions that remain:

- Whether `scripting.messageDisplay` injects into the `about:message` chrome shell (header, attachments) or only into the body browser **[unverified]** — to be settled in Phase 2 (hints for body links)
- OS window focus cannot be moved in a headless environment, so compose-window scenarios need manual confirmation **[partly verified]**

---

## 11. Sources

**Read from the installed build (TB 155.0, BuildID 20260828084831)**
- `chrome/messenger/content/messenger/messenger.xhtml` (48-55, 285, 6600-6612)
- `chrome/messenger/content/messenger/about3Pane.xhtml` (52-58, 64, 85-86, 124, 294, 435-469, 519)
- `chrome/messenger/content/messenger/aboutMessage.xhtml` (788-827, 1824-1829)
- `chrome/messenger/content/messenger/message-pane.mjs`, `tree-view.mjs`, `folder-tree-row.mjs`, `tree-listbox.mjs`
- `chrome/messenger/content/messenger/unifiedtoolbar/unified-toolbar-button.mjs` (269)
- `chrome/messenger/content/messenger/tabmail.js` (1441 `currentAbout3Pane`, 1454 `currentAboutMessage`)
- `chrome/messenger/content/messenger/parent/ext-*.js` (the list of available APIs)
- `chrome/toolkit/content/extensions/schemas/experiments.json` (17-22)
- `modules/ShortcutUtils.sys.mjs` (260-333, `validate`)
- `modules/ExtensionUtilities.sys.mjs` (17-34, 105-146, `updateBlocklistForSuppressedExperiments`)
- `modules/ExtensionSupport.sys.mjs` (13-95, `registerWindowListener`)
- `modules/MailGlue.sys.mjs` (988-1013)
- `defaults/pref/all-thunderbird.js` (58, 63-66, 362-363), `greprefs.js` (1165, 1168)

**Official documentation**
- https://developer.thunderbird.net/add-ons/mailextensions
- https://developer.thunderbird.net/add-ons/mailextensions/experiments
- https://developer.thunderbird.net/add-ons/mailextensions/supported-webextension-api
- https://developer.thunderbird.net/add-ons/whats-new/manifest-v3
- https://webextension-api.thunderbird.net/en/mv3/guides/experiments.html
- https://webextension-api.thunderbird.net/en/mv3/guides/manifestV3.html
- https://webextension-api.thunderbird.net/en/mv3/messageDisplayScripts.html
- https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end
- https://source-docs.thunderbird.net/en/latest/frontend/mail_display.html
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands
- https://searchfox.org/comm-central/source/ (comm-central source search)

**Policy and bugs**
- https://bugzilla.mozilla.org/show_bug.cgi?id=1591730 (the shortcut API request, still open)
- https://bugzilla.mozilla.org/show_bug.cgi?id=1724841 (removal of XUL trees, "deforestation")
- https://bugzilla.mozilla.org/show_bug.cgi?id=1646648 (tb-fission)
- https://blog.thunderbird.net/2026/06/thunderbird-monthly-development-digest-june-2026/ (Experiment suppression postponed by a year)
- https://blog.thunderbird.net/2023/02/thunderbird-115-supernova-preview-the-new-folder-pane/

**Prior projects**
- https://github.com/wshanks/tbkeys · https://github.com/wshanks/tbhints
- https://github.com/thunderbird/webext-experiments · https://github.com/thunderbird/webext-support · https://github.com/thunderbird/webext-examples
- https://github.com/lieser/dkim_verifier · https://github.com/kewisch/gdata-provider · https://github.com/kewisch/quickmove-extension
- https://github.com/philc/vimium (`content_scripts/link_hints.js`) · https://lydell.github.io/LinkHints/ · https://github.com/tridactyl/tridactyl
