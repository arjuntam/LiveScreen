'use strict';
const stage = document.querySelector('#stage');
let active = null; let pending = null; let pendingPage = null;
function updateGuide(info, root = stage) {
  root.querySelectorAll('[data-guide-code]').forEach(n => { n.textContent = info.pin; });
  root.querySelectorAll('[data-guide-expiry]').forEach(n => {
    const seconds = Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 1000));
    n.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后换码 · 配对成功后立即换码`;
  });
  root.querySelectorAll('[data-guide-mode]').forEach(n => { n.textContent = info.isPreview ? '开发预览 · 手机配对指南' : '手机配对指南'; });
  const wifi = info.connections.filter(c => c.kind === 'wifi' && c.ssid);
  const names = [...new Set(wifi.map(c => c.ssid))];
  const hint = names.length ? '' : info.phoneNetworkName;
  const hasWifi = info.connections.some(c => c.kind === 'wifi');
  const ethernet = !hasWifi && info.connections.some(c => c.kind === 'ethernet');
  const title = hint ? '手机请连接以下网络' : hasWifi ? '手机请连接电脑所在的 Wi-Fi' : ethernet ? '电脑当前使用有线连接' : '连接与电脑互通的网络';
  const name = hint || (names.length > 1 ? '选择右侧的 Wi-Fi 网络' : names[0]) || (ethernet ? '以太网' : info.connections.some(c => c.kind === 'wifi') ? 'Wi-Fi 名称暂不可读' : '局域网');
  const detail = hint ? '由管理人员填写的手机连接网络' : names.length ? '已自动识别电脑当前连接的无线网络；优先使用右侧 Wi-Fi 地址' : hasWifi ? '系统暂未提供 Wi-Fi 名称，可在电脑管理页填写；有线地址作为备用' : ethernet ? '手机请连接同一路由器的 Wi-Fi；网络名称可在电脑管理页填写' : '可在电脑管理页填写手机应连接的网络名称';
  root.querySelectorAll('[data-guide-network-title]').forEach(n => { n.textContent = title; });
  root.querySelectorAll('[data-guide-network-name]').forEach(n => { n.textContent = name; });
  root.querySelectorAll('[data-guide-network-detail]').forEach(n => { n.textContent = detail; });
  root.querySelectorAll('[data-guide-connections]').forEach(box => {
    const urls = JSON.stringify(info.connections.map(c => [c.url, c.label]));
    if (box.dataset.urls === urls) return; box.dataset.urls = urls; box.replaceChildren();
    const ordered = [...info.connections].sort((a, b) => ({ wifi: 0, ethernet: 1, other: 2 }[a.kind] ?? 3) - ({ wifi: 0, ethernet: 1, other: 2 }[b.kind] ?? 3));
    for (const connection of ordered.slice(0, 4)) {
      const img = document.createElement('img'); img.className = 'guide-qr'; img.src = connection.qr; img.alt = '扫码打开 ' + connection.url;
      const address = document.createElement('span'); address.className = 'guide-address'; address.textContent = connection.url;
      const label = document.createElement('span'); label.className = 'guide-network-label'; label.textContent = connection.label || connection.name;
      const card = document.createElement('div'); card.className = 'guide-connection-card'; card.append(label, img, address); box.append(card);
    }
    if (!info.connections.length) { const p = document.createElement('p'); p.textContent = '未发现可用内网地址，请连接 Wi-Fi 或网线后稍候，二维码会自动更新。'; box.append(p); }
    if (ordered.length > 4) { const note = document.createElement('small'); note.className = 'guide-more'; note.textContent = `其余 ${ordered.length - 4} 个地址请在电脑管理页查看`; box.append(note); }
    box.classList.toggle('many', info.connections.length > 1);
  });
}
window.led.onGuideInfo(info => updateGuide(info));
function release(scene) {
  if (!scene) return;
  clearInterval(scene.timer); scene.cancelled = true;
  scene.root.getAnimations().forEach(a => a.cancel());
  scene.root.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
  scene.root.remove();
}
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function startPageTimer(view) {
  clearInterval(view.timer);
  if (view.media.length < 2 || view.mode === 'manual' || view.paused) return;
  view.timer = setInterval(() => showPage(view, (view.index + 1) % view.media.length), view.interval * 1000);
}
async function showPage(view, index) {
  if (active !== view || view.cancelled) return;
  const version = view.pageVersion = (view.pageVersion || 0) + 1;
  view.media[index].classList.remove('off'); view.media[view.index].classList.toggle('off', index !== view.index); view.index = index;
  await frame();
  if (active === view && !view.cancelled && version === view.pageVersion) window.led.pageChanged({ playbackId: view.playbackId, pageIndex: index });
}
window.led.onPage(async command => {
  const view = active;
  if (!view || pending || view.playbackId !== command.playbackId || !Number.isInteger(command.index) || command.index < 0 || command.index >= view.media.length) {
    window.led.result({ id: command.id, ok: false, error: '当前场景已变化或页码无效' }); return;
  }
  const task = { id: command.id, view, previousIndex: view.index, previousPaused: view.paused, cancelled: false }; pendingPage = task;
  try {
    clearInterval(view.timer); view.paused = !!command.paused; await showPage(view, command.index);
    if (task.cancelled) return;
    startPageTimer(view);
    if (active !== view) throw new Error('场景已变化');
    window.led.result({ id: command.id, ok: true });
  } catch (error) { if (!task.cancelled) window.led.result({ id: command.id, ok: false, error: error.message }); }
  finally { if (pendingPage === task) pendingPage = null; }
});
window.led.onSlideshow(async command => {
  const view = active;
  if (!view || pending || view.mode !== 'auto' || view.playbackId !== command.playbackId || typeof command.paused !== 'boolean') {
    window.led.result({ id: command.id, ok: false, error: '当前自动轮播场景已变化' }); return;
  }
  const task = { id: command.id, view, previousIndex: view.index, previousPaused: view.paused, cancelled: false }; pendingPage = task;
  try {
    clearInterval(view.timer); view.paused = command.paused; await frame();
    if (task.cancelled) return;
    if (active !== view) throw new Error('场景已变化');
    startPageTimer(view); window.led.result({ id: command.id, ok: true, pageIndex: view.index });
  } catch (error) { if (!task.cancelled) window.led.result({ id: command.id, ok: false, error: error.message }); }
  finally { if (pendingPage === task) pendingPage = null; }
});
window.led.onCancel(id => {
  if (pending?.id === id) { release(pending); pending = null; }
  if (pendingPage?.id === id) {
    const task = pendingPage; task.cancelled = true; pendingPage = null;
    if (active === task.view) { task.view.paused = task.previousPaused; void showPage(task.view, task.previousIndex); startPageTimer(task.view); }
  }
});
window.led.onPrepare(async command => {
  release(pending);
  const view = { id: command.id, cancelled: false, root: document.createElement('div'), timer: null };
  pending = view; view.root.className = 'scene'; stage.append(view.root);
  if (command.kind === 'guide') { view.root.append(document.querySelector('#guideTemplate').content.cloneNode(true)); updateGuide(command.guide, view.root); }
  const t = command.scene?.transform;
  try {
    if (command.kind === 'guide') await Promise.all([...view.root.querySelectorAll('img')].map(img => img.decode()));
    const media = await Promise.all((command.sources || []).map(async (src, index) => {
      const el = document.createElement(command.scene.type === 'video' ? 'video' : 'img');
      el.style.objectFit = t.fit;
      el.style.transform = `translate(${t.x}%, ${t.y}%) scale(${t.scale})`;
      if (index) el.classList.add('off');
      if (el.tagName === 'VIDEO') {
        el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'auto';
        await new Promise((resolve, reject) => {
          el.onloadeddata = resolve; el.onerror = () => reject(new Error('MP4 无法解码，请使用 H.264 编码'));
          el.src = src; view.root.append(el); el.load();
        });
        el.currentTime = 0;
      } else {
        el.src = src; view.root.append(el); await el.decode();
      }
      return el;
    }));
    if (view.cancelled || pending !== view) return release(view);
    await frame();
    if (view.cancelled || pending !== view) return release(view);
    if (command.deadline && Date.now() >= command.deadline) throw new Error('素材准备超时');
    for (const el of media) if (el.tagName === 'VIDEO') await el.play();
    if (view.cancelled || pending !== view) return release(view);
    // All assets are decoded while hidden. The old scene stays visible until this point.
    const old = active;
    const duration = old && command.transition?.enabled !== false ? (command.transition?.durationMs || 300) : 0;
    view.root.style.opacity = duration ? '0' : '1';
    view.root.classList.add('live');
    if (duration) {
      // Keep the opaque old frame below the incoming scene: no dark dip at the midpoint.
      const animation = view.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
      await animation.finished;
      view.root.style.opacity = '1'; animation.cancel();
    }
    if (view.cancelled || pending !== view) return release(view);
    active = view; pending = null;
    view.media = media; view.index = 0; view.playbackId = command.scene?.playbackId;
    view.mode = command.scene?.slideshowMode || 'auto'; view.interval = command.scene?.interval;
    view.paused = false;
    startPageTimer(view);
    await frame(); release(old);
    // A late error must report degraded playback, rather than pretending the state is healthy.
    media.forEach(el => { el.onerror = () => {
      if (active !== view) return;
      active = null; release(view);
      window.led.fault('播放素材发生错误，已回到安全底图，请重新选择可用场景');
    }; });
    window.led.result({ id: view.id, ok: true });
  } catch (e) {
    release(view); if (pending === view) pending = null;
    if (e.name === 'AbortError') return;
    window.led.result({ id: view.id, ok: false, error: '场景准备失败，已保留原画面：' + e.message });
  }
});
window.led.ready();
