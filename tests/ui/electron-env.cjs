'use strict';
// An empty value still enables Node mode on Windows; remove the variable entirely.
function electronEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
module.exports = { electronEnvironment };
