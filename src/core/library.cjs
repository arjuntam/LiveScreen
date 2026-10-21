'use strict';
const fs = require('node:fs');
class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const insist = (ok, msg) => { if (!ok) throw new AppError(msg); };
const text = (v, max = 80) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
function validateProjects(input, store, allowEmpty = false) {
  insist(Array.isArray(input) && input.length <= 100 && (allowEmpty || input.length > 0), '至少保留一个项目，最多 100 个');
  const ids = new Set();
  return input.map(p => {
    insist(p && id(p.id) && !ids.has(p.id) && text(p.name), '项目名称或标识无效/重复'); ids.add(p.id);
    insist(Array.isArray(p.scenes) && p.scenes.length <= 200 && (allowEmpty || p.scenes.length), '每个已发布项目至少有一个场景，最多 200 个');
    const sceneIds = new Set();
    const scenes = p.scenes.map(s => {
      insist(s && id(s.id) && !sceneIds.has(s.id) && text(s.name), '场景名称或标识无效/重复'); sceneIds.add(s.id);
      insist(['image', 'video', 'slideshow'].includes(s.type), '仅支持图片、MP4 视频、图片轮播');
      insist(s.label === undefined || (typeof s.label === 'string' && s.label.length <= 40), '场景标签最多 40 个字符');
      insist(Array.isArray(s.assetIds) && s.assetIds.length >= (allowEmpty ? 0 : 1) && s.assetIds.length <= 50, '场景需选择 1–50 个素材');
      insist(s.type === 'slideshow' || (allowEmpty ? s.assetIds.length <= 1 : s.assetIds.length === 1), '单图片/单视频只能选择一个素材');
      for (const aid of s.assetIds) {
        const a = store.data.assets[aid];
        insist(a && (s.type === 'video' ? a.kind === 'video' : a.kind === 'image'), '素材类型与场景不符');
        insist(fs.existsSync(store.assetPath(aid)), `素材丢失：${a.name}`);
      }
      const t = s.transform || {};
      const transform = { fit: t.fit || 'cover', scale: t.scale ?? 1, x: t.x ?? 0, y: t.y ?? 0 };
      insist(['cover', 'contain'].includes(transform.fit), '适配方式无效');
      insist(Number.isFinite(transform.scale) && transform.scale >= 0.25 && transform.scale <= 4, '缩放需在 0.25–4 倍之间');
      insist([transform.x, transform.y].every(v => Number.isFinite(v) && Math.abs(v) <= 100), '偏移需在 -100%–100% 之间');
      const interval = s.interval ?? 8;
      insist(Number.isFinite(interval) && interval >= 1 && interval <= 3600, '轮播间隔需在 1–3600 秒');
      const slideshowMode = s.slideshowMode ?? 'auto';
      insist(['auto', 'manual'].includes(slideshowMode), '多图播放方式无效');
      const pauseOnManual = s.pauseOnManual ?? false;
      insist(typeof pauseOnManual === 'boolean', '手动翻页后暂停设置无效');
      return { id: s.id, name: s.name.trim(), label: (s.label || '').trim(), type: s.type, assetIds: [...s.assetIds], interval, slideshowMode, pauseOnManual, transform };
    });
    insist(allowEmpty || sceneIds.has(p.defaultSceneId), '项目必须指定有效默认场景');
    return { id: p.id, name: p.name.trim(), defaultSceneId: p.defaultSceneId || scenes[0]?.id || null, scenes };
  });
}
function sceneIn(projects, projectId, sceneId) {
  const project = projects.find(p => p.id === projectId);
  const scene = project?.scenes.find(s => s.id === sceneId);
  if (!scene) throw new AppError('已发布场景不存在，请刷新页面', 404);
  return { project, scene };
}
module.exports = { AppError, validateProjects, sceneIn };
