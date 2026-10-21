'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateProjects } = require('../src/core/library.cjs');
const { Store } = require('../src/core/store.cjs');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
let count = 0;
for (const file of ['src', 'web', 'scripts', 'tests'].flatMap(d => files(path.join(root, d))).filter(f => /\.(cjs|js)$/.test(f))) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); } count++;
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-check-'));
try {
  const store = new Store(temp, path.join(root, 'examples'));
  validateProjects(store.data.published, store);
  for (const asset of Object.values(store.data.assets)) if (!fs.statSync(store.assetPath(asset.id)).size) throw new Error('Empty example asset');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log(`Syntax checked: ${count} files; sample library and all assets valid.`);
