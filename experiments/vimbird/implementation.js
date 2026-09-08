"use strict";

/* global ExtensionCommon, Services */

// eslint-disable-next-line no-var
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

// Experiment scripts share one global with every other add-on's experiment, so
// everything this file defines is namespaced.

// eslint-disable-next-line no-var
var VimbirdConst = {
  HINT_KEY: "f",
  ALPHABET: "asdfghjkl",
  LISTENER_ID: "vimbird",
  // Two registrations: the default group stops the app's own handlers, the
  // system group is a separate dispatch group that stopPropagation cannot
  // reach (measured on Thunderbird 155, see docs/verification.md).
  LISTENER_OPTIONS: [
    { capture: true },
    { capture: true, mozSystemGroup: true },
  ],
  CHROME_URLS: [
    "chrome://messenger/content/messenger.xhtml",
    "chrome://messenger/content/messageWindow.xhtml",
    "chrome://messenger/content/messengercompose/messengercompose.xhtml",
  ],
  CORE_SCRIPTS: [
    "src/core/hint-labels.js",
    "src/core/hint-matcher.js",
    "src/core/ranking.js",
    "src/core/editable.js",
  ],
  AGENT_SCRIPTS: [
    "src/core/placement.js",
    "src/tb/targets.js",
    "src/dom/visibility.js",
    "src/dom/candidates.js",
    "src/dom/overlay.js",
    "src/dom/activate.js",
    "src/agent/agent.js",
  ],
  MAX_BROWSER_DEPTH: 3,
  MODIFIER_KEYS: new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "OS", "AltGraph"]),
  // Anything that moves elements around invalidates the hints we just drew.
  DISMISS_OPTIONS: {
    scroll: { capture: true, passive: true },
    resize: { passive: true },
    mousedown: { capture: true, passive: true },
  },
};

/**
 * Drives hint mode for one chrome window: owns the key listeners, the set of
 * hintable documents and the lifetime of a hint session.
 */
// eslint-disable-next-line no-var
var VimbirdWindow = class {
  constructor(win, core, loadScript, token) {
    this.win = win;
    this.core = core;
    this.loadScript = loadScript;
    this.token = token;
    this.session = null;
    this.decisions = new WeakMap();
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onDismiss = this.onDismiss.bind(this);
  }

  attach() {
    for (const options of VimbirdConst.LISTENER_OPTIONS) {
      this.win.addEventListener("keydown", this.onKeyDown, options);
    }
  }

  dispose() {
    this.endSession();
    for (const options of VimbirdConst.LISTENER_OPTIONS) {
      this.win.removeEventListener("keydown", this.onKeyDown, options);
    }
    for (const win of this.hintableWindows()) {
      try {
        win.Vimbird?.agent?.dispose();
      } catch (error) {
        console.warn("Vimbird: agent dispose failed", error);
      }
    }
  }

  // --- key handling -------------------------------------------------------

  onKeyDown(event) {
    // The same event arrives twice, once per listener group; decide once.
    if (!this.decisions.has(event)) {
      this.decisions.set(event, this.decide(event));
    }
    if (this.decisions.get(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  }

  /** @returns {boolean} whether Vimbird takes this key away from Thunderbird */
  decide(event) {
    if (!this.session) {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return false;
      }
      if (event.key !== VimbirdConst.HINT_KEY) {
        return false;
      }
      if (this.core.editable.isInEditableContext(event.target)) {
        return false;
      }
      return this.startSession();
    }

    if (VimbirdConst.MODIFIER_KEYS.has(event.key)) {
      return false;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      // The user is reaching for an application shortcut, not a hint.
      this.endSession();
      return false;
    }
    if (event.key === "Escape") {
      this.endSession();
      return true;
    }
    if (event.key === "Backspace") {
      this.applyInput(this.session.input.slice(0, -1));
      return true;
    }
    if (this.core.matcher.isHintKey(event, VimbirdConst.ALPHABET)) {
      this.applyInput(this.session.input + event.key.toLowerCase());
      return true;
    }

    // Anything else (Tab, Enter, arrows, other letters) leaves hint mode. The
    // key is swallowed so a mistyped hint cannot trigger an unrelated command.
    this.endSession();
    return true;
  }

  // --- session ------------------------------------------------------------

  startSession() {
    const entries = [];
    const agents = [];

    for (const win of this.hintableWindows()) {
      let agent;
      try {
        agent = this.ensureAgent(win);
      } catch (error) {
        console.warn("Vimbird: could not inject agent", win.document?.URL, error);
        continue;
      }
      agents.push({ win, agent });
      for (const found of agent.collect({})) {
        entries.push({
          id: found.id,
          screenX: found.screenX,
          screenY: found.screenY,
          tag: found.tag,
          agent,
        });
      }
    }

    if (!entries.length) {
      for (const { agent } of agents) {
        agent.clear();
      }
      return false;
    }

    const ordered = this.core.ranking.sortByScreenPosition(entries);
    const labels = this.core.labels.generateLabels(ordered.length, VimbirdConst.ALPHABET);

    const perAgent = new Map();
    ordered.forEach((item, index) => {
      item.label = labels[index];
      if (!perAgent.has(item.agent)) {
        perAgent.set(item.agent, []);
      }
      perAgent.get(item.agent).push({ id: item.id, label: item.label });
    });
    for (const [agent, assignments] of perAgent) {
      agent.render(assignments);
    }

    this.session = { items: ordered, labels, input: "", agents };
    this.addDismissListeners();
    return true;
  }

  applyInput(input) {
    if (!this.session) {
      return;
    }
    this.session.input = input;

    const result = this.core.matcher.resolve(this.session.labels, input);
    if (result.status === "exact") {
      const target = this.session.items[result.index];
      try {
        // Activate before ending the session: ending it releases the agents'
        // element references.
        target.agent.activate(target.id, {});
      } catch (error) {
        console.warn("Vimbird: activation failed", error);
      }
      this.endSession();
      return;
    }
    if (result.status === "none") {
      this.endSession();
      return;
    }
    for (const { agent } of this.session.agents) {
      agent.filter(input);
    }
  }

  endSession() {
    if (!this.session) {
      return;
    }
    const { agents } = this.session;
    this.session = null;
    this.removeDismissListeners(agents);
    for (const { agent } of agents) {
      try {
        agent.clear();
      } catch (error) {
        console.warn("Vimbird: clear failed", error);
      }
    }
  }

  onDismiss() {
    this.endSession();
  }

  addDismissListeners() {
    for (const { win } of this.session.agents) {
      for (const [type, options] of Object.entries(VimbirdConst.DISMISS_OPTIONS)) {
        win.addEventListener(type, this.onDismiss, options);
      }
    }
  }

  removeDismissListeners(agents) {
    for (const { win } of agents) {
      try {
        for (const [type, options] of Object.entries(VimbirdConst.DISMISS_OPTIONS)) {
          win.removeEventListener(type, this.onDismiss, options);
        }
      } catch (error) {
        console.warn("Vimbird: listener cleanup failed", error);
      }
    }
  }

  // --- documents ----------------------------------------------------------

  /** The chrome window plus every in-process chrome document it embeds. */
  *hintableWindows() {
    yield this.win;
    yield* this.childWindows(this.win, 0);
  }

  /**
   * Walks `<browser>` elements: about:3pane sits in one, about:message inside
   * that. Remote and `type="content"` browsers are skipped — those hold web or
   * message-body content, which is a later phase and belongs to the standard
   * message-display script API rather than chrome access.
   */
  *childWindows(win, depth) {
    if (depth > VimbirdConst.MAX_BROWSER_DEPTH) {
      return;
    }
    let browsers;
    try {
      browsers = win.document.querySelectorAll("browser");
    } catch {
      return;
    }
    for (const browser of browsers) {
      let child = null;
      try {
        if (browser.isRemoteBrowser || browser.getAttribute("type") === "content" || browser.hidden) {
          continue;
        }
        const rect = browser.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) {
          continue;
        }
        child = browser.contentWindow;
        if (!child || !child.document || child.document.URL === "about:blank") {
          continue;
        }
      } catch {
        continue;
      }
      yield child;
      yield* this.childWindows(child, depth + 1);
    }
  }

  /**
   * Inject the engine into a document once. The token makes a reloaded
   * extension replace stale code instead of reusing whatever an earlier
   * version left on the window — otherwise every edit would need a restart.
   */
  ensureAgent(win) {
    if (win.Vimbird && win.Vimbird.agent && win.Vimbird.token === this.token) {
      return win.Vimbird.agent;
    }
    for (const path of VimbirdConst.AGENT_SCRIPTS) {
      this.loadScript(path, win);
    }
    win.Vimbird.token = this.token;
    win.Vimbird.agent = win.Vimbird.createAgent(win);
    return win.Vimbird.agent;
  }

  describe() {
    return {
      url: this.win.document.URL,
      windowType: this.win.document.documentElement.getAttribute("windowtype"),
      documents: [...this.hintableWindows()].map(win => win.document.URL),
      active: Boolean(this.session),
      hints: this.session ? this.session.labels.length : 0,
      input: this.session ? this.session.input : "",
    };
  }
};

// eslint-disable-next-line no-var
var vimbird = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    this.install();
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    this.uninstall();
  }

  install() {
    if (this.controllers) {
      return;
    }
    this.controllers = new Map();
    this.core = this.loadCore();
    this.token = `${this.extension.version}-${Date.now()}`;

    ExtensionSupport.registerWindowListener(VimbirdConst.LISTENER_ID, {
      chromeURLs: VimbirdConst.CHROME_URLS,
      onLoadWindow: win => {
        const load = (path, target) => this.loadScript(path, target);
        const controller = new VimbirdWindow(win, this.core, load, this.token);
        controller.attach();
        this.controllers.set(win, controller);
      },
      onUnloadWindow: win => {
        this.controllers.get(win)?.dispose();
        this.controllers.delete(win);
      },
    });
  }

  uninstall() {
    if (!this.controllers) {
      return;
    }
    ExtensionSupport.unregisterWindowListener(VimbirdConst.LISTENER_ID);
    for (const controller of this.controllers.values()) {
      controller.dispose();
    }
    this.controllers = null;
    this.core = null;
  }

  loadCore() {
    const scope = {};
    for (const path of VimbirdConst.CORE_SCRIPTS) {
      this.loadScript(path, scope);
    }
    return scope.Vimbird;
  }

  /**
   * Extension resources live under file:/jar: URLs, which the subscript loader
   * only accepts with allowUnsafeURL — the same call the WebExtension framework
   * makes to load this very file (ExtensionCommon.sys.mjs:1702).
   */
  loadScript(path, target) {
    Services.scriptloader.loadSubScriptWithOptions(this.extension.rootURI.resolve(path), {
      target,
      allowUnsafeURL: true,
    });
  }

  activeController() {
    const win = Services.wm.getMostRecentWindow(null);
    return this.controllers?.get(win) ?? null;
  }

  getAPI() {
    const api = this;
    return {
      vimbird: {
        async getStatus() {
          return {
            installed: Boolean(api.controllers),
            windows: api.controllers ? [...api.controllers.values()].map(c => c.describe()) : [],
          };
        },

        /** Diagnostics: what would be hinted right now, without showing hints. */
        async dumpCandidates() {
          const controller = api.activeController();
          if (!controller) {
            return { error: "no active Vimbird window" };
          }
          const documents = [];
          for (const win of controller.hintableWindows()) {
            const agent = controller.ensureAgent(win);
            const found = agent.collect({});
            const tags = {};
            for (const item of found) {
              tags[item.tag] = (tags[item.tag] ?? 0) + 1;
            }
            agent.clear();
            documents.push({ url: win.document.URL, count: found.length, tags });
          }
          return { documents };
        },

        /** Same entry point the `f` key uses; lets tests drive hint mode. */
        async startHintMode() {
          const controller = api.activeController();
          if (!controller) {
            return { error: "no active Vimbird window" };
          }
          const started = controller.startSession();
          return { started, ...controller.describe() };
        },

        async sendHintInput(input) {
          const controller = api.activeController();
          if (!controller?.session) {
            return { error: "hint mode is not active" };
          }
          controller.applyInput(input);
          return controller.describe();
        },

        async cancelHintMode() {
          const controller = api.activeController();
          controller?.endSession();
          return { cancelled: true };
        },
      },
    };
  }
};
