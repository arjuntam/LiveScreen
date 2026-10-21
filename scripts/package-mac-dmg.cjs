'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('DMG packaging requires macOS');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const app = path.join(root, 'dist/mac/mac-arm64/LiveScreen.app');
if (!fs.existsSync(app)) throw new Error('Build the Mac application first');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-dmg-'));
const output = path.join(root, `dist/mac/LiveScreen-Mac-${version}-arm64.dmg`);
try {
  execFileSync('/usr/bin/ditto', [app, path.join(staging, 'LiveScreen.app')]);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  fs.writeFileSync(path.join(staging, '安装说明.txt'), '将 LiveScreen 拖入 Applications（应用程序），再从应用程序打开。\n当前为未公证开发测试包。首次启动请允许本地网络访问。\n');
  execFileSync('/usr/bin/hdiutil', ['create', '-ov', '-volname', `LiveScreen ${version}`, '-srcfolder', staging, '-format', 'UDZO', output], { stdio: 'inherit' });
  execFileSync('/usr/bin/hdiutil', ['verify', output], { stdio: 'inherit' });
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
console.log('Mac DMG verified:', output);
