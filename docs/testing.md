# Testing guide

Vimbird's tests come in three layers.

| Layer | Covers | Needs Thunderbird | How to run |
|---|---|---|---|
| Unit | The pure logic in `src/core` and `src/dom` | ✗ | `npm test` |
| End-to-end (automated) | The real chrome DOM and real key events | ✓ (launched headless for you) | `npm run test:e2e` |
| Manual | What needs human eyes or OS window focus | ✓ | The checklist below |

---

## 1. Unit tests

```bash
npm test
```

No dependencies and no Thunderbird. Logic that needs the DOM (`visibility.js`) takes a `{ rect, style, viewport, elementFromPoint }` adapter, so it is exercised against fakes.

What they check: label count, uniqueness, **prefix-freedom**, length balance, that the shortest labels come first, and a custom alphabet; input matching (partial, exact, no match, deletion); ordering by screen position; the editable-context test; visibility (zero size, outside the viewport, `display:none`, XUL `hidden`/`collapsed`, occlusion, partial exposure); clipping a row that wraps a subtree down to its own strip; and label placement (centred on the element's height, separated when labels collide, kept inside the viewport).

---

## 2. End-to-end tests (automated)

```bash
npm run test:e2e                       # installs the source directory temporarily
python3 test/e2e/run_e2e.py --xpi      # installs the packaged XPI instead (run npm run build first)
python3 test/e2e/run_e2e.py --keep     # leaves Thunderbird running after the run
```

How it works: the runner creates a throwaway profile, launches Thunderbird headless (through `xvfb-run` when there is no display), seeds Local Folders with two test folders and three messages, installs the extension temporarily, then sends **real key events** and inspects the chrome DOM. Your own profile is never touched.

Requirements: `python3`, plus `xvfb-run` when there is no display. An already-running Thunderbird is no obstacle — the test instance is isolated by its own profile and `-no-remote`.

Fourteen scenarios currently cover most of the manual checklist below. On failure, the log path is printed in the first lines of the run.

---

## 3. Manual checklist

What automation cannot reach: whether hints are **drawn where they can actually be seen**, situations where OS window focus really moves, and behaviour against your own accounts and large mailboxes.

Setup: load the extension with the temporary-install steps in [`README.md`](../README.md).

| # | Scenario | Action | Expected result | Automated |
|---|---|---|---|---|
| 1 | Startup | Load the extension in a running Thunderbird | No errors; `Vimbird ready` in the Browser Toolbox console | Indirectly |
| 2 | `f` in the Inbox | Select the inbox, press `f` | Hints appear over the toolbar, the folder tree and the message list | ✓ |
| 3 | Toolbar button hints | Press `f` | Every unified toolbar button carries a hint at its top-left corner | Partly |
| 4 | Typing a hint | Type a hint character | Non-matching hints disappear; the typed part is dimmed | ✓ |
| 5 | Activation | Complete a hint label | That button really is pressed | ✓ |
| 6 | `Esc` | Press `Esc` while hints are shown | Every hint disappears and nothing else happens | ✓ |
| 7 | Another folder | Switch folders, press `f` | Hints are recomputed for the new folder | ✓ |
| 8 | With a message selected | Select a message, press `f` | The message header buttons (Reply/Forward/Archive) get hints too | ✓ |
| 9 | With a message open | Open a message in a tab or window, press `f` | The open message gets hints | Partly |
| 10 | Compose window | Press `f` in a compose window | The compose toolbar gets hints (**needs OS focus — check this by hand**) | Synthetic events only |
| 11 | Text input | Put the cursor in the subject, body or search box and press `f` | No hints appear and **an `f` is typed** (**checking by hand is recommended**) | Synthetic events only |
| 12 | Window resize | Resize the window while hints are shown | The hints disappear rather than sitting at stale positions | ✓ (may fall back to a synthetic event when headless) |
| 13 | Scrolling | Scroll while hints are shown | The hints disappear | ✓ |
| 14 | Multi-character hints | Press `f` on a screen with more candidates than the alphabet has letters | Two-character labels appear and need both keystrokes | ✓ |
| 15 | Shared prefix | For example `sa` and `sd` both exist | Typing `s` activates nothing and only narrows the candidates | ✓ |

### What a human specifically has to look at

- **Hint placement**: does the label sit over the top-left corner of its element? Are hints on elements at the screen edge cut off?
- **Readability**: are the yellow labels legible in both the dark and the light theme?
- **Perceived speed**: does `f` respond immediately in a folder with thousands of messages? (The thread list is virtualised, so only the rows on screen are candidates.)
- **Scenarios 10 and 11**: a headless environment has no window manager, so OS focus cannot move to another window. The automated run dispatches synthetic key events, which exercises the code path but not OS-level key delivery — check these two in a real session.

### When something looks wrong

1. Look for warnings starting with `Vimbird:` in the **Browser Toolbox** console (Tools → Developer Tools → Browser Toolbox).
2. To see what the engine currently considers a candidate, run this in the add-on's background console:
   ```js
   await messenger.vimbird.dumpCandidates();
   ```
   It prints per-document candidate counts and a tag breakdown. If a particular button gets no hint, check here first whether it was missed during collection, then adjust the selectors in `src/tb/targets.js`.
3. If no hints appear at all, `messenger.vimbird.getStatus()` shows whether the extension attached to the window.
