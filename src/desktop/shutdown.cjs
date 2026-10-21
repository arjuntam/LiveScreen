'use strict';

// All exit paths share one cleanup. The final deadline also covers a stuck
// network shutdown or Electron quit veto, so an invisible app cannot linger.
function createShutdown({ onBegin, stopActivity, closeWindows, closeServer, quit, forceExit, log = () => {}, timeoutMs = 3000 }) {
  let started = false;
  const report = (event, detail) => { try { log(event, detail); } catch { /* Logging must never prevent exit. */ } };
  return async function shutdown() {
    if (started) return;
    started = true;
    const timer = setTimeout(() => { report('shutdown-timeout', {}); forceExit(0); }, timeoutMs);
    timer.unref?.();
    for (const action of [onBegin, stopActivity, closeWindows]) {
      try { action(); } catch (error) { report('shutdown-error', { error: error.message }); }
    }
    try { await closeServer(); } catch (error) { report('shutdown-error', { error: error.message }); }
    try { quit(); } catch (error) { report('shutdown-error', { error: error.message }); forceExit(0); }
  };
}

module.exports = { createShutdown };
