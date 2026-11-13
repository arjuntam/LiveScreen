'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { AppError } = require('./library.cjs');
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function createMediaLocation(store, { importBusy = () => false, checkpoint = async () => {} } = {}) {
  let job = null, work = null, closing = false;
  function status() {
    let available = false, writable = false;
    try { available = fs.statSync(store.mediaDir).isDirectory(); fs.accessSync(store.mediaDir, fs.constants.W_OK); writable = available; } catch { /* Report volume loss without creating a replacement. */ }
    return { directory: store.mediaDir, available, writable, migrating: store.mediaMigrating,
      message: !available ? '素材目录不可用，请恢复磁盘连接或原目录；软件没有创建替代素材库。' : !writable ? '素材目录不可写，请检查主机权限。' : '素材目录可用', job: job && structuredClone(job) };
  }
  async function files() {
    try { if (!fs.statSync(store.mediaDir).isDirectory()) throw new Error(); fs.accessSync(store.mediaDir,fs.constants.R_OK); } catch { throw new AppError('原素材目录不可用，请先恢复磁盘连接与读取权限再迁移', 503); }
    const names = await fsp.readdir(store.mediaDir);
    const result = [];
    for (const name of names) {
      const stat = await fsp.lstat(path.join(store.mediaDir, name));
      if (!stat.isFile() || !/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp|mp4)$/.test(name)) throw new AppError('原目录含有未完成上传或其他文件，请检查后重试', 409);
      result.push({ name, bytes: stat.size });
    }
    return result;
  }
  async function check(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || /^[/\\]{2}/.test(input) || input.includes('\0')) throw new AppError('请填写主机本机磁盘上的绝对目录，不支持网络共享');
    let target;
    try { target = await fsp.realpath(input); if (!(await fsp.stat(target)).isDirectory()) throw new Error(); }
    catch { throw new AppError('目标目录不存在，请先在主机建立文件夹'); }
    if (/^[/\\]{2}/.test(target)) throw new AppError('首版仅支持主机本机磁盘，不支持网络共享');
    const source = await fsp.realpath(store.mediaDir).catch(() => { throw new AppError('原素材目录不可用，请先恢复磁盘连接', 503); });
    const overlaps = (a,b) => { const rel = path.relative(a,b); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
    if (overlaps(source,target) || overlaps(target,source) || overlaps(target,path.resolve(store.root))) throw new AppError('目标目录不能是原目录、其父子目录或主机配置目录');
    if ((await fsp.readdir(target)).length) throw new AppError('请选择空文件夹，避免覆盖已有文件', 409);
    const list = await files(); const bytes = list.reduce((n,f) => n + f.bytes,0);
    const disk = await fsp.statfs(target); const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (freeBytes < bytes + 1024 ** 3) throw new AppError('目标空间不足，复制素材后需保留至少 1 GB', 507);
    const probe = path.join(target, `.livescreen-check-${randomUUID()}`);
    try { await fsp.writeFile(probe, '', { flag:'wx', mode:0o600 }); }
    catch { throw new AppError('目标目录不可写，请检查主机权限'); }
    finally { await fsp.rm(probe,{force:true}); }
    return { directory: target, bytes, count: list.length, freeBytes };
  }
  async function start(input) {
    if (closing || store.mediaMigrating || store.mediaWriters || importBusy()) throw new AppError('请先完成上传、文稿导入或当前迁移，再调整素材目录', 409);
    // Lock before asynchronous checks: no upload or import may start in between.
    store.mediaMigrating = true;
    let checked;
    try { checked = await check(input); }
    catch (e) { store.mediaMigrating = false; throw e; }
    const source = store.mediaDir;
    job = { id:randomUUID(), state:'copying', source, target:checked.directory, count:checked.count, completed:0, bytes:checked.bytes, copiedBytes:0, error:null };
    work = (async () => {
      const staging = path.join(job.target, `.livescreen-migration-${job.id}`), created = [];
      let committed = false;
      try {
        await fsp.mkdir(staging);
        const list = await files();
        for (const file of list) {
          if (closing) throw new Error('软件退出，迁移未切换；原素材和原设置保持可用');
          const from = path.join(source,file.name), to = path.join(staging,file.name);
          await fsp.copyFile(from,to,fs.constants.COPYFILE_EXCL);
          const before = await hash(from), after = await hash(to);
          if (before !== after) throw new Error('素材校验失败，未切换目录');
          await checkpoint('verified', file.name);
          job.completed++; job.copiedBytes += file.bytes;
        }
        if (closing) throw new Error('软件退出，迁移未切换');
        job.state = 'switching';
        for (const file of list) {
          // link is exclusive on both supported platforms; never overwrite an
          // unrelated file created in the target while the copy was running.
          const final = path.join(job.target,file.name);
          await fsp.link(path.join(staging,file.name),final); created.push(final);
        }
        await checkpoint('before-switch');
        if (closing) throw new Error('软件退出，迁移未切换');
        store.saveSettings({ mediaDirectory:job.target });
        store.mediaDir = job.target; committed = true; job.state = 'completed';
        store.log('media-directory-changed', { files:job.completed, bytes:job.copiedBytes });
      } catch (e) {
        job.state = 'failed'; job.error = `迁移未完成：${e.message}。原素材和原设置已保留。`;
        if (!committed) for (const file of created) {
          // Remove only our still-unmodified verified copy.
          if (await hash(file).catch(() => null) === await hash(path.join(source,path.basename(file))).catch(() => null)) await fsp.rm(file,{force:true});
        }
        store.log('media-migration-failed', { error:e.message });
      } finally {
        await fsp.rm(staging,{recursive:true,force:true}).catch(() => {});
        store.mediaMigrating = false;
      }
    })();
    return status();
  }
  return { status, check, start, wait: () => work, async close() { closing = true; await work; } };
}
module.exports = { createMediaLocation };
