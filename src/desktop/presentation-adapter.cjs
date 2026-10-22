'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
function publicError(message) { return Object.assign(new Error(message), { publicMessage: message }); }
function run(file, args, { signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, output = '';
    const stop = () => {
      if (!child) return;
      if (process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => {}); }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const done = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(output); };
    const abort = () => { stop(); done(publicError('已取消导入')); };
    if (signal?.aborted) return done(publicError('已取消导入'));
    child = spawn(file, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { if (output.length < 16000) output += b.toString(); });
    child.on('error', done); child.on('close', code => done(code === 0 ? null : publicError('PPT 转换失败，请关闭文稿的密码或保护，或将其导出为 PDF 后导入。')));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { stop(); done(publicError('PPT 转换超时，请将文稿导出为 PDF 后导入。')); }, timeout);
  });
}
function findLibreOffice(platform = process.platform) {
  const candidates = [process.env.LIVESCREEN_SOFFICE,
    ...(platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice'] : []),
    ...(platform === 'win32' ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(p => path.join(p, 'LibreOffice/program/soffice.com')) : []),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, platform === 'win32' ? 'soffice.com' : 'soffice'))];
  return candidates.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}
function createPresentationAdapter({ BrowserWindow, ipcMain }) {
  async function engines() {
    let powerpoint = false;
    if (process.platform === 'win32') {
      try { await run('reg.exe', ['query', 'HKCR\\PowerPoint.Application\\CLSID'], { timeout: 5000 }); powerpoint = true; } catch { /* PDF and LibreOffice remain available. */ }
    }
    return { powerpoint, libreoffice: findLibreOffice() };
  }
  return {
    async capabilities() { const e = await engines(); return { pdf: true, ppt: !!(e.powerpoint || e.libreoffice), converter: e.powerpoint ? 'Microsoft PowerPoint' : e.libreoffice ? 'LibreOffice' : null }; },
    async convert(file, dir, signal) {
      const e = await engines(), output = path.join(dir, 'converted'); fs.mkdirSync(output);
      if (e.powerpoint) {
        const owner = path.join(dir, 'powerpoint-owner.json');
        try {
          const quote = value => "'"+value.replaceAll("'","''")+"'";
          const script = fs.readFileSync(path.join(__dirname,'presentation-convert.ps1'),'utf8');
          const command = `& { ${script} } -InputFile ${quote(file)} -OutputFile ${quote(path.join(output,'source.pdf'))} -OwnerFile ${quote(owner)}`;
          const executable=path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
          await run(executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], { signal });
        } catch (error) {
          // Only terminate an instance created by this job, with a matching start
          // time. Never kill an operator's existing PowerPoint session.
          try {
            const own = JSON.parse(fs.readFileSync(owner,'utf8').replace(/^\uFEFF/,''));
            if (Number.isInteger(own.id) && /^\d+$/.test(String(own.ticks))) {
              await run('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', `$p=Get-Process -Id ${own.id} -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq 'POWERPNT' -and $p.StartTime.Ticks.ToString() -eq '${own.ticks}'){Stop-Process -Id $p.Id -Force}`], { timeout: 5000 });
            }
          } catch { /* No owned instance was recorded. */ }
          throw error;
        }
      } else if (e.libreoffice) {
        const profile = path.join(dir, 'lo-profile'); fs.mkdirSync(path.join(profile,'user'), { recursive:true });
        fs.writeFileSync(path.join(profile,'user/registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
        await run(e.libreoffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless','--norestore','--nodefault','--nofirststartwizard','--convert-to','pdf:impress_pdf_Export','--outdir',output,file], { signal });
      } else throw publicError('大屏主机未安装可用的 PPT 转换工具。Windows 可安装 PowerPoint，Windows / Mac 可安装 LibreOffice；也可以先导出 PDF 后导入。');
      signal.throwIfAborted();
      const pdf = path.join(output,'source.pdf');
      if (!fs.existsSync(pdf) || fs.statSync(pdf).size < 5 || fs.statSync(pdf).size > 128 * 1024 * 1024) throw publicError('PPT 未成功转换，请将文稿导出为 PDF 后导入。');
      return pdf;
    },
    renderPDF(file, { signal, maxPages, onTotal, onPage }) {
      return new Promise((resolve, reject) => {
        const channel = 'presentation-' + randomUUID(); let finished = false, loaded = false, next = 0;
        const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
          preload: path.join(__dirname,'presentation-preload.cjs'), additionalArguments: ['--presentation-channel=' + channel],
          nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: 'presentation-' + randomUUID()
        } });
        const finish = error => {
          if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); ipcMain.removeHandler(channel);
          if (!win.isDestroyed()) win.destroy(); error ? reject(error) : resolve();
        };
        const abort = () => finish(publicError('已取消导入'));
        const timer = setTimeout(() => finish(publicError('页面转换超时，请减少文稿页数后重试。')), 5 * 60_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', event => event.preventDefault());
        win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
        win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] }, (_details, callback) => callback({ cancel:true }));
        win.webContents.on('render-process-gone', () => finish(publicError('文稿过于复杂，页面转换中止。请导出 PDF 或拆分后重试。')));
        win.on('closed', () => { if (!finished) finish(publicError('转换窗口已关闭，请重试。')); });
        ipcMain.handle(channel, (event, request) => {
          if (finished || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('转换来源无效');
          signal.throwIfAborted();
          try {
            if (request.action === 'load' && !loaded) { loaded = true; return { bytes: fs.readFileSync(file), maxPages }; }
            if (request.action === 'total' && loaded) { onTotal(request.total); return; }
            if (request.action === 'page' && request.index === next) {
              if (typeof request.png !== 'string' || request.png.length > 32 * 1024 * 1024) throw new Error('页面过大');
              onPage(next++, Buffer.from(request.png,'base64')); return;
            }
            if (request.action === 'done') { finish(); return; }
            if (request.action === 'error') { finish(publicError(request.password ? '文稿有密码保护，请先解除密码后导入。' : 'PDF 页面无法读取，请重新导出 PDF 后导入。')); return; }
            throw new Error('转换消息无效');
          } catch (error) { finish(error); throw error; }
        });
        win.loadFile(path.join(__dirname,'presentation-render.html')).catch(finish);
      });
    }
  };
}
module.exports = { createPresentationAdapter, findLibreOffice, run };
