'use strict';
const { api, element: el, message, connect } = LS;
const $ = s => document.querySelector(s);
const nativeUI = !!window.livescreenDesktop;
let library, projectId, sceneId, dirty = false, source, system, saving = false;
let pairing, pairingBusy = false;
let editVersion = 0, saveError = '';
let liveState, localProjectId, localRequesting = false, desktopOnline = true, systemLoading;
let pairingWait = Promise.resolve();
let networkNameDirty = false, networkNameVersion = 0;
LS.passwordToggles();
const project = () => library?.draft.find(p => p.id === projectId);
const scene = () => project()?.scenes.find(s => s.id === sceneId);
const uid = () => 'id_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function changed() { dirty = true; editVersion++; saveError = ''; status(); }
function status() {
  $('#draftState').textContent = saveError ? (saveError.startsWith('草稿已保存') ? '已保存，发布失败' : '保存失败，请重试') : saving ? '正在保存…' : dirty ? '有未保存修改' : library.hasUnpublishedChanges ? '已保存，待发布' : '已发布';
  $('#saveScene').disabled = saving || !dirty;
  $('#saveScene').textContent = saving ? '正在保存…' : '保存场景';
  LS.feedback('#sceneSaveFeedback', saveError || (saving ? '正在保存到大屏电脑…' : dirty ? '有未保存修改，请点“保存场景”。' : library.hasUnpublishedChanges ? '已保存到大屏电脑；发布后可选择新内容。' : '内容已发布，切换场景后加载已发布内容。'), !!saveError);
}
async function action(fn) { try { return await fn(); } catch (e) { message(e.message, true); return null; } }
function move(array, item, delta) { const i = array.indexOf(item); if (i + delta < 0 || i + delta >= array.length) return; [array[i], array[i + delta]] = [array[i + delta], array[i]]; changed(); }
function renderProjects() {
  if (!project()) projectId = library.draft[0]?.id;
  $('#projects').replaceChildren(...library.draft.map(p => el('button', { className: 'side-item', 'aria-pressed': String(projectId === p.id), onClick: () => { projectId = p.id; sceneId = null; renderProjects(); } }, [el('span', { text: p.name }), el('small', { text: String(p.scenes.length) })])));
  const p = project(); $('#projectEditor').hidden = !p; $('#noProject').hidden = !!p;
  ['#projectUp', '#projectDown', '#copyProject', '#deleteProject'].forEach(s => $(s).disabled = !p);
  if (!p) { $('#sceneEditor').hidden = true; return; }
  $('#projectName').value = p.name; renderScenes();
}
function renderScenes() {
  const p = project(); if (!p) return;
  if (!p.scenes.some(s => s.id === sceneId)) sceneId = p.scenes[0]?.id;
  $('#scenes').replaceChildren(...p.scenes.map(s => {
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    const select = el('button', { className: 'scene-select', 'aria-pressed': String(sceneId === s.id), onClick: () => { sceneId = s.id; renderScenes(); } }, [el('span', { text: s.name }), ...(label ? [el('small', { className: 'badge scene-label', text: label })] : [])]);
    const controls = el('div', { className: 'toolbar' }, [
      el('button', { text: '↑', 'aria-label': s.name + ' 上移', onClick: () => { move(p.scenes, s, -1); renderScenes(); } }),
      el('button', { text: '↓', 'aria-label': s.name + ' 下移', onClick: () => { move(p.scenes, s, 1); renderScenes(); } }),
      el('button', { text: s.id === p.defaultSceneId ? '✓ 项目默认' : '设为默认', onClick: () => { p.defaultSceneId = s.id; changed(); renderScenes(); } }),
      el('button', { text: '删除', className: 'danger', onClick: () => { p.scenes.splice(p.scenes.indexOf(s), 1); if (p.defaultSceneId === s.id) p.defaultSceneId = p.scenes[0]?.id; changed(); renderScenes(); } })
    ]);
    controls.hidden = sceneId !== s.id;
    if (s.id === p.defaultSceneId) select.append(el('small', { className: 'default-mark', text: '项目默认' }));
    return el('div', { className: 'scene-row' }, [select, controls]);
  }));
  if (!p.scenes.length) $('#scenes').append(el('p', { className: 'empty', text: '还没有场景。新建后选择本地素材。' }));
  renderEditor();
}
function renderEditor() {
  const s = scene(); $('#sceneEditor').hidden = !s; if (!s) return;
  $('#sceneName').value = s.name; $('#sceneLabel').value = s.label || ''; $('#sceneType').value = s.type; $('#fit').value = s.transform.fit;
  $('#upload').multiple = s.type === 'slideshow'; $('#upload').accept = s.type === 'video' ? '.mp4' : '.png,.jpg,.jpeg,.webp';
  $('#scale').value = s.transform.scale; $('#offsetX').value = s.transform.x; $('#offsetY').value = s.transform.y;
  $('#interval').value = s.interval; $('#slideshowMode').value = s.slideshowMode || 'auto';
  $('#slideshowModeLabel').hidden = s.type !== 'slideshow'; $('#intervalLabel').hidden = s.type !== 'slideshow' || s.slideshowMode === 'manual';
  $('#pauseOnManualLabel').hidden = s.type !== 'slideshow' || s.slideshowMode === 'manual';
  $('#pauseOnManual').value = s.pauseOnManual ? 'pause' : 'continue';
  status(); renderAssets(); renderPreview();
}
function renderAssets() {
  const s = scene(); if (!s) return;
  const assets = s.assetIds.map(id => library.assets[id]).filter(Boolean);
  $('#assets').replaceChildren(...assets.map(a => {
    const remove = el('button', { text: '移除', 'aria-label': '移除素材 ' + a.name, onClick: () => {
      s.assetIds = s.assetIds.filter(id => id !== a.id);
      changed(); renderAssets(); renderPreview();
    } });
    return el('div', { className: 'scene-asset' }, [el('span', { text: a.name }), remove]);
  }));
  if (!assets.length) $('#assets').append(el('p', { text: '此场景还没有素材，请上传自己的图片或视频。' }));
  $('#assetOrder').replaceChildren(...(s.type === 'slideshow' ? s.assetIds : []).map((id, i) => el('div', { className: 'toolbar' }, [
    el('small', { text: `${i + 1}. ${library.assets[id]?.name || '素材缺失'}` }),
    el('button', { text: '↑', 'aria-label': `轮播第 ${i + 1} 张上移`, onClick: () => { move(s.assetIds, id, -1); renderAssets(); renderPreview(); } })
  ])));
}
function renderPreview() {
  const s = scene(); const box = $('#preview'); box.querySelectorAll('video').forEach(v => v.pause()); box.replaceChildren();
  if (!s?.assetIds.length) { box.append(el('span', { text: '选择或上传素材后预览' })); return; }
  const node = el(s.type === 'video' ? 'video' : 'img', { src: '/media/' + s.assetIds[0], alt: '场景预览' });
  if (s.type === 'video') { node.muted = true; node.loop = true; node.playsInline = true; node.autoplay = true; }
  node.onerror = () => message('素材无法预览，请替换文件。视频需为 H.264 MP4。', true);
  box.append(node); updateTransform();
}
function updateTransform() {
  const s = scene(); if (!s) return; const t = s.transform;
  $('#scaleValue').textContent = Math.round(t.scale * 100) + '%';
  const node = $('#preview').firstElementChild;
  if (node && ['IMG', 'VIDEO'].includes(node.tagName)) { node.style.objectFit = t.fit; node.style.transform = `translate(${t.x}%, ${t.y}%) scale(${t.scale})`; }
}
$('#projectName').oninput = e => { project().name = e.target.value; changed(); };
$('#projectName').onchange = renderProjects;
$('#newProject').onclick = () => { const p = { id: uid(), name: '新内容项目', defaultSceneId: null, scenes: [] }; library.draft.push(p); projectId = p.id; changed(); renderProjects(); };
$('#copyProject').onclick = () => { const p = structuredClone(project()); p.id = uid(); p.name = (p.name + ' 副本').slice(0, 80); for (const s of p.scenes) { const old = s.id; s.id = uid(); if (p.defaultSceneId === old) p.defaultSceneId = s.id; } library.draft.push(p); projectId = p.id; changed(); renderProjects(); };
$('#deleteProject').onclick = () => { library.draft.splice(library.draft.indexOf(project()), 1); projectId = null; changed(); renderProjects(); };
$('#projectUp').onclick = () => { move(library.draft, project(), -1); renderProjects(); };
$('#projectDown').onclick = () => { move(library.draft, project(), 1); renderProjects(); };
$('#newScene').onclick = () => {
  const p = project();
  const s = { id: uid(), name: '新场景', label: '', type: 'image', assetIds: [], interval: 8, slideshowMode: 'manual', pauseOnManual: true, transform: { fit: 'cover', scale: 1, x: 0, y: 0 } };
  p.scenes.push(s); if (!p.defaultSceneId) p.defaultSceneId = s.id; sceneId = s.id; changed(); renderScenes();
};
$('#sceneName').oninput = e => { scene().name = e.target.value; changed(); };
$('#sceneName').onchange = renderScenes;
$('#sceneLabel').oninput = e => { scene().label = e.target.value; changed(); };
$('#sceneLabel').onchange = renderScenes;
$('#sceneType').onchange = e => {
  const s = scene(); s.type = e.target.value;
  if (s.type === 'slideshow' && !s.slideshowMode) s.slideshowMode = 'manual';
  s.assetIds = s.assetIds.filter(id => library.assets[id]?.kind === (s.type === 'video' ? 'video' : 'image'));
  if (s.type !== 'slideshow') s.assetIds = s.assetIds.slice(0, 1);
  changed(); renderEditor();
};
for (const [id, field] of [['#fit', 'fit'], ['#scale', 'scale'], ['#offsetX', 'x'], ['#offsetY', 'y']]) {
  $(id).oninput = e => { scene().transform[field] = field === 'fit' ? e.target.value : Number(e.target.value); changed(); updateTransform(); };
}
$('#interval').oninput = e => { scene().interval = Number(e.target.value); changed(); };
$('#slideshowMode').onchange = e => { scene().slideshowMode = e.target.value; changed(); renderEditor(); };
$('#pauseOnManual').onchange = e => { scene().pauseOnManual = e.target.value === 'pause'; changed(); };
$('#resetTransform').onclick = () => { scene().transform = { fit: 'cover', scale: 1, x: 0, y: 0 }; changed(); renderEditor(); };
let drag;
$('#preview').onpointerdown = e => { if (!scene()) return; const t = scene().transform; drag = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }; e.currentTarget.setPointerCapture(e.pointerId); };
$('#preview').onpointermove = e => {
  if (!drag || !scene()) return; const b = e.currentTarget.getBoundingClientRect(); const t = scene().transform;
  t.x = Math.round(Math.max(-100, Math.min(100, drag.tx + (e.clientX - drag.x) / b.width * 100)) * 10) / 10;
  t.y = Math.round(Math.max(-100, Math.min(100, drag.ty + (e.clientY - drag.y) / b.height * 100)) * 10) / 10;
  $('#offsetX').value = t.x; $('#offsetY').value = t.y; changed(); updateTransform();
};
$('#preview').onpointerup = $('#preview').onpointercancel = () => { drag = null; };
$('#upload').onchange = async e => {
  const files = [...e.target.files]; const target = scene(); e.target.disabled = true;
  try {
    for (const [i, file] of files.entries()) {
      if (file.size > 512 * 1024 * 1024) throw new Error(`${file.name} 超过 512 MB`);
      $('#uploadStatus').textContent = `正在上传 ${i + 1}/${files.length}：${file.name}`;
      const a = await api('/api/admin/upload', { method: 'POST', body: file, headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } });
      library.assets[a.id] = a;
      if (target && library.draft.some(p => p.scenes.includes(target)) && a.kind === (target.type === 'video' ? 'video' : 'image')) { target.assetIds = target.type === 'slideshow' ? [...target.assetIds, a.id] : [a.id]; changed(); }
    }
    $('#uploadStatus').textContent = '上传完成 · 已复制到本机'; renderAssets(); renderPreview();
  } catch (e) { message(e.message, true); $('#uploadStatus').textContent = '上传失败，请重试'; }
  finally { $('#upload').disabled = false; $('#upload').value = ''; }
};
async function save() {
  const version = editVersion;
  const result = await api('/api/admin/draft', { method: 'PUT', body: { revision: library.draftRevision, projects: structuredClone(library.draft) } });
  library.draftRevision = result.draftRevision; library.hasUnpublishedChanges = result.hasUnpublishedChanges; dirty = editVersion !== version; status();
}
async function saveAction(publish) {
  if (saving) return; saving = true; saveError = ''; status(); $('#save').disabled = $('#publish').disabled = $('#reload').disabled = true;
  let draftSaved = false;
  try { await save(); draftSaved = true; if (publish) { const result = await api('/api/admin/publish', { method: 'POST', body: { revision: library.draftRevision } }); library.revision = result.revision; library.hasUnpublishedChanges = result.hasUnpublishedChanges; message('项目已发布。LED 保持当前画面，主播点击场景后切换。'); } else message(dirty ? '本次草稿已保存，仍有后续修改未保存。' : '草稿已保存'); }
  catch (e) { saveError = draftSaved ? `草稿已保存，发布失败：${e.message}` : `保存失败：${e.message}。请重试，修改仍保留在页面。`; message(e.message, true); }
  finally { saving = false; $('#save').disabled = $('#publish').disabled = $('#reload').disabled = false; status(); }
}
$('#save').onclick = () => saveAction(false); $('#publish').onclick = () => saveAction(true);
$('#saveScene').onclick = () => saveAction(false);
async function loadLibrary() {
  library = await api('/api/admin/library'); dirty = false; saveError = ''; status(); renderProjects();
}
$('#reload').onclick = () => { if (!dirty || confirm('重新载入将放弃当前页面未保存的修改。继续？')) action(loadLibrary); };
async function loadSystem() {
  if (systemLoading) return systemLoading;
  const fields = ['#afterPairingView', '#defaultProject', '#startupSettings button'].map(selector => $(selector));
  fields.forEach(field => { field.disabled = true; });
  systemLoading = readSystem().finally(() => { fields.forEach(field => { field.disabled = false; }); systemLoading = null; });
  return systemLoading;
}
async function readSystem() {
  const networkVersion = networkNameVersion;
  system = await api('/api/admin/system');
  $('#platformNote').textContent = system.preview ? '当前是窗口式预览，不占用真实外接屏。' : system.platform === 'darwin' ? '请在 macOS「系统设置 → 显示器」中设为扩展显示器，关闭镜像。绑定后仅向所选屏幕输出。' : '请在 Windows 显示设置中使用“扩展这些显示器”。';
  $('#displaySelect').replaceChildren(...system.displays.map(d => {
    const option = el('option', { value: d.id, text: `${d.label} · ${d.bounds.width} × ${d.bounds.height}${d.primary ? '（运营主屏，不可选）' : d.internal ? '（内置屏，不可选）' : ''}` }); option.disabled = d.primary || d.internal; option.selected = d.id === system.settings.display?.id; return option;
  }));
  $('#bindDisplay').disabled = !system.displays.some(d => !d.primary && !d.internal);
  const loginRequested = system.autoStartStatus && system.autoStartStatus.status !== 'unsupported' && system.autoStartStatus.status !== 'unavailable' ? system.autoStartStatus.requested : system.settings.autoStart;
  system.settings.autoStart = loginRequested;
  $('#autoStart').disabled = !system.autoStartSupported; $('#autoStart').textContent = loginRequested ? '关闭登录自启' : '开启登录自启';
  $('#autoStartStatus').textContent = system.autoStartStatus?.message || '';
  $('#autoStartNote').textContent = system.platform === 'darwin' ? '手动打开仍显示管理窗口。先将软件拖入「应用程序」；系统可能要求在「登录项与扩展」批准。尚未公证的测试包自启可能不生效，请以系统状态为准。' : '手动打开软件仍显示管理窗口。Windows 自动登录、扩展显示和电源设置需自行配置。';
  $('#silentAutoStart').checked = system.settings.silentAutoStart;
  $('#silentAutoStart').disabled = !system.autoStartSupported;
  $('#previewTools').hidden = !system.preview || !window.livescreenDesktop;
  $('#toggleOutput').textContent = system.settings.outputPaused ? '恢复大屏输出' : '暂停大屏输出';
  renderConnections(system);
  const size=system.outputSize, ratio=size?.width>0 && size?.height>0 ? size.width/size.height : 16/9;
  document.documentElement.style.setProperty('--output-ratio',ratio);
  $('#preview').style.aspectRatio=String(ratio);
  $('#previewCaption').textContent=(size ? `${size.width} × ${size.height}${size.preview ? ' 模拟大屏' : ' 输出比例'}预览` : '16:9 参考预览（未绑定大屏）')+' · 拖动画面定位，右侧调整缩放';
  if (!networkNameDirty && networkVersion === networkNameVersion) $('#phoneNetworkName').value = system.phoneNetworkName || '';
  $('#transitionEnabled').checked = system.settings.transition.enabled;
  $('#transitionDuration').value = String(system.settings.transition.durationMs);
  $('#transitionDuration').disabled = !$('#transitionEnabled').checked;
  $('#afterPairingView').value = system.settings.afterPairingView;
  const published = liveState?.projects || library.published;
  $('#defaultProject').replaceChildren(el('option', { value: '', text: '第一个已发布项目' }), ...published.map(p => el('option', { value: p.id, text: p.name })));
  $('#defaultProject').value = system.settings.defaultProjectId || '';
  $('#dataRoot').textContent = system.dataRoot;
}
function renderConnections(info) {
  $('#pairAddresses').replaceChildren(...info.connections.map(c => el('figure', { className: 'connection-qr' }, [el('img', { src: c.qr, alt: '扫码打开 ' + c.url }), el('figcaption', { text: `${c.label || c.name} · ${c.url}` })])));
  const errors = info.network?.errors || [];
  $('#networkStatus').textContent = `${info.phoneNetworkName && !info.connections.some(c => c.kind === 'wifi' && c.ssid) ? `手机连接网络：${info.phoneNetworkName}（运营填写）。` : ''}` + `${info.addresses.length ? `已监听 ${info.addresses.length} 个内网地址，端口 ${info.network?.port || info.settings?.port}。` : '未发现可用内网监听地址，请连接网络后刷新。'} 网络变化后每 5 秒自动更新；此状态不代表手机已连通。`;
  $('#networkErrors').textContent = errors.map(e => `${e.name}（${e.address}）：监听失败 ${e.code}`).join('；');
  $('#networkErrors').hidden = !errors.length;
}
document.addEventListener('livescreen-network-changed', () => {
  if (!$('#admin').hidden) api('/api/admin/system').then(renderConnections).catch(e => LS.feedback('#networkStatus', e.message, true));
});
function showTab(tab) {
  for (const [name, panel] of [['Library', 'libraryPanel'], ['Playback', 'playbackPanel'], ['System', 'systemPanel']]) {
    $('#' + panel).hidden = tab !== name; $('#tab' + name).setAttribute('aria-pressed', String(tab === name));
  }
}
$('#tabSystem').onclick = () => { showTab('System'); action(() => Promise.all([loadSystem(), loadPairing()])); };
$('#tabLibrary').onclick = () => showTab('Library');
$('#tabPlayback').onclick = () => { showTab('Playback'); renderLocalPlayback(); };
$('#playbackProject').onchange = e => { localProjectId = e.target.value; renderLocalPlayback(); };
function renderLocalPlayback() {
  if (!liveState) return;
  const projects = liveState.projects;
  if (!projects.some(p => p.id === localProjectId)) localProjectId = projects[0]?.id;
  const select = $('#playbackProject');
  const key = JSON.stringify(projects.map(p => [p.id, p.name]));
  if (select.dataset.catalog !== key) { select.dataset.catalog = key; select.replaceChildren(...projects.map(p => el('option', { value: p.id, text: p.name }))); }
  select.value = localProjectId || '';
  const project = projects.find(p => p.id === localProjectId);
  const root = $('#localScenes');
  const catalog = JSON.stringify(project || null);
  if (root.dataset.catalog !== catalog) {
    root.dataset.catalog = catalog;
    root.replaceChildren(...(project?.scenes || []).map(scene => el('button', { className: 'scene-card', 'data-scene-id': scene.id, 'aria-label': '播放 ' + scene.name, onClick: () => playLocal(project.id, scene.id) },
      [sceneThumbnail(scene), el('strong', { text: scene.name }), ...(scene.label ? [el('small', { className: 'scene-label', text: scene.label })] : []), el('small', { className: 'play-status' })])));
  }
  root.querySelectorAll('.scene-card').forEach(button => {
    const current = !liveState.current?.isTest && liveState.current?.projectId === project.id && liveState.current?.sceneId === button.dataset.sceneId;
    button.setAttribute('aria-pressed', String(current));
    button.querySelector('.play-status').textContent = current ? '✓ 正在播放' : '点击播放';
    const busy = liveState.busy && !(window.livescreenDesktop && liveState.control?.busySource !== 'local');
    button.disabled = !desktopOnline || localRequesting || busy || !liveState.output.connected || (!nativeUI && liveState.control?.localActive);
  });
  LS.renderPages($('#localPageControls'), liveState, turnLocalPage, desktopOnline && !localRequesting, !!window.livescreenDesktop, true, setLocalSlideshow);
}
async function setLocalSlideshow(playbackId, paused) {
  localRequesting = true; renderLocalPlayback();
  try { await api('/api/slideshow', { method: 'POST', body: { playbackId, paused, controlGeneration: liveState.control.generation } }); LS.feedback('#localPlaybackFeedback', paused ? '已暂停自动轮播' : '已继续自动轮播'); }
  catch (error) { LS.feedback('#localPlaybackFeedback', error.message, true); }
  finally { localRequesting = false; renderLocalPlayback(); }
}
function sceneThumbnail(scene) {
  const box = el('span', { className: 'thumb local-thumb', 'aria-hidden': 'true' });
  const id = scene.assetIds?.[0];
  if (!id) { box.append(el('small', { text: '暂无素材' })); return box; }
  const media = el(scene.type === 'video' ? 'video' : 'img', { src: '/media/' + id, ...(scene.type === 'video' ? { preload: 'metadata', muted: '', playsinline: '' } : { loading: 'lazy', alt: '' }) });
  if (scene.type === 'video') {
    media.muted = true;
    media.addEventListener('loadedmetadata', () => { if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = Math.min(.1, media.duration / 2); }, { once: true });
  }
  const t = scene.transform || { fit: 'cover', scale: 1, x: 0, y: 0 };
  media.style.objectFit = t.fit; media.style.transform = `translate(${t.x}%,${t.y}%) scale(${t.scale})`;
  media.onerror = () => { media.remove(); box.prepend(el('small', { text: '预览不可用' })); };
  box.append(media, el('span', { className: 'thumb-kind', text: scene.type === 'slideshow' ? `多图 · ${scene.assetIds.length} 张` : scene.type === 'video' ? '视频' : '图片' }));
  return box;
}
async function playLocal(projectId, sceneId) {
  localRequesting = true; renderLocalPlayback(); LS.feedback('#localPlaybackFeedback', '正在准备播放…');
  try { await api('/api/switch', { method: 'POST', body: { projectId, sceneId, controlGeneration: liveState.control.generation } }); LS.feedback('#localPlaybackFeedback', '大屏已完成切换'); }
  catch (error) { LS.feedback('#localPlaybackFeedback', error.message, true); }
  finally { localRequesting = false; renderLocalPlayback(); }
}
async function turnLocalPage(playbackId, direction) {
  localRequesting = true; renderLocalPlayback();
  try { await api('/api/page', { method: 'POST', body: { playbackId, ...(typeof direction === 'number' ? { index: direction } : { direction }), controlGeneration: liveState.control.generation } }); LS.feedback('#localPlaybackFeedback', typeof direction === 'number' ? `大屏已跳到第 ${direction + 1} 张` : '大屏已翻页'); }
  catch (error) { LS.feedback('#localPlaybackFeedback', error.message, true); }
  finally { localRequesting = false; renderLocalPlayback(); }
}
$('#refreshSystem').onclick = () => action(async () => { await api('/api/admin/network/refresh', { method: 'POST' }); await loadSystem(); message('网络与设备已刷新，请使用当前二维码。'); });
$('#phoneNetworkName').oninput = () => { networkNameDirty = true; networkNameVersion++; };
$('#networkHintForm').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
  try {
    const version = networkNameVersion, name = $('#phoneNetworkName').value;
    await api('/api/admin/network/hint', { method: 'POST', body: { name } });
    if (version === networkNameVersion) networkNameDirty = false;
    LS.feedback('#networkHintFeedback', version === networkNameVersion ? '已保存；未识别到 Wi-Fi 名称时使用' : '先前内容已保存；当前修改尚未保存');
    renderConnections(await api('/api/admin/system'));
  } catch (error) { LS.feedback('#networkHintFeedback', error.message, true); }
  finally { button.disabled = false; }
};
$('#refreshNetwork').onclick = $('#refreshSystem').onclick;
$('#bindDisplay').onclick = () => action(async () => { await api('/api/admin/display', { method: 'POST', body: { id: $('#displaySelect').value } }); message('LED 绑定已保存，等待显示器就绪'); await loadSystem(); });
$('#autoStart').onclick = () => action(async () => { await api('/api/admin/autostart', { method: 'POST', body: { enabled: !system.settings.autoStart, silent: $('#silentAutoStart').checked } }); await loadSystem(); });
$('#silentAutoStart').onchange = () => action(async () => { await api('/api/admin/autostart', { method: 'POST', body: { enabled: system.settings.autoStart, silent: $('#silentAutoStart').checked } }); await loadSystem(); });
$('#toggleOutput').onclick = () => action(async () => {
  const button = $('#toggleOutput'); button.disabled = true;
  try { const result = await api('/api/admin/output', { method: 'POST', body: { paused: !liveState?.output.paused } }); button.textContent = result.paused ? '恢复大屏输出' : '暂停大屏输出'; message(result.paused ? '已暂停大屏输出，可以使用会议或 PPT。项目与素材保留。' : '正在恢复已绑定的大屏；请确认显示器。'); }
  finally { button.disabled = false; }
});
$('#previewPlayer').onclick = () => action(() => window.livescreenDesktop.previewPlayer());
$('#previewPhone').onclick = () => action(() => window.livescreenDesktop.previewPhone());
$('#showGuide').onclick = async e => {
  const button = e.currentTarget; button.disabled = true;
  try { await api('/api/admin/guide', { method: 'POST' }); LS.feedback('#pairFeedback', '大屏已显示配对指南'); }
  catch (err) { LS.feedback('#pairFeedback', err.message, true); }
  finally { button.disabled = false; }
};
$('#startupSettings').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
  try { await api('/api/admin/startup', { method: 'POST', body: { afterPairingView: $('#afterPairingView').value, defaultProjectId: $('#defaultProject').value || null } }); LS.feedback('#startupFeedback', '已保存，下次开机的首台手机连接后生效'); }
  catch (err) { LS.feedback('#startupFeedback', err.message, true); }
  finally { button.disabled = false; }
};
function renderPairing() {
  if (!pairing) return;
  $('#pairCode').textContent = pairing.pin;
  const remaining = Math.max(0, Math.ceil((pairing.expiresAt - (Date.now() + pairing.offset)) / 1000));
  $('#pairCountdown').textContent = remaining ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} 后自动换码 · 配对成功立即换码` : '正在自动换码…';
}
async function loadPairing(refresh = false) {
  if (pairingBusy) { await pairingWait; return loadPairing(refresh); }
  pairingBusy = true; let done;
  pairingWait = new Promise(resolve => { done = resolve; });
  try {
    const result = await api(refresh ? '/api/admin/pairing/refresh' : '/api/admin/pairing', refresh ? { method: 'POST' } : {});
    pairing = { ...result, offset: result.serverTime - Date.now() }; renderPairing();
    $('#trustedDevices').replaceChildren(...result.devices.map(d => el('div', { className: 'device-row' }, [
      el('div', {}, [el('strong', { text: d.name }), el('small', { text: `配对于 ${new Date(d.createdAt).toLocaleString('zh-CN')}` })]),
      el('button', { text: '移除信任', className: 'danger', 'data-device-id': d.id, onClick: async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await api('/api/admin/devices/revoke', { method: 'POST', body: { id: d.id } }); LS.feedback('#devicesFeedback', '已移除，此设备需要重新配对'); await loadPairing(); }
        catch (e) { LS.feedback('#devicesFeedback', e.message, true); button.disabled = false; }
      } })
    ])));
    if (!result.devices.length) $('#trustedDevices').append(el('p', { className: 'muted', text: '还没有已信任手机。使用上方配对码连接第一台。' }));
  } finally { pairingBusy = false; done(); }
}
document.addEventListener('livescreen-pairing-changed', () => { if (!$('#admin').hidden) loadPairing().catch(e => LS.feedback('#pairFeedback', e.message, true)); });
$('#refreshPairing').onclick = async e => {
  e.currentTarget.disabled = true;
  try { await loadPairing(true); LS.feedback('#pairFeedback', '配对码已更新，已信任手机仍可自动连接'); }
  catch (err) { LS.feedback('#pairFeedback', err.message, true); }
  finally { $('#refreshPairing').disabled = false; }
};
setInterval(() => {
  renderPairing();
  if (!$('#admin').hidden && !pairingBusy && pairing && Date.now() + pairing.offset >= pairing.expiresAt) loadPairing().catch(e => LS.feedback('#pairFeedback', e.message, true));
}, 1000);
setInterval(() => { if (!$('#admin').hidden && !pairingBusy) loadPairing().catch(e => LS.feedback('#pairFeedback', e.message, true)); }, 10000);
$('#transitionEnabled').onchange = () => { $('#transitionDuration').disabled = !$('#transitionEnabled').checked; LS.feedback('#playbackFeedback', '有修改，保存后生效'); };
$('#transitionDuration').onchange = () => LS.feedback('#playbackFeedback', '有修改，保存后生效');
$('#playbackSettings').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
  LS.feedback('#playbackFeedback', '正在保存…');
  try {
    await api('/api/admin/playback', { method: 'POST', body: { enabled: $('#transitionEnabled').checked, durationMs: Number($('#transitionDuration').value) } });
    LS.feedback('#playbackFeedback', $('#transitionEnabled').checked ? '已保存：下次切换使用渐变过渡' : '已保存：下次切换直接切换');
  } catch (err) { LS.feedback('#playbackFeedback', err.message, true); }
  finally { button.disabled = false; }
};
$('#adminPassword').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('[type=submit]'); button.disabled = true;
  LS.feedback('#passwordFeedback', '正在保存…');
  try {
    await api('/api/admin/password', { method: 'POST', body: { role: 'admin', secret: new FormData(e.target).get('secret') } });
    e.target.reset(); $('#adminSecret').type = 'password';
    const toggle = e.target.querySelector('[data-password-toggle]'); toggle.textContent = '显示'; toggle.setAttribute('aria-pressed', 'false');
    LS.feedback('#passwordFeedback', '已保存。手机配对和本机管理不受影响。');
    if (!window.livescreenDesktop) { document.querySelectorAll('[data-admin-logout]').forEach(b => { b.hidden = true; }); source?.close(); $('#admin').hidden = true; $('#login').hidden = false; LS.feedback('#loginFeedback', '远程管理口令已保存，请用新口令重新登录。'); }
  } catch (err) { LS.feedback('#passwordFeedback', err.message, true); }
  finally { button.disabled = false; }
};
$('#testScene').onclick = async e => {
  e.currentTarget.disabled = true; LS.feedback('#testFeedback', '正在准备大屏测试画面…');
  try {
    await api('/api/admin/test-scene', { method: 'POST', body: { projectId: project().id, projectName: project().name, scene: scene() } });
    LS.feedback('#testFeedback', '大屏正在显示测试画面。草稿未发布。');
  } catch (err) { LS.feedback('#testFeedback', err.message, true); }
  finally { $('#testScene').disabled = false; }
};
$('#restoreScene').onclick = async e => {
  e.currentTarget.disabled = true;
  try { await api('/api/admin/test/restore', { method: 'POST' }); LS.feedback('#testFeedback', '已结束测试，恢复正式画面'); }
  catch (err) { LS.feedback('#testFeedback', err.message, true); }
  finally { $('#restoreScene').disabled = false; }
};
for (const button of document.querySelectorAll('[data-quit]')) button.onclick = () => action(async () => {
  if (dirty && !confirm('退出会放弃尚未保存的修改，是否退出软件？')) return;
  await LS.quitApp(); dirty = false; source?.close(); $('#admin').hidden = true;
  message('软件正在退出。LED 播放和手机服务将关闭，可使用 PowerPoint。');
});
for (const button of document.querySelectorAll('[data-admin-logout]')) button.onclick = () => action(async () => {
  if (dirty && !confirm('退出登录会放弃此页面尚未保存的修改，是否继续？')) return;
  await api('/api/admin/logout', { method: 'POST' }); dirty = false; source?.close();
  $('#admin').hidden = true; $('#login').hidden = false;
  document.querySelectorAll('[data-admin-logout]').forEach(b => { b.hidden = true; });
  LS.feedback('#loginFeedback', '已退出管理登录，大屏继续播放。');
});
function configureManagement() {
  document.querySelectorAll('[data-native-only]').forEach(node => { node.hidden = !nativeUI; });
  document.querySelectorAll('[data-admin-logout]').forEach(node => { node.hidden = nativeUI; });
  $('#tabPlayback').textContent = nativeUI ? '本地播放' : '大屏控制';
  $('#tabSystem').textContent = nativeUI ? '设备与连接' : '连接与设置';
  $('#playbackHeading').textContent = nativeUI ? '电脑本地播放' : '远程大屏控制';
  if (!nativeUI) {
    $('#playbackHelp').textContent = '选择已发布的场景播放到大屏，可翻页或暂停轮播。大屏电脑本机操作优先；主机暂停输出时，请在主机恢复。';
    $('#localPageControls').setAttribute('aria-label', '远程控制当前场景翻页');
  }
}
function onState(state) {
  liveState = state; renderLocalPlayback();
  $('#now').textContent = state.current ? `${state.current.isTest ? '测试画面 · ' : ''}${state.current.projectName} / ${state.current.sceneName}` : 'LED 等待就绪';
  $('#output').textContent = state.output.message + (state.busy ? ' · 正在准备下一场景' : '');
  $('#revision').textContent = state.current?.isGuide ? '配对指南' : state.current?.isTest ? '测试画面' : state.current ? '正式播放' : '等待播放';
  $('#outputNotice').hidden = !state.output.paused;
  $('#outputNoticeText').textContent = state.output.message;
  $('#toggleOutput').textContent = state.output.paused ? '恢复大屏输出' : '暂停大屏输出';
  $('#restoreScene').hidden = !state.current?.isTest;
}
async function begin() {
  await loadLibrary(); $('#login').hidden = true; $('#admin').hidden = false; configureManagement();
  $('#nativeExit').hidden = true;
  await Promise.all([loadSystem(), loadPairing()]);
  const state = await api('/api/state'); onState(state);
  source?.close(); source = connect(onState, online => { desktopOnline = online; renderLocalPlayback(); $('#connection').textContent = online ? '● 控制服务在线' : '○ 连接中断，等待恢复'; $('#connection').className = 'status ' + (online ? 'online' : 'offline'); });
}
$('#login').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('[type=submit]'); button.disabled = true; LS.feedback('#loginFeedback', '正在连接…');
  try { await api('/api/login', { method: 'POST', body: { role: 'admin', secret: new FormData(e.target).get('secret') } }); message(''); await begin(); }
  catch (err) { LS.feedback('#loginFeedback', err.message, true); }
  finally { button.disabled = false; }
};
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('livescreen-session-expired', () => {
  $('#admin').hidden = true; $('#login').hidden = false;
  document.querySelectorAll('[data-admin-logout]').forEach(b => { b.hidden = true; });
  $('#nativeExit').hidden = !window.livescreenDesktop;
  LS.feedback('#loginFeedback', '远程管理登录已过期，请重新输入口令。', true);
});
document.querySelectorAll('[data-native-only]').forEach(node => { node.hidden = !nativeUI; });
$('#nativeExit').hidden = !nativeUI;
begin().catch(e => { if (e.status !== 401) message(e.message, true); });
