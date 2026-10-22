'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { AppError } = require('./library.cjs');
const IMPORT_MAX = 128 * 1024 * 1024, MAX_PAGES = 200, MAX_SELECTED = 50;
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
function createPresentationImporter({ store, adapter }) {
  const base = path.join(store.root, 'presentation-imports');
  // This directory contains disposable conversion jobs, never library media.
  fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(base, { recursive: true });
  const jobs = new Map(); let active = null, closed = false;
  function find(id) { const job = jobs.get(id); if (!job) throw new AppError('导入任务已过期，请重新选择文件', 404); return job; }
  function snapshot(job) {
    return { id: job.id, name: job.name, state: job.state, message: job.message, completed: job.pages.length, total: job.total,
      pages: job.state === 'ready' ? job.pages.map(p => ({ index: p.index, width: p.width, height: p.height, url: `/api/admin/imports/${job.id}/pages/${p.index}.png` })) : [],
      maxSelected: MAX_SELECTED };
  }
  function release(job) { if (active === job) active = null; fs.rmSync(job.dir, { recursive: true, force: true }); }
  async function cancel(id) {
    const job = find(id); job.abort.abort(); job.state = 'cancelled'; job.message = '已取消导入';
    await job.work?.catch(() => {}); release(job); jobs.delete(id);
  }
  async function render(job, file, ext) {
    try {
      job.state = 'converting'; job.message = ext === '.pdf' ? '正在读取 PDF…' : '正在将演示文稿转换为静态页面…';
      const pdf = ext === '.pdf' ? file : await adapter.convert(file, job.dir, job.abort.signal);
      job.state = 'rendering'; job.message = '正在生成页面预览…';
      await adapter.renderPDF(pdf, { signal: job.abort.signal, maxPages: MAX_PAGES,
        onTotal(total) { if (!Number.isInteger(total) || total < 1 || total > MAX_PAGES) throw new AppError(`一次最多导入 ${MAX_PAGES} 页，请拆分文件`); job.total = total; },
        onPage(index, bytes) {
          job.abort.signal.throwIfAborted();
          if (index !== job.pages.length || index >= MAX_PAGES || !Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > 24 * 1024 * 1024 || !bytes.subarray(0,8).equals(PNG)) throw new Error('页面生成失败，请改用 PDF 导入');
          const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
          if (width < 1 || height < 1 || width * height > 8_000_000) throw new Error('页面尺寸过大，请调整文稿后重试');
          const stat = fs.statfsSync(base);
          if (Number(stat.bavail) * Number(stat.bsize) < bytes.length + 1024 ** 3 || job.bytes + bytes.length > 512 * 1024 * 1024) throw new Error('转换所需空间不足，请减少页数后重试');
          fs.writeFileSync(path.join(job.dir, `${index}.png`), bytes, { flag: 'wx', mode: 0o600 });
          job.pages.push({ index, width, height, bytes: bytes.length }); job.bytes += bytes.length;
          job.message = `正在生成页面 ${index + 1} / ${job.total || '…'}`;
        }
      });
      job.abort.signal.throwIfAborted();
      if (!job.pages.length || job.pages.length !== job.total) throw new Error('文稿未完整转换，请改用 PDF 导入');
      job.state = 'ready'; job.message = '选择需要的页面，确认后创建多图场景';
      // Conversion inputs are disposable; keep only previews until confirmation.
      for (const item of fs.readdirSync(job.dir)) if (!/^\d+\.png$/.test(item)) fs.rmSync(path.join(job.dir, item), { recursive: true, force: true });
    } catch (error) {
      if (job.abort.signal.aborted) { job.state = 'cancelled'; job.message = '已取消导入'; }
      else { job.state = 'failed'; job.message = error.publicMessage || (error instanceof AppError ? error.message : '转换失败。请将 PPT 导出为 PDF 后再导入；加密或损坏文件请先修复。'); store.log('presentation-import-failed', { type: ext, code: error.code || 'CONVERSION_FAILED' }); }
      release(job);
    }
  }
  const timer = setInterval(() => { for (const job of jobs.values()) if (Date.now() - job.created > 30 * 60_000) void cancel(job.id).catch(() => {}); }, 60_000); timer.unref();
  return {
    async capabilities() { return { ...(await adapter.capabilities()), maxBytes: IMPORT_MAX, maxPages: MAX_PAGES, maxSelected: MAX_SELECTED, activeJob: active ? snapshot(active) : null }; },
    async upload(req) {
      if (closed) throw new AppError('软件正在退出', 503);
      if (active) throw new AppError('已有文稿正在导入，请先完成或取消当前任务', 409);
      let name; try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { throw new AppError('文件名编码错误'); }
      name = path.basename(name.replaceAll('\\', '/'));
      const ext = path.extname(name).toLowerCase(); name = name.slice(0,160-ext.length)+ext;
      const size = Number(req.headers['content-length']);
      if (!['.ppt', '.pptx', '.pdf'].includes(ext)) throw new AppError('请选择 PPT、PPTX 或 PDF，不支持宏演示文稿格式');
      if (!Number.isInteger(size) || size < 1 || size > IMPORT_MAX) throw new AppError('演示文稿最多 128 MB', 413);
      const stat = fs.statfsSync(base); if (Number(stat.bavail) * Number(stat.bsize) < size + 1024 ** 3) throw new AppError('磁盘空间不足，需保留至少 1 GB', 507);
      for (const [id, job] of jobs) if (['failed','committed','cancelled'].includes(job.state)) jobs.delete(id);
      const id = crypto.randomUUID(), dir = path.join(base, id);
      const job = { id, dir, name, state: 'uploading', message: '正在上传…', pages: [], total: 0, bytes: 0, created: Date.now(), abort: new AbortController() };
      fs.mkdirSync(dir); jobs.set(id, job); active = job;
      const file = path.join(dir, 'source' + ext); let received = 0; const first = [];
      try {
        await pipeline(req, new Transform({ transform(chunk, _enc, cb) { if (received < 8) first.push(chunk.subarray(0,8-received)); received += chunk.length; cb(received > size ? new AppError('上传长度超出限制', 413) : null, chunk); } }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: job.abort.signal });
        if (received !== size) throw new AppError('文件未完整上传');
        const head = Buffer.concat(first);
        if (!(ext === '.pdf' ? head.subarray(0,5).toString() === '%PDF-' : ext === '.pptx' ? head[0] === 80 && head[1] === 75 : head.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')))) throw new AppError('文件内容与格式不符，请选择原始 PPT 或 PDF');
        job.work = render(job, file, ext); return snapshot(job);
      } catch (error) { release(job); jobs.delete(id); throw error; }
    },
    get(id) { return snapshot(find(id)); },
    page(id, index) { const job = find(id); if (job.state !== 'ready' || !Number.isInteger(index) || !job.pages[index]) throw new AppError('页面不存在',404); return path.join(job.dir, `${index}.png`); },
    commit(id, { pages, name }) {
      const job = find(id); if (job.result) return job.result;
      if (job.state !== 'ready') throw new AppError('文稿尚未转换完成',409);
      if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_SELECTED || new Set(pages).size !== pages.length || pages.some(i => !Number.isInteger(i) || !job.pages[i])) throw new AppError('每个场景请选择 1–50 个不同页面');
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new AppError('请填写 80 字以内的场景名称');
      const requiredBytes=pages.reduce((sum,index)=>sum+job.pages[index].bytes,0), free=fs.statfsSync(store.mediaDir);
      if (Number(free.bavail)*Number(free.bsize)<requiredBytes+1024**3) throw new AppError('磁盘空间不足，需保留至少 1 GB',507);
      const assets = [], copied = [];
      try {
        for (const index of [...pages].sort((a,b) => a-b)) {
          const page = job.pages[index], aid = crypto.randomUUID(), filename = aid + '.png', dest = path.join(store.mediaDir, filename);
          fs.copyFileSync(path.join(job.dir, `${index}.png`), dest, fs.constants.COPYFILE_EXCL); copied.push(dest);
          assets.push({ id: aid, file: filename, name: `${name.trim()} · 第 ${index + 1} 页`, kind: 'image', bytes: page.bytes, width: page.width, height: page.height });
        }
        store.save({ ...store.data, assets: { ...store.data.assets, ...Object.fromEntries(assets.map(a => [a.id, a])) } });
      } catch (error) { for (const file of copied) fs.rmSync(file, { force: true }); throw error; }
      const scene = { id: crypto.randomUUID(), name: name.trim(), label: '', type: 'slideshow', assetIds: assets.map(a => a.id), interval: 8, slideshowMode: 'manual', pauseOnManual: true, transform: { fit: 'contain', scale: 1, x: 0, y: 0 } };
      job.state = 'committed'; job.message = '图片已保存，请保存并发布场景'; job.result = { assets, scene };
      release(job); store.log('presentation-imported', { pages: assets.length }); return job.result;
    },
    cancel,
    async close() { closed = true; clearInterval(timer); await Promise.all([...jobs.keys()].map(id => cancel(id).catch(() => {}))); }
  };
}
module.exports = { createPresentationImporter, IMPORT_MAX, MAX_PAGES, MAX_SELECTED };
