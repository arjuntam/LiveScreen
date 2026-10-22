'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const signature = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i; for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff; for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
function verifyNsis(buffer) {
  if (buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable');
  let offset = -1;
  for (let pos = 512; pos + 28 < buffer.length; pos += 512) {
    if (buffer.subarray(pos + 4, pos + 20).equals(signature) && pos + buffer.readUInt32LE(pos + 24) === buffer.length) { offset = pos; break; }
  }
  if (offset < 0 || (buffer.readUInt32LE(offset) & 4)) throw new Error('Missing NSIS header or disabled integrity check');
  const expected = buffer.readUInt32LE(buffer.length - 4); const actual = crc32(buffer.subarray(512, -4));
  if (expected !== actual) throw new Error(`NSIS CRC mismatch: ${actual.toString(16)} != ${expected.toString(16)}`);
  return { bytes: buffer.length, crc32: actual.toString(16).padStart(8, '0'), nsisOffset: offset };
}
async function verifyBuild() {
  const root = path.resolve(__dirname, '..'); const version = require('../package.json').version;
  require('./verify-runtime.cjs').verifyRuntime(path.join(root,'dist/win-unpacked/resources/app.asar'),root);
  const installer = path.join(root, 'dist', `LiveScreen-Setup-${version}-x64.exe`);
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
  // The builder's minimal Windows 7za reads the embedded app archive but
  // omits NSIS virtual files. Use the full NSIS-capable 7-Zip on Windows.
  const full7zip = path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe');
  const tool = process.platform === 'win32' ? full7zip : await getPath7za();
  if (!fs.existsSync(tool)) throw new Error('Install the full 7-Zip distribution to verify NSIS installers on Windows');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-installer-check-'));
  try {
    const checks = { installer: verifyNsis(fs.readFileSync(installer)) };
    // NSIS virtual directory separators differ between 7-Zip builds. Extract
    // the archive flat, then verify the exact filenames and their CRCs below.
    execFileSync(tool, ['e', '-tNsis', '-y', `-o${temp}`, installer], { stdio: 'pipe' });
    for (const filename of ['Uninstall LiveScreen.exe', 'livescreen-repaired-uninstaller.exe']) {
      if (!fs.existsSync(path.join(temp, filename))) throw new Error(`Missing ${filename}; extracted files: ${fs.readdirSync(temp).join(', ')}`);
    }
    const uninstaller = fs.readFileSync(path.join(temp, 'Uninstall LiveScreen.exe'));
    checks.uninstaller = verifyNsis(uninstaller);
    const repair = fs.readFileSync(path.join(temp, 'livescreen-repaired-uninstaller.exe'));
    checks.legacyRepair = verifyNsis(repair);
    if (!repair.equals(uninstaller)) throw new Error('Repair and installed uninstallers differ');
    fs.copyFileSync(path.join(temp, 'Uninstall LiveScreen.exe'), path.join(root, 'dist', `LiveScreen-Uninstaller-${version}.exe`));
    fs.writeFileSync(path.join(root, 'dist', `windows-integrity-${version}.json`), JSON.stringify(checks, null, 2) + '\n');
    console.log('Installer, embedded uninstaller and legacy repair payload: independent NSIS CRC passed.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) verifyBuild().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { crc32, verifyNsis };
