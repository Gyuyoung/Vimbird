# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Minimal Marionette client.

Thunderbird ships Marionette (chrome://remote/content/marionette). Started with
`-marionette -remote-allow-system-access`, it listens on 127.0.0.1:2828 and lets
us run JavaScript inside the chrome process — which is how these tests inspect
the real Thunderbird UI instead of a mock.
"""

import json
import socket

HOST = "127.0.0.1"
DEFAULT_PORT = 2828


class MarionetteError(RuntimeError):
    pass


class Marionette:
    def __init__(self, port=DEFAULT_PORT, timeout=60):
        self.sock = socket.create_connection((HOST, port), timeout=timeout)
        self.buffer = b""
        self.message_id = 0
        self._read_packet()  # server handshake
        self.send("WebDriver:NewSession", {"capabilities": {}})
        self.send("Marionette:SetContext", {"value": "chrome"})

    # --- transport ---------------------------------------------------------

    def _read_packet(self):
        while b":" not in self.buffer:
            self.buffer += self._recv()
        length, _, rest = self.buffer.partition(b":")
        size = int(length)
        self.buffer = rest
        while len(self.buffer) < size:
            self.buffer += self._recv()
        payload, self.buffer = self.buffer[:size], self.buffer[size:]
        return json.loads(payload)

    def _recv(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise MarionetteError("Marionette connection closed")
        return chunk

    def send(self, command, params=None):
        self.message_id += 1
        body = json.dumps([0, self.message_id, command, params or {}]).encode()
        self.sock.sendall(f"{len(body)}:".encode() + body)
        while True:
            message = self._read_packet()
            if isinstance(message, list) and message[0] == 1 and message[1] == self.message_id:
                error, result = message[2], message[3]
                if error:
                    raise MarionetteError(f"{error.get('error')}: {error.get('message')}")
                return result

    # --- helpers -----------------------------------------------------------

    def script(self, source, args=None):
        """Run JavaScript in the chrome process and return its value."""
        result = self.send(
            "WebDriver:ExecuteScript",
            {"script": source, "args": args or [], "sandbox": "system", "newSandbox": False},
        )
        return result.get("value") if isinstance(result, dict) and "value" in result else result

    def press(self, keys):
        """Send real key events through the widget layer, one character at a time."""
        actions = []
        for key in keys:
            actions.append({"type": "keyDown", "value": key})
            actions.append({"type": "keyUp", "value": key})
        self.send("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": actions}]})
        self.send("WebDriver:ReleaseActions", {})

    # WebDriver key codes (U+E000 block)
    ESCAPE = "\ue00c"
    BACKSPACE = "\ue003"

    def install_addon(self, path, addon_id=None):
        if addon_id:
            try:
                self.send("Addon:Uninstall", {"id": addon_id})
            except MarionetteError:
                pass
        return self.send("Addon:Install", {"path": path, "temporary": True})

    def quit(self):
        try:
            self.send("Marionette:Quit", {"flags": ["eForceQuit"]})
        except (MarionetteError, OSError):
            pass
