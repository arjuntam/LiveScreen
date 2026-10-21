'use strict';
const { api, element: el, message, connect } = LS;
let state, selectedId = null, online = false, source, requesting = false;
const $ = s => document.querySelector(s);
function network(ok) {
  online = ok; $('#connection').textContent = ok ? '● 已连接主机' : '○ 连接中断';
  $('#connection').className = 'status ' + (ok ? 'online' : 'offline'); renderCards();
  if (state) $('#liveTag').textContent = !ok ? '离线 · 最后状态' : state.busy ? '准备中' : state.current?.isGuide ? '请选择场景' : state.current?.isTest ? '电脑测试画面' : state.current && state.output.connected ? '正在播放' : '待就绪';
}
function render(next) {
  state = next;
  $('#now').textContent = state.current?.sceneName || state.output.message;
  $('#nowProject').textContent = state.current?.projectName || '请联系运营检查输出屏幕';
  $('#liveTag').textContent = state.busy ? '准备中' : state.current?.isGuide ? '请选择场景' : state.current?.isTest ? '电脑测试画面' : state.current && state.output.connected ? '正在播放' : '待就绪';
  if (state.error) message(state.error, true);
  renderCards();
}
function renderCards() {
  if (!state) return;
  const localActive = !!state.control?.localActive;
  $('#controlPriority').hidden = !localActive;
  LS.renderPages($('#pageControls'), state, turnPage, online && !requesting && !localActive, false, false, setSlideshow);
  const p = state.projects.find(p => p.id === selectedId);
  if (!p) selectedId = null;
  $('#title').textContent = p ? p.name : '选择内容项目'; $('#back').hidden = !p;
  $('#hint').textContent = p ? '点一个场景，切换 LED 背景。' : '先选项目，再点场景。';
  const items = p ? p.scenes.map((s, i) => {
    const current = !state.current?.isTest && state.current?.projectId === p.id && state.current?.sceneId === s.id;
    const thumb = el('div', { className: 'thumb' }, s.type === 'video' ? [el('span', { text: '▶ 静音循环' })] : [el('img', { src: '/media/' + s.assetIds[0], alt: '', loading: 'lazy' })]);
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    const button = el('button', { className: 'scene-card', 'aria-pressed': String(current), onClick: () => switchScene(p.id, s.id) }, [thumb, el('strong', { text: s.name }), ...(label ? [el('small', { className: 'scene-label', text: label })] : []), el('small', { text: current ? '✓ 当前播放' : `场景 ${String(i + 1).padStart(2, '0')}` })]);
    button.disabled = !online || state.busy || requesting || localActive; return button;
  }) : state.projects.map((p, i) => el('button', { className: 'project-card', onClick: () => { selectedId = p.id; renderCards(); } }, [el('small', { text: '项目 ' + String(i + 1).padStart(2, '0') }), el('strong', { text: p.name }), el('small', { text: `${p.scenes.length} 个场景${state.current?.projectId === p.id ? ' · 当前内容项目' : ''} →` })]));
  $('#cards').replaceChildren(...(items.length ? items : [el('p', { className: 'empty', text: '暂无已发布场景，请联系运营发布项目。' })]));
}
async function setSlideshow(playbackId, paused) {
  requesting = true; renderCards();
  try { await api('/api/slideshow', { method: 'POST', body: { playbackId, paused, controlGeneration: state.control.generation } }); message(paused ? '已暂停自动轮播' : '已继续自动轮播'); }
  catch (error) { message(error.message, true); }
  finally { requesting = false; renderCards(); }
}
async function switchScene(projectId, sceneId) {
  requesting = true; renderCards(); message('正在准备场景，完成后更新播放状态…');
  try { await api('/api/switch', { method: 'POST', body: { projectId, sceneId, controlGeneration: state.control.generation } }); message('LED 已完成切换'); }
  catch (e) { message(e.message, true); }
  finally { requesting = false; renderCards(); }
}
async function turnPage(playbackId, direction) {
  requesting = true; renderCards();
  try { await api('/api/page', { method: 'POST', body: { playbackId, direction, controlGeneration: state.control.generation } }); message('大屏已翻页'); }
  catch (error) { message(error.message, true); }
  finally { requesting = false; renderCards(); }
}
async function begin(paired = false) {
  try {
    const next = await api('/api/state'); $('#login').hidden = true; $('#remote').hidden = false; network(true); render(next);
    message(paired ? '配对成功，已记住此浏览器，下次自动连接。' : '已自动连接大屏');
    source?.close(); source = connect(render, network);
  } catch (e) { if (e.status !== 401) message(e.message, true); }
}
$('#login').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
  LS.feedback('#pairStatus', '正在配对…');
  try { await api('/api/pair', { method: 'POST', body: { pin: new FormData(e.target).get('pin').trim() } }); e.target.reset(); await begin(true); }
  catch (e) { LS.feedback('#pairStatus', e.message, true); } finally { button.disabled = false; }
};
$('#back').onclick = () => { selectedId = null; renderCards(); };
$('#logout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); source?.close(); location.reload(); } catch (e) { message(e.message, true); } };
window.addEventListener('offline', () => network(false));
document.addEventListener('livescreen-session-expired', () => {
  $('#remote').hidden = true; $('#login').hidden = false;
  LS.feedback('#pairStatus', '此浏览器尚未配对或信任已取消，请输入电脑上的最新配对码。', true);
});
begin();
