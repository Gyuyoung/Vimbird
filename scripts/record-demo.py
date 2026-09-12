#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Record the README demo against a real, headless Thunderbird.

Launches Thunderbird with a throwaway profile and a small demo mailbox,
installs Vimbird temporarily, then drives hint mode with real key events while
screenshotting the chrome window after every keystroke. The frames are real
captures; only the keycap badge at the bottom is drawn on afterwards, so the
reader can see which keys produced what.

    python3 scripts/record-demo.py [--out docs/images/hint-mode.gif] [--keep]

Needs python3, Pillow, ffmpeg and xvfb-run.
"""

import argparse
import base64
import io
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "test" / "e2e"))
from marionette import Marionette, MarionetteError  # noqa: E402

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

ADDON_ID = "vimbird@gyuyoung"
PORT = 2829              # not 2828, so a running e2e session is no obstacle
WIDTH, HEIGHT = 1440, 900
GIF_WIDTH = 960
FPS = 10

PREFS_TEMPLATE = """
user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.accountmanager.accounts", "account1");
user_pref("mail.accountmanager.defaultaccount", "account1");
user_pref("mail.accountmanager.localfoldersserver", "server1");
user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/Local Folders");
user_pref("mail.server.server1.hostname", "Local Folders");
user_pref("mail.server.server1.name", "Local Folders");
user_pref("mail.server.server1.type", "none");
user_pref("mail.identity.id1.useremail", "me@example.com");
user_pref("mail.identity.id1.fullName", "Gyuyoung");
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.rights.version", 1);
user_pref("mailnews.start_page.enabled", false);
user_pref("app.update.auto", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("devtools.chrome.enabled", true);
user_pref("marionette.port", %(port)d);
user_pref("mail.pane_config.dynamic", 2);
user_pref("mailnews.default_sort_type", 18);
user_pref("mailnews.default_sort_order", 2);
"""

PRELUDE = r"""
const { Services } = globalThis;
const vb = {
  win: () => Services.wm.getMostRecentWindow("mail:3pane"),
  tabmail() { return this.win().document.getElementById("tabmail"); },
  a3p() { return this.tabmail().currentAbout3Pane; },
  message() { return this.tabmail().currentAboutMessage; },
  documents() {
    return [
      ["messenger.xhtml", this.win()],
      ["about:3pane", this.a3p()],
      ["about:message", this.message()],
    ].filter(([, w]) => w);
  },
  hintsIn(w) {
    const layer = w.document.getElementById("vimbird-hint-layer");
    return layer ? [...layer.querySelectorAll(".vimbird-hint")] : [];
  },
  count() {
    let n = 0;
    for (const [, w] of this.documents()) n += this.hintsIn(w).filter(h => !h.hidden).length;
    return n;
  },
  labelOn(w, element) {
    const layer = w.document.getElementById("vimbird-hint-layer");
    if (!element || !layer) return null;
    const rect = element.getBoundingClientRect();
    const centre = rect.top + rect.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const hint of layer.querySelectorAll(".vimbird-hint")) {
      const hr = hint.getBoundingClientRect();
      const distance = Math.hypot(hr.left - rect.left, hr.top + hr.height / 2 - centre);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { label: hint.dataset.vimbirdLabel, distance: Math.round(distance) };
      }
    }
    return best;
  },
  folderRow(name) {
    const tree = this.a3p().document.getElementById("folderTree");
    for (const li of tree.querySelectorAll("li.collapsed")) li.classList.remove("collapsed");
    return [...tree.querySelectorAll("li[is='folder-tree-row']")]
      .find(row => (row.querySelector(".name") || {}).textContent === name) || null;
  },
  rowFor(subject) {
    const a3p = this.a3p();
    const view = a3p.gDBView;
    for (const row of a3p.document.querySelectorAll("#threadTree tbody tr")) {
      if (!Number.isInteger(row.index)) continue;
      const header = view.getMsgHdrAt(row.index);
      if (header && header.subject.includes(subject)) return row;
    }
    return null;
  },
  focusFolderTree() {
    this.win().focus();
    this.a3p().document.getElementById("folderTree").focus();
    return true;
  },
};
"""

SEED = PRELUDE + r"""
const [folders, messages] = arguments;
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const root = MailServices.accounts.localFoldersServer.rootMsgFolder;
for (const name of folders) {
  if (!root.containsChildNamed(name)) root.createSubfolder(name, null);
}
const counts = {};
for (const [name, raws] of Object.entries(messages)) {
  const folder = root.getChildNamed(name).QueryInterface(Ci.nsIMsgLocalMailFolder);
  if (folder.getTotalMessages(false) === 0) {
    for (const raw of raws) folder.addMessage(raw);
  }
  counts[name] = folder.getTotalMessages(false);
}
return counts;
"""


def message(sender, subject, when, body):
    # No "From - " envelope line: addMessage writes the mbox separator itself,
    # and a second unescaped one inside the content makes the reader split the
    # message in the wrong place, which shows up as stray headers in the body.
    return "\r\n".join([
        f"From: {sender}",
        "To: Gyuyoung <me@example.com>",
        f"Subject: {subject}",
        f"Date: {when.strftime('%a, %d %b %Y %H:%M:%S +0900')}",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        body,
        "",
        "",
    ])


def demo_mailbox():
    """The mailbox the GIF shows: plausible mail, nothing real in it."""
    now = datetime.now().replace(microsecond=0)
    today = now.replace(hour=9, minute=12, second=0)
    work = [
        message("Anna Whitfield <anna@example.com>", "Re: Release checklist for 0.4",
                today, "Ticked off the last two items. Ready for a tag whenever you are."),
        message("build-bot <ci@example.com>", f"Nightly build {now:%Y-%m-%d} succeeded",
                today.replace(hour=8, minute=3), "All 40 unit tests and 14 end-to-end scenarios green."),
        message("Marco Ferretti <marco@example.com>", "Keyboard navigation notes",
                today - timedelta(days=1, hours=11, minutes=32),
                "I tried driving the whole client without a mouse for a day. Notes attached\n"
                "below - the folder pane was the biggest gap."),
        message("Priya Raman <priya@example.com>", "Lunch on Thursday?",
                today - timedelta(days=1, hours=14, minutes=50),
                "There is a new place by the office. Thursday at noon, if that suits?"),
        message("Design Weekly <weekly@example.com>", "Issue #212: hint overlays that stay readable",
                today - timedelta(days=2, hours=22, minutes=12),
                "This week: label contrast, crowded toolbars, and why two keystrokes beat three."),
        message("Tobias Lund <tobias@example.com>", "Question about the folder pane",
                today - timedelta(days=3, hours=16, minutes=25),
                "Does the hint alphabet change when the tree is deep? Curious how it scales."),
    ]
    team = [
        message("Sofia Marek <sofia@example.com>", "Standup notes for this week",
                today - timedelta(hours=2),
                "Short version: hint mode is feature complete for the MVP.\n\n"
                "Labels are unique across the whole window now, so the toolbar, the\n"
                "folder tree and the message list never hand out the same one twice.\n"
                "Next up is hinting links inside message bodies."),
        message("Jonas Weber <jonas@example.com>", "Re: Thunderbird 155 upgrade",
                today - timedelta(days=1, hours=3),
                "Upgraded here with no surprises - the Experiment API still loads."),
        message("Lena Fischer <lena@example.com>", "Keyboard shortcut cheat sheet",
                today - timedelta(days=2, hours=5),
                "Drafted a one-pager for the team. Comments welcome."),
    ]
    return ["Archive", "Newsletters", "Team", "Work"], {"Work": work, "Team": team}


# --------------------------------------------------------------------------
# recording
# --------------------------------------------------------------------------

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


class Recorder:
    """Collects real screenshots and stamps the keys pressed onto them."""

    def __init__(self, mn):
        self.mn = mn
        self.frames = []          # (PIL image, seconds to hold)
        self.cap = font(26)
        self.caption = font(21)

    def shot(self):
        data = self.mn.send("WebDriver:TakeScreenshot", {"full": True})
        raw = data.get("value") if isinstance(data, dict) else data
        return Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")

    def capture(self, hold, keys=(), caption=None):
        image = self.shot()
        if keys or caption:
            self.overlay(image, keys, caption)
        self.frames.append((image, hold))

    def overlay(self, image, keys, caption):
        """Draw the keys pressed so far as keycaps, with an optional caption."""
        draw = ImageDraw.Draw(image, "RGBA")
        pad, gap = 14, 10
        caps = []
        for key in keys:
            width = max(38, draw.textlength(key, font=self.cap) + pad * 2)
            caps.append((key, width))
        cap_height = 46
        text_width = draw.textlength(caption, font=self.caption) if caption else 0
        bar_width = max(sum(w for _, w in caps) + gap * (len(caps) - 1) if caps else 0, text_width)
        bar_width += 40
        bar_height = cap_height + (34 if caption else 0) + 28
        left = (image.width - bar_width) // 2
        top = image.height - bar_height - 34
        draw.rounded_rectangle([left, top, left + bar_width, top + bar_height],
                               radius=16, fill=(24, 24, 27, 225))
        x = left + (bar_width - (sum(w for _, w in caps) + gap * (len(caps) - 1))) // 2 if caps else left
        y = top + 14
        for key, width in caps:
            draw.rounded_rectangle([x, y, x + width, y + cap_height], radius=8,
                                   fill=(250, 250, 250, 255), outline=(160, 160, 165, 255), width=1)
            text_x = x + (width - draw.textlength(key, font=self.cap)) / 2
            draw.text((text_x, y + 8), key, font=self.cap, fill=(24, 24, 27))
            x += width + gap
        if caption:
            text_x = left + (bar_width - text_width) / 2
            draw.text((text_x, top + cap_height + 22), caption, font=self.caption,
                      fill=(244, 244, 245))

    def write(self, out):
        """Assemble the frames into a GIF: fixed frame rate, holds repeated."""
        scratch = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / "vimbird-demo-frames"
        if scratch.exists():
            shutil.rmtree(scratch)
        scratch.mkdir(parents=True)
        index = 0
        for image, hold in self.frames:
            scaled = image.resize((GIF_WIDTH, round(image.height * GIF_WIDTH / image.width)),
                                  Image.LANCZOS)
            for _ in range(max(1, round(hold * FPS))):
                scaled.save(scratch / f"{index:04d}.png")
                index += 1
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(FPS), "-i", str(scratch / "%04d.png"),
            "-filter_complex",
            "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
            "-loop", "0", str(out),
        ], check=True)
        shutil.rmtree(scratch)
        return index


def type_label(rec, mn, label, caption=None):
    """Type a hint label one key at a time, capturing after each keystroke."""
    typed = ["f"]
    for i, key in enumerate(label):
        mn.press(key)
        time.sleep(0.7)
        typed.append(key)
        last = i == len(label) - 1
        rec.capture(0.6 if last else 1.0, keys=typed, caption=None if last else caption)


def sequence(rec, mn):
    """The story the GIF tells, driven with real key events."""
    # --- the starting point: a folder, a message list, a message open -------
    mn.script(PRELUDE + 'vb.folderRow("Work").click(); return true;')
    time.sleep(2.5)
    mn.script(PRELUDE + """
        const a3p = vb.a3p();
        const row = vb.rowFor("Keyboard navigation notes");
        a3p.threadTree.selectedIndex = row ? row.index : 0;
        return true;
    """)
    time.sleep(3)
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    time.sleep(0.6)
    rec.capture(1.6, caption="Thunderbird, no hints yet")

    # --- act 1: jump to another folder --------------------------------------
    mn.press("f")
    time.sleep(1.2)
    print(f"  hint mode   : {mn.script(PRELUDE + 'return vb.count();')} labels")
    rec.capture(2.0, keys=["f"], caption="every clickable thing gets a label")

    target = mn.script(PRELUDE + 'return vb.labelOn(vb.a3p(), vb.folderRow("Team"));')
    if not target or not target["label"]:
        raise RuntimeError("no hint on the Team folder row")
    print(f"  folder row  : {target['label']!r}")
    type_label(rec, mn, target["label"], caption="non-matching labels drop away")
    time.sleep(2.5)
    rec.capture(1.8, caption="that folder is open")

    # --- act 2: open a message from the list --------------------------------
    mn.script(PRELUDE + "return vb.focusFolderTree();")
    mn.press("f")
    time.sleep(1.3)
    rec.capture(1.6, keys=["f"], caption="press f again, wherever you are")
    target = mn.script(PRELUDE + """
        const row = vb.rowFor("Standup notes");
        return row ? vb.labelOn(vb.a3p(), row) : null;
    """)
    if not target or not target["label"]:
        raise RuntimeError("no hint on the standup message row")
    print(f"  message row : {target['label']!r}")
    type_label(rec, mn, target["label"])
    time.sleep(2.5)
    rec.capture(2.6, caption="the message is open \u2014 no mouse, no tabbing")


# --------------------------------------------------------------------------
# harness
# --------------------------------------------------------------------------

def profile_dir():
    base = pathlib.Path.home() / "snap" / "thunderbird" / "common"
    if not base.exists():
        base = pathlib.Path.home()
    return base / "vimbird-demo-profile"


def prepare_profile(path, reuse):
    if path.exists() and not reuse:
        shutil.rmtree(path)
    (path / "Mail" / "Local Folders").mkdir(parents=True, exist_ok=True)
    (path / "prefs.js").write_text(PREFS_TEMPLATE % {"port": PORT})
    return path


def launch(binary, profile, log):
    command = ["xvfb-run", "-a", "-s", f"-screen 0 {WIDTH}x{HEIGHT}x24",
               binary, "-profile", str(profile), "-no-remote",
               "-marionette", "-remote-allow-system-access"]
    handle = log.open("w")
    return subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)


def wait_for_port(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=2):
                return True
        except OSError:
            time.sleep(1)
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--thunderbird", default=shutil.which("thunderbird") or "thunderbird")
    parser.add_argument("--out", default="docs/images/hint-mode.gif")
    parser.add_argument("--still", default="",
                        help="also write the hint-mode frame as a still PNG")
    parser.add_argument("--keep", action="store_true", help="leave Thunderbird running")
    args = parser.parse_args()

    profile = prepare_profile(profile_dir(), reuse=False)
    log = profile.parent / "vimbird-demo.log"
    print(f"Thunderbird : {args.thunderbird}")
    print(f"profile     : {profile}")
    print(f"log         : {log}\n")

    process = launch(args.thunderbird, profile, log)
    if not wait_for_port():
        print("Marionette did not start; see the log above")
        return 2

    mn = None
    try:
        mn = Marionette(PORT)
        folders, messages = demo_mailbox()
        print("seed:", mn.script(SEED, [folders, messages]))
        mn.install_addon(str(REPO), ADDON_ID)
        time.sleep(4)
        mn.send("WebDriver:SetWindowRect", {"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT})
        time.sleep(1.5)

        rec = Recorder(mn)
        sequence(rec, mn)
        out = pathlib.Path(args.out)
        if not out.is_absolute():
            out = REPO / out
        count = rec.write(out)
        size = out.stat().st_size
        print(f"\n{out}  {count} frames at {FPS}fps, {size/1024:.0f} KiB")

        if args.still:
            still = pathlib.Path(args.still)
            if not still.is_absolute():
                still = REPO / still
            rec.frames[1][0].save(still)
            print(f"{still}  {still.stat().st_size/1024:.0f} KiB")
    except (MarionetteError, RuntimeError) as error:
        print(f"recording failed: {error}")
        return 1
    finally:
        if mn and not args.keep:
            mn.quit()
        elif args.keep:
            print(f"Thunderbird left running (pid {process.pid})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
