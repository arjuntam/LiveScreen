'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const out = path.join(root, 'dist/mac'), app = path.join(out, 'mac-arm64/LiveScreen.app');
const archive = path.join(app, 'Contents/Resources/app.asar');
require('./verify-runtime.cjs').verifyRuntime(archive,root);
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]); }
let count = 0;
for (const file of ['src','web','assets','examples'].flatMap(dir => files(path.join(root,dir)))) {
  const relative = path.relative(root,file);
  if (!asar.extractFile(archive,relative).equals(fs.readFileSync(file))) throw new Error('Packaged source mismatch: '+relative);
  count++;
}
const metadata = JSON.parse(asar.extractFile(archive,'package.json'));
if (metadata.version !== version || metadata.livescreenPreview !== false) throw new Error('Wrong release metadata');
if (asar.listPackage(archive).some(name => /company-guide-assets|wireless-auth\.jpg|enterprise\.jpg/.test(name))) throw new Error('Private guide asset in Mac runtime');
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const plist = path.join(app,'Contents/Info.plist');
const plistValue = key => execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist],{encoding:'utf8'}).trim();
if (plistValue('CFBundleIdentifier') !== 'local.livescreen.player') throw new Error('Wrong bundle identifier');
if (!plistValue('NSLocalNetworkUsageDescription')) throw new Error('Missing LAN permission description');
const zip = path.join(out,`LiveScreen-Mac-${version}-arm64.zip`), dmg = path.join(out,`LiveScreen-Mac-${version}-arm64.dmg`);
execFileSync('python3',['-c', 'import zipfile,sys,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert hashlib.sha256(z.read("LiveScreen.app/Contents/Resources/app.asar")).digest()==hashlib.sha256(open(sys.argv[2],"rb").read()).digest()\n',zip,archive]);
execFileSync('/usr/bin/hdiutil',['verify',dmg],{stdio:'pipe'});
const mount = fs.mkdtempSync(path.join(os.tmpdir(),'livescreen-verify-dmg-'));
let mounted = false;
try {
  execFileSync('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,dmg],{stdio:'pipe'}); mounted = true;
  if (fs.readlinkSync(path.join(mount,'Applications')) !== '/Applications') throw new Error('Missing Applications link');
  for (const relative of ['Contents/Resources/app.asar','Contents/Info.plist','Contents/MacOS/LiveScreen']) {
    if (!fs.readFileSync(path.join(mount,'LiveScreen.app',relative)).equals(fs.readFileSync(path.join(app,relative)))) throw new Error('DMG payload mismatch: '+relative);
  }
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',path.join(mount,'LiveScreen.app')]);
} finally {
  if (mounted) { execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'pipe'}); mounted = false; }
  if (!mounted) fs.rmSync(mount,{recursive:true,force:true});
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result = { version, architecture:'arm64', minimumMacOS:plistValue('LSMinimumSystemVersion'), runtimeSourceFilesVerified:count,
  codeIntegrity:'ad-hoc signature verified (not Developer ID, not notarized)', zipCRC:true, dmgCRC:true, dmgPayloadMatches:true,
  artifacts:Object.fromEntries([zip,dmg].map(file=>[path.basename(file),hash(file)])) };
fs.writeFileSync(path.join(out,`mac-integrity-${version}.json`),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
