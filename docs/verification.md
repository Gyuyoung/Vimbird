# Measured verification log

Written: 2026-09-08
Build under test: **Thunderbird 155.0** (snap `latest/stable` rev 1240, BuildID `20260828084831`)

This document records which claims in [`research.md`](research.md) and [`design.md`](design.md) were confirmed **by running the thing rather than by reading about it**, and how. They are the grounds for the design decisions, so if behaviour looks wrong after a Thunderbird upgrade, re-run these first.

---

## 1. Method: Marionette

Thunderbird ships **Marionette**, the same automation interface as Firefox (`chrome://remote/content/marionette` inside the build). It can **run arbitrary JavaScript inside the chrome process**, so the real DOM and the real APIs can be inspected instead of guessed at.

```bash
xvfb-run -a thunderbird -profile <test profile> -no-remote \
         -marionette -remote-allow-system-access
# → listens on 127.0.0.1:2828
```

- Without `-remote-allow-system-access` the switch to the chrome context is refused (newly required in TB 155).
- The client is [`test/e2e/marionette.py`](../test/e2e/marionette.py), written from scratch with no external dependencies (length-prefixed JSON protocol).
- The snap package is sandboxed, so **the profile has to live inside `$HOME`**. The tests use `~/snap/thunderbird/common/vimbird-e2e-profile`.

`omni.ja`, the source archive inside the build, was unpacked and cross-checked as well:

```bash
unzip -qq /snap/thunderbird/current/usr/lib/thunderbird/omni.ja -d /tmp/tb
```

---

## 2. UI structure, as measured

| Checked | Result |
|---|---|
| Main window windowtype | `mail:3pane` (still valid) |
| Main window root element | `<html>`, not a XUL `<window>` |
| 3-pane document | `about:3pane`, loaded in a `<browser>` inside the tab |
| **`browser.isRemoteBrowser`** | **`false`** — synchronous access from the parent process |
| Folder tree | `<ul id="folderTree" is="tree-listbox">`, rows are `<li is="folder-tree-row">` |
| Thread list | `<tree-view id="threadTree">`, rows are `<tr is="tree-view-table-row">` / `<thread-card>` |
| Message display | `about:message`, also in-process chrome |
| Message header buttons | `.message-header-view-button` in the `about:message` document (XUL `toolbarbutton`) |
| Unified toolbar buttons | `<button is="unified-toolbar-button">`, **no shadow DOM** |
| `document.createElement("div")` | Returns the XHTML namespace in both documents |
| Compose window | A separate top-level window, `windowtype="msgcompose"` |

Selector scan (empty profile, 1600×1000): 60 visible candidates in the chrome document, 6 in `about:3pane`. Selecting a message adds 13 more from `about:message`.

---

## 3. Do key events cross the document boundary? (the biggest design question)

With focus on `#folderTree` inside `about:3pane` and a real `f` keystroke (`WebDriver:PerformActions`), listeners fired in this order:

```
1. chromeWin.capture      target=about:3pane <ul>   ← the outer chrome window goes first
2. a3pWin.capture         target=about:3pane <ul>
3. chromeDoc.bubble       target=about:3pane <ul>
4. chromeWin.sysgroup     target=about:3pane <ul>
5. a3pWin.sysgroup        target=about:3pane <ul>
```

**Conclusion**: a key event raised inside an in-process `<browser>` does reach a capture listener on the outer chrome window, and reaches it first. One listener per window is therefore enough (design §6, strategy A).

### 3.1 How much of the key is consumed

Calling `preventDefault() + stopPropagation()` from the chrome window's capture listener:

| Listener | `f` (consumed) | `j` (not consumed) |
|---|---|---|
| `chromeWin.capture` | fires | fires |
| `a3pWin.capture` | **blocked** | fires |
| `#folderTree`'s own handler | **blocked** | fires |
| `a3pWin.sysgroup` | fires (not blocked) | fires |

So the default group is blocked completely, but **the system group is a separate dispatch group that `stopPropagation` cannot reach.** Vimbird therefore attaches **two** listeners to the chrome window (default group and system group, both capturing) and caches the decision in a `WeakMap` so the same event is not handled twice.

---

## 4. Activation strategies compared

Success was judged by observable side effects: does the app menu panel open, does a compose window appear, does the folder selection change?

| Strategy | XUL `toolbarbutton` | HTML `button` | Folder row `li[is]` | **Thread row `tr[is]`** |
|---|---|---|---|---|
| `el.click()` | ✅ | ✅ | ✅ | **❌ nothing happens** |
| `createEvent("MouseEvent")` + `initMouseEvent` (mousedown→mouseup→click) | ✅ | ✅ | ✅ | **✅** |
| `createEvent("XULCommandEvent")` | ❌ | ❌ | — | — |
| `windowUtils.sendMouseEvent(...)` | **no such API** | — | — | — |

### 4.0 Why `el.click()` fails in the message list and nowhere else

A bug found in real use. The thread list's click handler opens like this (`tree-view.mjs:1387-1392`):

```js
// Bail out on non primary or double clicks.
if (event.button !== 0 || event.detail !== 1) {
  this.ensureCorrectFocus();
  return;
}
```

The click event produced by `HTMLElement.click()` carries **`detail: 0`**, so it trips this check and returns immediately — the row is not selected and the message pane does not change. The folder tree (`tree-listbox`) has no such check and worked fine with `click()`, which is why the problem stayed hidden at first.

**Conclusion**: activation is a **mousedown → mouseup → click sequence** carrying `button: 0` and `detail: 1`. That is the closest thing to a real click and works on all four widget kinds above. `el.click()` remains only as a fallback for when building the sequence throws.

**Lesson for the tests**: the original E2E scenario only asserted `selectedIndex >= 0` and therefore **passed falsely** — the selection was left over from the previous scenario. It now starts from a different row and checks both that the selected index moved to the target row and that `gMessage.subject` in `about:message` matches that row's subject.

### 4.1 An important correction: `sendMouseEvent` is gone

Querying what event-synthesis API `nsIDOMWindowUtils` actually still has:

```
sendMouseEvent                          undefined
sendMouseEventToWindow                  undefined
sendKeyEvent                            undefined
sendNativeMouseEvent                    function
sendNativeKeyEvent                      function
dispatchDOMEventViaPresShellForTesting  function
```

The `windowUtils.sendMouseEvent(...)` click synthesis that older add-ons and blog posts use **simply fails on TB 155**. The design document was written around that call and had to be corrected against the build.

It was also confirmed that `elementFromPoint()` at an element's centre still returns that element while the hint overlay is up, thanks to `pointer-events: none`.

---

## 5. Extension loading, as measured

| Item | Result |
|---|---|
| `extensions.experiments.enabled` | `true` (default) |
| `extensions.experiments.suppressed` | `false` (the suppression switch exists but is off) |
| `extensions.experiments.allowed` | `tbpro-add-on@thunderbird.net,owl@beonex.com` |
| Temporary installs when suppressed | The `!addon.temporarilyInstalled` condition keeps the development workflow working |
| `experiment_apis` manifest constraints | None — MV2 and MV3 both work |
| `events: ["startup"]` | `SchemaAPIManager.onStartup()` calls `api.onStartup()`, independent of the background page's lifetime |
| **Script loading** | `Services.scriptloader.loadSubScript` **refuses** extension resource URLs ("Trying to load untrusted URI"). `loadSubScriptWithOptions(url, { target, allowUnsafeURL: true })` is the answer — it is how the framework itself loads experiment scripts (`ExtensionCommon.sys.mjs:1702`) |
| Install paths | Confirmed working from **both** a source directory (`file://`) and a packaged XPI (`jar:file://`) |

---

## 6. How many hints does a real window produce?

This decides how long the labels have to be, so it was measured rather than assumed. A 1952×1092 window with 12 folders and a 60-message folder open, with one message displayed:

```
total 80 hints — messenger.xhtml:13, about:3pane:52, about:message:15
```

Eighty is just under the 81 labels that a nine-character alphabet can express in two keystrokes, so a slightly larger window spilled into three-character labels. The alphabet is now the home row plus the row above it (19 characters, 361 two-character labels), and the same window measures 15 single-character labels plus 65 two-character ones.

---

## 7. E2E results (13/13)

[`test/e2e/run_e2e.py`](../test/e2e/run_e2e.py) run against a real Thunderbird 155. The source-directory install and the packaged-XPI install pass identically.

```
PASS  hints appear in toolbar and 3-pane — 20 hints across ['about:3pane', 'messenger.xhtml']
PASS  labels unique and prefix-free — 20 labels, 5 multi-character, all prefix-free
PASS  hint labels do not overlap — 70 labels on '[recipients] crowded header': 9 would overlap on raw anchors, 0 do after spreading
PASS  hint activates a toolbar button — hint 'w' opened the compose window
PASS  Escape cancels hint mode — 70 hints dismissed
PASS  folder hint switches folders, partial input narrows — hint 'su' switched folders, 'a' narrowed 54 longer labels
PASS  message header is hinted — 47 hints, message header button hinted as 'as'
PASS  thread row hint selects a message — row hint 'ay' opened '[1] Vimbird test message' in the message pane
PASS  text input keeps its keystrokes — f left untouched for the subject field
PASS  compose window is hinted — 25 hints in the compose window
PASS  scroll dismisses hints — 47 hints dismissed on scroll
PASS  resize dismisses hints — 47 hints dismissed on resize (synthetic)
PASS  f does not leak into Thunderbird — f consumed before Thunderbird's own handlers
```

### 7.1 Limits of the headless environment

xvfb has no window manager, which imposes two limits.

1. **OS focus cannot leave the 3-pane window.** Even assigning `Services.focus.activeWindow = composeWindow` is ignored. The two scenarios that target the compose window (compose hints, protecting text input) therefore **dispatch a synthetic `keydown` directly at that window** instead of pressing a real key. The listener, the guard and the rendering path all run as usual, but OS-level key delivery is not covered.
2. **`window.resizeTo()` may be ignored.** When the headless window is larger than the virtual screen (observed: a 1332×1460 window on a 1600×1000 screen) the size does not change. The resize scenario tries a real resize first, falls back to a synthetic `resize` event, and says in its result line which one it used.

The two compose-window items and the resize therefore need one more pass through the manual checklist in [`testing.md`](testing.md).

---

## 8. Reproducing all of this

```bash
npm test                     # pure-logic unit tests (no Thunderbird needed)
npm run build                # writes dist/vimbird-<version>.xpi
npm run test:e2e             # launches headless Thunderbird and runs the 13 scenarios
python3 test/e2e/run_e2e.py --xpi          # the same run against the packaged XPI
python3 test/e2e/run_e2e.py --keep         # leaves Thunderbird up for inspection
```

An instance left running by `--keep` keeps Marionette open, so `test/e2e/marionette.py` can be imported directly to run chrome JavaScript and test a new hypothesis on the spot.
