'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
class Store {
  constructor(root, exampleRoot) {
    this.root = root;
    this.mediaDir = path.join(root, 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.file = path.join(root, 'library.json');
    if (!fs.existsSync(this.file)) {
      const library = JSON.parse(fs.readFileSync(path.join(exampleRoot, 'library.json')));
      for (const asset of Object.values(library.assets)) {
        fs.copyFileSync(path.join(exampleRoot, asset.file), path.join(this.mediaDir, asset.file));
      }
      atomicJSON(this.file, library);
    }
    // An invalid existing file must never silently overwrite an operator's library.
    this.data = JSON.parse(fs.readFileSync(this.file));
    if (this.data.schema !== 1) throw new Error('素材库版本不受支持，请从备份恢复 library.json');
    this.settingsFile = path.join(root, 'settings.json');
    const savedSettings = fs.existsSync(this.settingsFile)
      ? JSON.parse(fs.readFileSync(this.settingsFile))
      : { schema: 1, display: null, lastProjectId: null, autoStart: false, port: 8080 };
    this.settings = { transition: { enabled: true, durationMs: 300 }, afterPairingView: 'project-default', defaultProjectId: null, silentAutoStart: true, outputPaused: false, ...savedSettings, startupView: 'pairing-guide' };
    this.saveSettings({});
  }
  save(data) { atomicJSON(this.file, data); this.data = structuredClone(data); }
  saveSettings(patch) {
    const next = { ...this.settings, ...patch };
    atomicJSON(this.settingsFile, next); this.settings = next;
  }
  assetPath(id) {
    const asset = this.data.assets[id];
    if (!asset || !/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|mp4)$/.test(asset.file)) throw new Error('素材不存在');
    return path.join(this.mediaDir, asset.file);
  }
  log(event, detail = {}) {
    try {
      const dir = path.join(this.root, 'logs'); fs.mkdirSync(dir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const file = path.join(dir, `${date}.jsonl`);
      // Bound disk use to 14 daily files; no media or credentials enter logs.
      for (const old of fs.readdirSync(dir).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort().slice(0, -13)) {
        if (old !== `${date}.jsonl`) fs.unlinkSync(path.join(dir, old));
      }
      if (!fs.existsSync(file) || fs.statSync(file).size < 10 * 1024 * 1024) {
        fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n');
      }
    } catch { /* logging failure cannot stop an already playing scene */ }
  }
}
module.exports = { Store, atomicJSON };
