'use strict';
window.LS = {
  async api(url, options = {}) {
    const headers = { 'X-LiveScreen': '1', ...options.headers };
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof Blob)) { options.body = JSON.stringify(options.body); headers['Content-Type'] = 'application/json'; }
    let response, data;
    const controller = new AbortController();
    const timeout = url.includes('/upload') ? 120000 : /switch|test-scene|test\/restore/.test(url) ? 30000 : 8000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try { response = await fetch(url, { ...options, headers, signal: controller.signal }); data = await response.json(); }
    catch { throw new Error(controller.signal.aborted ? '连接超时，请检查手机 Wi-Fi、电脑地址，以及两个网络是否互通。' : '连接中断，请检查 Wi-Fi 和电脑地址；LED 会继续播放本地内容'); }
    finally { clearTimeout(timer); }
    if (!response.ok) { const e = new Error(data.error || '操作失败'); e.status = response.status; throw e; } return data;
  },
  element(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'text') el.textContent = value;
      else if (key === 'className') el.className = value;
      else el.setAttribute(key, value);
    }
    el.append(...children); return el;
  },
  message(text, error = false) { const el = document.querySelector('#message'); el.textContent = text; el.classList.toggle('error', error); el.hidden = !text; },
  feedback(selector, text, error = false) {
    const el = document.querySelector(selector); if (!el) return;
    el.textContent = text; el.classList.toggle('error', error);
  },
  passwordToggles() {
    for (const button of document.querySelectorAll('[data-password-toggle]')) {
      button.onclick = () => {
        const input = document.getElementById(button.dataset.passwordToggle);
        const show = input.type === 'password'; input.type = show ? 'text' : 'password';
        button.textContent = show ? '隐藏' : '显示'; button.setAttribute('aria-pressed', String(show));
      };
    }
  },
  async quitApp() {
    if (window.livescreenDesktop) return window.livescreenDesktop.quit();
    return LS.api('/api/admin/quit', { method: 'POST' });
  },
  connect(onState, onNetwork) {
    const source = new EventSource('/api/events');
    source.addEventListener('network', () => document.dispatchEvent(new Event('livescreen-network-changed')));
    source.addEventListener('pairing', () => document.dispatchEvent(new Event('livescreen-pairing-changed')));
    source.onmessage = e => { onNetwork(true); onState(JSON.parse(e.data)); };
    source.onerror = async () => {
      onNetwork(false);
      try {
        const r = await fetch('/api/state');
        if (r.status === 401) { source.close(); document.dispatchEvent(new Event('livescreen-session-expired')); }
      } catch { /* EventSource retries when the network returns. */ }
    };
    return source;
  },
  renderPages(root, state, onTurn, online = true, allowLocalTakeover = false, showPreview = false, onPause = null) {
    const current = state?.current;
    root.hidden = !current || current.type !== 'slideshow' || current.pageCount < 2;
    if (root.hidden) { root.replaceChildren(); return; }
    if (showPreview) return LS.renderDesktopPages(root, state, onTurn, online, allowLocalTakeover, onPause);
    const previous = LS.element('button', { text: '← 上一张', onClick: () => onTurn(current.playbackId, 'previous') });
    const next = LS.element('button', { text: '下一张 →', onClick: () => onTurn(current.playbackId, 'next') });
    const busy = (state.busy && !(allowLocalTakeover && state.control?.busySource !== 'local')) || (!allowLocalTakeover && state.control?.localActive);
    previous.disabled = !online || busy || !state.output.connected || current.pageIndex === 0;
    next.disabled = !online || busy || !state.output.connected || current.pageIndex >= current.pageCount - 1;
    const controls = [previous, next];
    if (current.slideshowMode === 'auto' && current.slideshowPaused && onPause) {
      const resume = LS.element('button', { className: 'slideshow-toggle', text: '继续轮播', onClick: () => onPause(current.playbackId, false) });
      resume.disabled = !online || busy || !state.output.connected; controls.push(resume);
    }
    root.replaceChildren(LS.element('strong', { text: `第 ${current.pageIndex + 1} / ${current.pageCount} 张` }),
      LS.element('small', { text: LS.pageModeText(current) }),
      LS.element('div', { className: 'toolbar' }, controls));
  },
  pageModeText(current) {
    return current.slideshowMode === 'manual' ? '手动翻页 · 由你控制讲解节奏' : current.slideshowPaused ? '自动轮播已暂停 · 可手动翻页，或继续轮播' : current.pauseOnManual ? '自动轮播 · 手动翻页后暂停' : '自动轮播 · 手动翻页后重新计时';
  },
  renderDesktopPages(root, state, onTurn, online, allowLocalTakeover, onPause) {
    const current = state.current;
    root.classList.add('with-preview', 'with-gallery');
    if (root.dataset.playbackId !== current.playbackId || !root.querySelector('.page-thumbnails')) {
      root.dataset.playbackId = current.playbackId;
      const previous = LS.element('button', { text: '← 上一张', onClick: () => onTurn(current.playbackId, 'previous') });
      const next = LS.element('button', { text: '下一张 →', onClick: () => onTurn(current.playbackId, 'next') });
      const toggle = LS.element('button', { className: 'slideshow-toggle', text: '暂停自动轮播', onClick: event => onPause(current.playbackId, event.currentTarget.dataset.paused !== 'true') });
      const thumbnails = (current.preview?.assetIds || []).map((assetId, index) => {
        const image = LS.element('img', { src: '/media/' + encodeURIComponent(assetId), alt: `第 ${index + 1} 张图片`, loading: 'lazy' });
        const feedback = LS.element('span', { className: 'page-thumbnail-feedback', text: '正在加载…' });
        image.onload = () => { feedback.hidden = true; };
        image.onerror = () => { image.hidden = true; feedback.hidden = false; feedback.textContent = '预览不可用'; };
        return LS.element('button', { className: 'page-thumbnail', 'data-page-index': index, 'aria-label': `跳到第 ${index + 1} 张`, onClick: () => onTurn(current.playbackId, index) }, [
          LS.element('span', { className: 'page-thumbnail-image' }, [image, feedback]), LS.element('span', { className: 'page-thumbnail-caption' })
        ]);
      });
      root.replaceChildren(LS.element('div', { className: 'page-gallery-header' }, [
        LS.element('div', { className: 'page-info' }, [LS.element('strong'), LS.element('small')]),
        LS.element('div', { className: 'toolbar page-navigation' }, [previous, next, toggle])
      ]), LS.element('div', { className: 'page-thumbnails', 'aria-label': '全部轮播图片，点击可跳转' }, thumbnails));
    }
    root.querySelector('strong').textContent = `第 ${current.pageIndex + 1} / ${current.pageCount} 张`;
    root.querySelector('.page-info small').textContent = LS.pageModeText(current) + ' · 点击下方图片可跳转';
    const busy = (state.busy && !(allowLocalTakeover && state.control?.busySource !== 'local')) || (!allowLocalTakeover && state.control?.localActive);
    const blocked = !online || busy || !state.output.connected;
    const buttons = root.querySelectorAll('.page-navigation button');
    buttons[0].disabled = blocked || current.pageIndex === 0;
    buttons[1].disabled = blocked || current.pageIndex >= current.pageCount - 1;
    buttons[2].hidden = current.slideshowMode !== 'auto' || !onPause;
    buttons[2].dataset.paused = String(!!current.slideshowPaused);
    buttons[2].textContent = current.slideshowPaused ? '继续自动轮播' : '暂停自动轮播';
    buttons[2].disabled = blocked;
    const t = current.preview?.transform || { fit: 'cover', x: 0, y: 0, scale: 1 };
    root.querySelectorAll('.page-thumbnail').forEach((button, index) => {
      const selected = index === current.pageIndex;
      button.setAttribute('aria-pressed', String(selected)); button.disabled = blocked;
      button.querySelector('.page-thumbnail-caption').textContent = `第 ${index + 1} 张${selected ? ' · 正在播放' : ''}`;
      const image = button.querySelector('img');
      image.style.objectFit = t.fit; image.style.transform = `translate(${t.x}%,${t.y}%) scale(${t.scale})`;
    });
  },
  type(type) { return { image: '单图片', video: '静音循环视频', slideshow: '多张图片' }[type]; }
};
