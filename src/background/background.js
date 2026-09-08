"use strict";

/* global messenger */

// Hint mode itself runs in the experiment's parent process code, which starts
// from the extension's "startup" event. That keeps it alive even when this
// event page is suspended. This script only reports state for debugging.
messenger.vimbird.getStatus().then(status => {
  console.info("Vimbird ready", status);
});
