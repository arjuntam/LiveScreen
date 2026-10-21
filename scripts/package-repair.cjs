'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyNsis } = require('./verify-windows.cjs');
const root = path.resolve(__dirname, '..'); const version = require('../package.json').version;
const payload = fs.readFileSync(path.join(root, 'dist', `LiveScreen-Uninstaller-${version}.exe`)); verifyNsis(payload);
const hash = crypto.createHash('sha256').update(payload).digest('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'livescreen-repair-kit-'));
try {
  fs.writeFileSync(path.join(temp, 'fixed-uninstaller.bin'), payload);
  const command = fs.readFileSync(path.join(__dirname, 'repair-legacy.cmd'), 'utf8').replace('__PAYLOAD_SHA256__', hash).replaceAll('__CURRENT_VERSION__', version).replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(temp, 'repair.cmd'), command, 'ascii');
  fs.writeFileSync(path.join(temp, 'README.md'), `# 修复旧版卸载器\n\n先关闭所有 LiveScreen 安装/卸载窗口，把本 ZIP 完整解压，再双击 repair.cmd。看到 SUCCESS 后，从 Windows 设置卸载旧版，或直接安装 ${version}。不要单独打开 .bin 文件。\n\n仅匹配本项目注册的 0.1.0/0.2.0；自动校验修复文件 SHA256，备份原卸载器后再替换。脚本不删除项目、素材、安装目录或注册表。备份位置为当前用户 LocalAppData/LiveScreen/installer-backups/原版本。\n\n若提示权限不足，请使用同一 Windows 账户右键以管理员身份运行。若提示找不到安装记录，请保留报错，不要自行删除目录。不要用另一个管理员账户运行。\n\n已验证载荷的 NSIS 内部 CRC、ZIP 完整性和 SHA256；修复脚本及 Windows 卸载流程仍需现场验证。当前文件没有商业签名。\n`);
  const output = path.join(root, 'dist', `LiveScreen-Repair-${version}.zip`);
  execFileSync('python3', ['-c', 'import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED) as z:\n for f in sorted(p.iterdir()): z.write(f,f.name)\nwith zipfile.ZipFile(sys.argv[2]) as z: assert z.testzip() is None\n', temp, output]);
  console.log('Legacy repair ZIP built and verified:', output);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
