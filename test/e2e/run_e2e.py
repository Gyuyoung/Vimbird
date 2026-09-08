#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""End-to-end tests for Vimbird against a real, headless Thunderbird.

Launches Thunderbird with a throwaway profile, installs the extension
temporarily, then drives hint mode with real key events and asserts on the
actual chrome DOM. See docs/testing.md.

    python3 test/e2e/run_e2e.py [--keep] [--thunderbird /path/to/thunderbird]
"""

import argparse
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from marionette import Marionette, MarionetteError  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
ADDON_ID = "vimbird@gyuyoung"
PORT = 2828

PREFS = """
user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.accountmanager.accounts", "account1");
user_pref("mail.accountmanager.defaultaccount", "account1");
user_pref("mail.accountmanager.localfoldersserver", "server1");
user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/Local Folders");
user_pref("mail.server.server1.hostname", "Local Folders");
user_pref("mail.server.server1.name", "Local Folders");
user_pref("mail.server.server1.type", "none");
user_pref("mail.identity.id1.useremail", "vimbird@example.com");
user_pref("mail.identity.id1.fullName", "Vimbird Test");
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.rights.version", 1);
user_pref("mailnews.start_page.enabled", false);
user_pref("app.update.auto", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("devtools.chrome.enabled", true);
"""

# Shared helpers, prepended to every chrome script.
PRELUDE = r"""
const { Services } = globalThis;
const vb = {
  win: () => Services.wm.getMostRecentWindow("mail:3pane"),
  compose: () => Services.wm.getMostRecentWindow("msgcompose"),
  tabmail() { return this.win().document.getElementById("tabmail"); },
  documents() {
    const tabmail = this.tabmail();
    return [
      ["messenger.xhtml", this.win()],
      ["about:3pane", tabmail && tabmail.currentAbout3Pane],
      ["about:message", tabmail && tabmail.currentAboutMessage],
      ["msgcompose", this.compose()],
    ].filter(([, w]) => w);
  },
  hintsIn(w) {
    const layer = w.document.getElementById("vimbird-hint-layer");
    return layer ? [...layer.querySelectorAll(".vimbird-hint")] : [];
  },
  allHints() {
    const out = [];
    for (const [name, w] of this.documents()) {
      for (const hint of this.hintsIn(w)) {
        out.push({ doc: name, label: hint.dataset.vimbirdLabel, hidden: hint.hidden });
      }
    }
    return out;
  },
  count() { return this.allHints().length; },
  labelOn(w, element) {
    const layer = w.document.getElementById("vimbird-hint-layer");
    if (!element || !layer) return null;
    const rect = element.getBoundingClientRect();
    let best = null;
    let bestDistance = Infinity;
    for (const hint of layer.querySelectorAll(".vimbird-hint")) {
      const hr = hint.getBoundingClientRect();
      const distance = Math.hypot(hr.left - rect.left, hr.top - rect.top);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { label: hint.dataset.vimbirdLabel, distance: Math.round(distance) };
      }
    }
    return best;
  },
  folderRow(name) {
    const a3p = this.tabmail().currentAbout3Pane;
    const tree = a3p.document.getElementById("folderTree");
    for (const li of tree.querySelectorAll("li.collapsed")) li.classList.remove("collapsed");
    return [...tree.querySelectorAll("li[is='folder-tree-row']")]
      .find(row => (row.querySelector(".name") || {}).textContent === name) || null;
  },
  focusFolderTree() {
    const win = this.win();
    win.focus();
    this.tabmail().currentAbout3Pane.document.getElementById("folderTree").focus();
    return Services.focus.focusedElement && Services.focus.focusedElement.id;
  },
  composeWindows() {
    let n = 0;
    for (const w of Services.wm.getEnumerator("msgcompose")) n++;
    return n;
  },
  // Headless Thunderbird has no window manager, so OS focus never leaves the
  // 3-pane window. For other windows we dispatch the keydown ourselves: it
  // still exercises the real listeners, guards and rendering path.
  synthKey(w, key, target) {
    const event = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, view: w });
    (target || w.document.activeElement || w.document.documentElement).dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  },
  closeCompose() {
    let n = 0;
    for (const w of Services.wm.getEnumerator("msgcompose")) { w.close(); n++; }
    return n;
  },
};
"""

SEED = PRELUDE + r"""
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const root = MailServices.accounts.localFoldersServer.rootMsgFolder;
for (const name of ["VimbirdA", "VimbirdB"]) {
  if (!root.containsChildNamed(name)) root.createSubfolder(name, null);
}
const folder = root.getChildNamed("VimbirdA").QueryInterface(Ci.nsIMsgLocalMailFolder);
if (folder.getTotalMessages(false) < 3) {
  const raw = [
    "From - Mon Sep 08 00:00:00 2026",
    "From: Alice <alice@example.com>",
    "To: Vimbird Test <vimbird@example.com>",
    "Subject: Vimbird test message",
    "Date: Mon, 8 Sep 2026 00:00:00 +0900",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Hello from the Vimbird end-to-end test.",
    "",
  ].join("\r\n");
  for (let i = 0; i < 3; i++) {
    folder.addMessage(raw.replace("Subject: ", `Subject: [${i}] `));
  }
  // A message whose header is crowded with inline recipient elements: this is
  // where hint labels used to pile up on top of each other.
  const many = [
    "From - Mon Sep 08 00:00:00 2026",
    "From: Alice <alice@example.com>",
    "To: " + Array.from({ length: 8 }, (_, i) => `P${i} <p${i}@example.com>`).join(", "),
    "Cc: " + Array.from({ length: 6 }, (_, i) => `C${i} <c${i}@example.com>`).join(", "),
    "Subject: [recipients] crowded header",
    "Date: Mon, 8 Sep 2026 00:00:00 +0900",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Crowded header test.",
    "",
  ].join("\r\n");
  folder.addMessage(many);
}
return { folders: [...root.subFolders].map(f => f.name), messages: folder.getTotalMessages(false) };
"""


class Failure(AssertionError):
    pass


def check(condition, message):
    if not condition:
        raise Failure(message)


# --------------------------------------------------------------------------
# scenarios
# --------------------------------------------------------------------------

def scenario_hints_appear(mn):
    """3, 7: pressing f hints the toolbar and the 3-pane."""
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.0)
    hints = mn.script(PRELUDE + "return vb.allHints();")
    docs = {hint["doc"] for hint in hints}
    check(len(hints) > 5, f"expected hints, got {len(hints)}")
    check("messenger.xhtml" in docs, f"no hints in the chrome window: {docs}")
    check("about:3pane" in docs, f"no hints in about:3pane: {docs}")
    return f"{len(hints)} hints across {sorted(docs)}"


def start_hint_mode(mn, settle=1.2):
    """Focus the folder tree and press f, the way a user starts hint mode."""
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(settle)


def scenario_labels_unique(mn):
    """14, 15: labels are unique and prefix-free across every document."""
    start_hint_mode(mn)
    labels = [hint["label"] for hint in mn.script(PRELUDE + "return vb.allHints();")]
    check(labels, "hint mode is not active")
    check(len(labels) == len(set(labels)), "duplicate hint labels across documents")
    for a in labels:
        for b in labels:
            check(a == b or not b.startswith(a), f"label {a!r} is a prefix of {b!r}")
    multi = [label for label in labels if len(label) > 1]
    return f"{len(labels)} labels, {len(multi)} multi-character, all prefix-free"


def scenario_hints_do_not_overlap(mn):
    """Labels must stay readable where elements sit close together.

    Compares the drawn positions against the raw anchors (each element's own
    corner, where labels used to be dropped): the anchor layout is expected to
    collide, the drawn one must not.
    """
    # Open a message first so the dense message-header button row is on screen.
    mn.script(PRELUDE + 'vb.folderRow("VimbirdA").click(); return true;')
    time.sleep(2)
    opened = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        const view = a3p.gDBView;
        for (let i = 0; i < view.rowCount; i++) {
          if (view.getMsgHdrAt(i).subject.includes("recipients")) {
            a3p.threadTree.selectedIndex = i;
            return { index: i, subject: view.getMsgHdrAt(i).subject };
          }
        }
        a3p.threadTree.selectedIndex = 0;
        return { index: 0, subject: view.getMsgHdrAt(0).subject };
        """
    )
    time.sleep(3)
    mn.script(
        PRELUDE
        + """
        // Expand the recipient list if the header collapsed it.
        const am = vb.tabmail().currentAboutMessage;
        am && am.document.querySelector("#toggleRecipients, .show-more-recipients")?.click();
        return true;
        """
    )
    time.sleep(1.5)
    start_hint_mode(mn)

    result = mn.script(
        PRELUDE
        + """
        function collide(a, b) {
          return a.left < b.left + b.width && b.left < a.left + a.width &&
                 a.top < b.top + b.height && b.top < a.top + a.height;
        }
        function count(boxes, out) {
          let n = 0;
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              if (collide(boxes[i], boxes[j])) {
                n++;
                if (out.length < 5) out.push(`${boxes[i].label} x ${boxes[j].label}`);
              }
            }
          }
          return n;
        }

        let total = 0, drawnCollisions = 0, anchorCollisions = 0;
        const examples = [];
        for (const [, w] of vb.documents()) {
          const drawn = [];
          const anchored = [];
          for (const hint of vb.hintsIn(w)) {
            const rect = hint.getBoundingClientRect();
            const [ax, ay] = hint.dataset.vimbirdAnchor.split(",").map(Number);
            const size = { width: rect.width, height: rect.height, label: hint.dataset.vimbirdLabel };
            drawn.push({ ...size, left: rect.left, top: rect.top });
            anchored.push({ ...size, left: ax, top: ay });
          }
          total += drawn.length;
          drawnCollisions += count(drawn, examples);
          anchorCollisions += count(anchored, []);
        }
        return { total, drawnCollisions, anchorCollisions, examples };
        """
    )
    mn.press(mn.ESCAPE)
    check(result["total"] > 20, f"expected a dense screen, got {result['total']} hints")
    check(
        result["drawnCollisions"] == 0,
        f"{result['drawnCollisions']} overlapping labels, e.g. {result['examples']}",
    )
    return (
        f"{result['total']} labels on {opened['subject']!r}: "
        f"{result['anchorCollisions']} would overlap on raw anchors, "
        f"{result['drawnCollisions']} do after spreading"
    )


def scenario_activate_button(mn):
    """4, 5: typing a hint really clicks the button."""
    start_hint_mode(mn)
    target = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        return vb.labelOn(a3p, a3p.document.getElementById("folderPaneWriteMessage"));
        """
    )
    check(target and target["label"], "no hint on the New Message button")
    check(target["distance"] < 20, f"hint is {target['distance']}px away from its element")
    before = mn.script(PRELUDE + "return vb.composeWindows();")
    mn.press(target["label"])
    time.sleep(3)
    after = mn.script(PRELUDE + "return vb.composeWindows();")
    check(after == before + 1, f"compose windows {before} -> {after}, expected +1")
    check(mn.script(PRELUDE + "return vb.count();") == 0, "hints were not cleared after activation")
    mn.script(PRELUDE + "return vb.closeCompose();")
    time.sleep(1)
    return f"hint {target['label']!r} opened the compose window"


def scenario_escape_cancels(mn):
    """6: Escape leaves hint mode without clicking anything."""
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.0)
    before = mn.script(PRELUDE + "return vb.count();")
    check(before > 0, "hint mode did not start")
    mn.press(mn.ESCAPE)
    time.sleep(0.8)
    after = mn.script(PRELUDE + "return vb.count();")
    check(after == 0, f"{after} hints survived Escape")
    return f"{before} hints dismissed"


def scenario_multi_character_hint(mn):
    """7, 14: a folder row hint switches folders, and the first keystroke of a
    two-character label narrows the session instead of activating anything."""
    mn.script(PRELUDE + 'vb.folderRow("VimbirdA").click(); return true;')
    time.sleep(1.5)
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.2)
    target = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        return vb.labelOn(a3p, vb.folderRow("VimbirdB"));
        """
    )
    check(target and target["label"], "no hint on the VimbirdB folder row")

    # A label is only as long as it needs to be, so the folder row may well hold
    # a single character. Check the multi-character path on whichever label
    # actually has two: its first keystroke must narrow the session, not fire.
    labels = [hint["label"] for hint in mn.script(PRELUDE + "return vb.allHints();")]
    multi = sorted(label for label in labels if len(label) > 1)
    check(multi, f"no multi-character label among {len(labels)} hints")
    prefix = multi[0][0]
    check(prefix not in labels, f"{prefix!r} is both a whole label and a prefix")
    mn.press(prefix)
    time.sleep(1.0)
    check(mn.script(PRELUDE + "return vb.count();") > 0,
          f"typing {prefix!r} ended hint mode instead of narrowing it")
    mn.press(mn.ESCAPE)
    time.sleep(0.8)

    mn.press("f")
    time.sleep(1.2)
    target = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        return vb.labelOn(a3p, vb.folderRow("VimbirdB"));
        """
    )
    check(target and target["label"], "no hint on the VimbirdB folder row after restarting hint mode")
    mn.press(target["label"])
    time.sleep(2)
    folder = mn.script(PRELUDE + "const a3p = vb.tabmail().currentAbout3Pane; return a3p.gFolder && a3p.gFolder.name;")
    check(folder == "VimbirdB", f"folder is {folder!r}, expected 'VimbirdB'")
    return f"hint {target['label']!r} switched folders, {prefix!r} narrowed {len(multi)} longer labels"


def scenario_message_pane_hints(mn):
    """8, 9: with a message open, the message header is hinted too."""
    mn.script(PRELUDE + 'vb.folderRow("VimbirdA").click(); return true;')
    time.sleep(2)
    mn.script(PRELUDE + "vb.tabmail().currentAbout3Pane.threadTree.selectedIndex = 0; return true;")
    time.sleep(3)
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.5)
    hints = mn.script(PRELUDE + "return vb.allHints();")
    docs = {hint["doc"] for hint in hints}
    reply = mn.script(
        PRELUDE
        + """
        const am = vb.tabmail().currentAboutMessage;
        if (!am) return null;
        return vb.labelOn(am, am.document.querySelector(".message-header-view-button"));
        """
    )
    mn.press(mn.ESCAPE)
    check("about:message" in docs, f"no hints in about:message: {sorted(docs)}")
    check(reply and reply["label"], "no hint on a message header button")
    return f"{len(hints)} hints, message header button hinted as {reply['label']!r}"


def scenario_thread_row_activation(mn):
    """8: a thread row hint must select the message AND show it in the message pane.

    Selecting a row is not enough to prove anything: assert the pane really
    switched to the message under the hint, starting from a different row.
    """
    baseline = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        a3p.threadTree.selectedIndex = 0;
        return { index: a3p.threadTree.selectedIndex };
        """
    )
    check(baseline["index"] == 0, f"could not set a baseline selection: {baseline}")
    time.sleep(2.5)

    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.2)
    target = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        // Skip the spacer rows the virtualised table keeps in the body.
        const rows = [...a3p.document.querySelectorAll("#threadTree tbody tr")]
          .filter(r => Number.isInteger(r.index));
        const row = rows.find(r => r.index !== 0);
        if (!row) return { error: "no second row", rows: rows.length };
        return { ...vb.labelOn(a3p, row), index: row.index,
                 subject: a3p.gDBView.getMsgHdrAt(row.index).subject, rows: rows.length };
        """
    )
    check(target and target["label"], "no hint on a thread row")
    mn.press(target["label"])
    time.sleep(3)

    state = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        const am = vb.tabmail().currentAboutMessage;
        return {
          selectedIndex: a3p.threadTree.selectedIndex,
          displayed: am && am.gMessage ? am.gMessage.subject : null,
        };
        """
    )
    check(
        state["selectedIndex"] == target["index"],
        f"selection is row {state['selectedIndex']}, expected {target['index']}",
    )
    check(
        state["displayed"] == target["subject"],
        f"message pane shows {state['displayed']!r}, expected {target['subject']!r}",
    )
    return f"row hint {target['label']!r} opened {state['displayed']!r} in the message pane"


def scenario_text_input_is_left_alone(mn):
    """11: with focus in a text field, f stays with the field."""
    mn.script(PRELUDE + "return vb.closeCompose();")
    mn.script(PRELUDE + 'vb.tabmail().currentAbout3Pane.document.getElementById("folderPaneWriteMessage").click(); return true;')
    time.sleep(4)
    result = mn.script(
        PRELUDE
        + """
        const w = vb.compose();
        if (!w) return { error: "no compose window" };
        const subject = w.document.getElementById("msgSubject");
        subject.focus();
        const sent = vb.synthKey(w, "f", subject);
        return { ...sent, hints: vb.hintsIn(w).length };
        """
    )
    mn.script(PRELUDE + "return vb.closeCompose();")
    time.sleep(1)
    check("error" not in result, str(result))
    check(result["hints"] == 0, "hint mode started while the text field had focus")
    check(not result["defaultPrevented"], "Vimbird swallowed a keystroke meant for the text field")
    return "f left untouched for the subject field"


def scenario_compose_window_hints(mn):
    """10: the compose window gets hints of its own."""
    mn.script(PRELUDE + "return vb.closeCompose();")
    mn.script(PRELUDE + 'vb.tabmail().currentAbout3Pane.document.getElementById("folderPaneWriteMessage").click(); return true;')
    time.sleep(4)
    result = mn.script(
        PRELUDE
        + """
        const w = vb.compose();
        if (!w) return { error: "no compose window" };
        const button = w.document.querySelector("toolbarbutton:not([hidden]), button:not([hidden])");
        button.focus();
        const sent = vb.synthKey(w, "f", button);
        return { ...sent, hints: vb.hintsIn(w).length,
                 labels: vb.hintsIn(w).slice(0, 5).map(h => h.dataset.vimbirdLabel) };
        """
    )
    mn.script(PRELUDE + 'const w = vb.compose(); if (w) vb.synthKey(w, "Escape"); return true;')
    time.sleep(0.5)
    mn.script(PRELUDE + "return vb.closeCompose();")
    check("error" not in result, str(result))
    check(result["defaultPrevented"], "Vimbird did not take the f key in the compose window")
    check(result["hints"] > 0, "no hints in the compose window")
    return f"{result['hints']} hints in the compose window"


def scenario_scroll_dismisses(mn):
    """13: scrolling invalidates hint positions, so the session ends."""
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.2)
    before = mn.script(PRELUDE + "return vb.count();")
    check(before > 0, "hint mode did not start")
    mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        const scroller = a3p.document.getElementById("threadTree");
        scroller.dispatchEvent(new a3p.Event("scroll", { bubbles: true }));
        return true;
        """
    )
    time.sleep(0.8)
    after = mn.script(PRELUDE + "return vb.count();")
    check(after == 0, f"{after} hints survived scrolling")
    return f"{before} hints dismissed on scroll"


def scenario_resize_dismisses(mn):
    """12: resizing the window ends hint mode rather than leaving stale hints."""
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.2)
    before = mn.script(PRELUDE + "return vb.count();")
    check(before > 0, "hint mode did not start")
    # Without a window manager resizeTo is sometimes ignored; fall back to a
    # synthesized resize so the dismissal path is still exercised.
    how = mn.script(
        PRELUDE
        + """
        const w = vb.win();
        const size = w.outerWidth;
        w.resizeTo(w.outerWidth - 40, w.outerHeight - 40);
        if (w.outerWidth !== size) return "resizeTo";
        w.dispatchEvent(new w.Event("resize"));
        return "synthetic";
        """
    )
    time.sleep(1.2)
    after = mn.script(PRELUDE + "return vb.count();")
    if how == "resizeTo":
        mn.script(PRELUDE + "const w = vb.win(); w.resizeTo(w.outerWidth + 40, w.outerHeight + 40); return true;")
    check(after == 0, f"{after} hints survived a window resize ({how})")
    return f"{before} hints dismissed on resize ({how})"


def scenario_key_does_not_leak(mn):
    """f must not reach Thunderbird's own handlers while hint mode consumes it."""
    mn.press(mn.ESCAPE)
    state = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        const tree = a3p.document.getElementById("folderTree");
        vb.focusFolderTree();
        globalThis.__vbLeak = 0;
        tree.addEventListener("keydown", globalThis.__vbLeakHandler = () => { globalThis.__vbLeak++; });
        return { armed: true };
        """
    )
    check(state["armed"], "could not arm the leak probe")
    mn.press("f")
    time.sleep(1.0)
    result = mn.script(
        PRELUDE
        + """
        const a3p = vb.tabmail().currentAbout3Pane;
        const tree = a3p.document.getElementById("folderTree");
        tree.removeEventListener("keydown", globalThis.__vbLeakHandler);
        return { leaked: globalThis.__vbLeak, hints: vb.count() };
        """
    )
    mn.press(mn.ESCAPE)
    check(result["hints"] > 0, "hint mode did not start")
    check(result["leaked"] == 0, f"the f keystroke reached the folder tree {result['leaked']} time(s)")
    return "f consumed before Thunderbird's own handlers"


SCENARIOS = [
    ("hints appear in toolbar and 3-pane", scenario_hints_appear),
    ("labels unique and prefix-free", scenario_labels_unique),
    ("hint labels do not overlap", scenario_hints_do_not_overlap),
    ("hint activates a toolbar button", scenario_activate_button),
    ("Escape cancels hint mode", scenario_escape_cancels),
    ("folder hint switches folders, partial input narrows", scenario_multi_character_hint),
    ("message header is hinted", scenario_message_pane_hints),
    ("thread row hint selects a message", scenario_thread_row_activation),
    ("text input keeps its keystrokes", scenario_text_input_is_left_alone),
    ("compose window is hinted", scenario_compose_window_hints),
    ("scroll dismisses hints", scenario_scroll_dismisses),
    ("resize dismisses hints", scenario_resize_dismisses),
    ("f does not leak into Thunderbird", scenario_key_does_not_leak),
]


# --------------------------------------------------------------------------
# harness
# --------------------------------------------------------------------------

def profile_dir():
    """Snap-confined Thunderbird can only read the profile from inside $HOME."""
    base = pathlib.Path.home() / "snap" / "thunderbird" / "common"
    if not base.exists():
        base = pathlib.Path.home()
    return base / "vimbird-e2e-profile"


def prepare_profile(path, reuse):
    if path.exists() and not reuse:
        shutil.rmtree(path)
    (path / "Mail" / "Local Folders").mkdir(parents=True, exist_ok=True)
    (path / "prefs.js").write_text(PREFS)
    return path


def launch(binary, profile, log):
    command = [binary, "-profile", str(profile), "-no-remote", "-marionette", "-remote-allow-system-access"]
    if not os.environ.get("DISPLAY"):
        command = ["xvfb-run", "-a", "-s", "-screen 0 1600x1000x24"] + command
    handle = log.open("w")
    return subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)


def wait_for_port(timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((("127.0.0.1"), PORT), timeout=2):
                return True
        except OSError:
            time.sleep(1)
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thunderbird", default=shutil.which("thunderbird") or "thunderbird")
    parser.add_argument("--keep", action="store_true", help="keep the test profile and leave Thunderbird running")
    parser.add_argument("--reuse-profile", action="store_true")
    parser.add_argument("--xpi", metavar="PATH", nargs="?", const="dist",
                        help="install a packaged .xpi instead of the source directory")
    args = parser.parse_args()

    source = str(REPO)
    if args.xpi:
        candidate = pathlib.Path(args.xpi)
        if candidate.is_dir():
            builds = sorted(candidate.glob("*.xpi"))
            if not builds:
                print(f"no .xpi in {candidate}; run `npm run build` first")
                return 2
            candidate = builds[-1]
        source = str(candidate.resolve())

    profile = prepare_profile(profile_dir(), args.reuse_profile)
    log = profile.parent / "vimbird-e2e.log"
    print(f"Thunderbird : {args.thunderbird}")
    print(f"profile     : {profile}")
    print(f"extension   : {source}")
    print(f"log         : {log}\n")

    process = launch(args.thunderbird, profile, log)
    if not wait_for_port():
        print("Marionette did not start; see the log above")
        return 2

    failures = 0
    mn = None
    try:
        mn = Marionette(PORT)
        print("seed:", json.dumps(mn.script(SEED)))
        mn.install_addon(source, ADDON_ID)
        time.sleep(4)

        status = mn.script(PRELUDE + "return { windowType: vb.win().document.documentElement.getAttribute('windowtype') };")
        print("window:", json.dumps(status), "\n")

        for name, scenario in SCENARIOS:
            mn.press(mn.ESCAPE)
            time.sleep(0.4)
            try:
                detail = scenario(mn)
                print(f"  PASS  {name} — {detail}")
            except (Failure, MarionetteError) as error:
                failures += 1
                print(f"  FAIL  {name} — {error}")
    finally:
        print(f"\n{len(SCENARIOS) - failures}/{len(SCENARIOS)} scenarios passed")
        if mn and not args.keep:
            mn.quit()
        elif args.keep:
            print(f"Thunderbird left running (pid {process.pid}); profile kept at {profile}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
