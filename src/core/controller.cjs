'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { AppError, sceneIn } = require('./library.cjs');
class Controller extends EventEmitter {
  constructor(store, player) {
    super(); this.store = store; this.player = player;
    this.current = null; this.busy = false; this.error = null;
    this.phoneSeen = false; this.autoPending = false; this.started = false; this.activeScene = null; this.recovery = null;
    this.operation = null; this.localPriorityUntil = 0; this.priorityTimer = null;
    this.controlGeneration = 0;
    this.output = { connected: false, message: '请先选择 LED 扩展显示器' };
  }
  snapshot() {
    const current = this.current?.type === 'slideshow' && this.activeScene ? {
      ...this.current, preview: { assetId: this.activeScene.assetIds[this.current.pageIndex], assetIds: [...this.activeScene.assetIds], transform: structuredClone(this.activeScene.transform) }
    } : this.current;
    return { current, busy: this.busy, error: this.error, output: this.output,
      revision: this.store.data.revision, projects: this.store.data.published,
      control: { localActive: this.operation?.source === 'local' || Date.now() < this.localPriorityUntil, busySource: this.operation?.source || null, generation: this.controlGeneration },
      serverTime: new Date().toISOString() };
  }
  notify() { this.emit('state', this.snapshot()); }
  setOutput(output) {
    if (!!this.output.paused !== !!output.paused) { this.controlGeneration++; this.holdLocalPriority(); }
    this.output = output;
    if (output.paused && this.operation) { this.operation.cancelled = true; this.player.cancel?.(); }
    if (!output.connected) { if (this.current) this.recovery = structuredClone(this.current); this.current = null; }
    this.notify();
  }
  holdLocalPriority() {
    this.localPriorityUntil = Date.now() + 2000; clearTimeout(this.priorityTimer);
    this.priorityTimer = setTimeout(() => this.notify(), 2010); this.priorityTimer.unref?.();
  }
  beginOperation(source) {
    if (this.output.paused || this.store.settings.outputPaused) throw new AppError('LiveScreen 已暂停大屏输出，请在电脑确认显示器后恢复', 409);
    if (source === 'remote' && (this.operation?.source === 'local' || Date.now() < this.localPriorityUntil)) throw new AppError('电脑正在操作，手机控制暂时让位，请稍候再试', 409);
    if (this.operation) {
      if (source !== 'local' || this.operation.source === 'local') throw new AppError('上一个操作仍在准备，请稍后再试', 409);
      this.operation.cancelled = true; this.player.cancel?.();
    }
    const operation = { source, cancelled: false }; this.operation = operation;
    if (source === 'local') { this.controlGeneration++; this.holdLocalPriority(); }
    this.busy = true; this.error = null; this.notify(); return operation;
  }
  ensureOperation(operation) {
    if (operation.cancelled || this.operation !== operation) throw new AppError('手机指令已由电脑本地操作接管', 409);
  }
  finishOperation(operation) {
    if (this.operation !== operation) return;
    this.operation = null; this.busy = false;
    if (operation.source === 'local') this.holdLocalPriority();
    this.notify();
  }
  async switchTo(projectId, sceneId, source = 'remote') {
    this.autoPending = false;
    const { project, scene } = sceneIn(this.store.data.published, projectId, sceneId);
    const current = await this.playSelection(project, scene, false, source);
    this.beforeTest = null;
    return current;
  }
  async testScene(project, scene, source = 'remote') {
    this.autoPending = false;
    const previous = this.current?.isTest ? this.beforeTest : this.current;
    const current = await this.playSelection(project, scene, true, source);
    this.beforeTest = previous;
    return current;
  }
  async restore(source = 'remote') {
    const previous = this.beforeTest;
    if (previous?.isGuide) return this.showGuide(false, source);
    if (previous) {
      try { sceneIn(this.store.data.published, previous.projectId, previous.sceneId); }
      catch { return this.playConfiguredScene(source); }
      return this.switchTo(previous.projectId, previous.sceneId, source);
    }
    return this.showGuide(false, source);
  }
  async showGuide(forStartup = false, source = 'remote') {
    if (!forStartup) this.autoPending = false;
    const operation = this.beginOperation(forStartup ? 'automatic' : source);
    try {
      await this.player.guide();
      this.ensureOperation(operation);
      this.current = { isGuide: true, isTest: false, projectId: null, sceneId: null,
        projectName: '手机连接指引', sceneName: '手机配对指南', since: new Date().toISOString() };
      this.activeScene = null;
      this.beforeTest = null; this.store.log('guide-shown'); return this.current;
    } catch (e) { if (operation.cancelled) throw new AppError('手机指令已由电脑本地操作接管', 409); this.error = e.message; throw new AppError(e.message, e.status || 503); }
    finally { this.finishOperation(operation); }
  }
  async playSelection(project, scene, isTest, source = 'remote') {
    const projectId = project.id; const sceneId = scene.id;
    // Validate file presence again even when a scene was published hours ago.
    for (const aid of scene.assetIds) {
      if (!require('node:fs').existsSync(this.store.assetPath(aid))) throw new AppError('素材丢失，已保留原画面', 422);
    }
    const operation = this.beginOperation(source);
    try {
      const playbackId = randomUUID();
      await this.player.play({ ...structuredClone(scene), playbackId });
      this.ensureOperation(operation);
      this.activeScene = structuredClone(scene);
      this.current = { projectId, sceneId, projectName: project.name, sceneName: scene.name, type: scene.type, isTest,
        playbackId, pageIndex: 0, pageCount: scene.assetIds.length, slideshowMode: scene.slideshowMode || 'auto', slideshowPaused: false, pauseOnManual: !!scene.pauseOnManual, since: new Date().toISOString() };
      this.autoPending = false;
      try { if (!isTest) this.store.saveSettings({ lastProjectId: projectId, lastPlayback: { projectId, sceneId } }); }
      catch { this.error = '画面已切换，但项目记忆写入失败，请检查磁盘'; }
      this.store.log(isTest ? 'scene-tested' : 'scene-committed', { projectId, sceneId });
      return this.current;
    } catch (e) {
      if (operation.cancelled) throw new AppError('手机指令已由电脑本地操作接管', 409);
      this.error = e.message; this.store.log('scene-failed', { projectId, sceneId, error: e.message });
      throw new AppError(e.message, e.status || 503);
    } finally { this.finishOperation(operation); }
  }
  async startup() {
    if (this.started && this.recovery && !this.recovery.isGuide) {
      const previous = this.recovery; this.recovery = null;
      try { return await this.switchTo(previous.projectId, previous.sceneId, 'automatic'); }
      catch { /* Deleted/unusable content falls back to the guide. */ }
    }
    this.started = true;
    await this.showGuide(true);
    return this.maybePlayAfterConnection();
  }
  async phoneConnected() {
    if (this.phoneSeen) return;
    this.phoneSeen = true;
    this.autoPending = !this.current || this.current.isGuide;
    return this.maybePlayAfterConnection();
  }
  async maybePlayAfterConnection() {
    if (!this.autoPending || this.busy || !this.output.connected || !this.current?.isGuide) return;
    this.autoPending = false;
    try { await this.playConfiguredScene(); }
    catch (error) { if (error.status === 409) return; this.error = '手机已连接，但自动播放失败：' + error.message + '。请手动选择可用场景。'; this.notify(); }
  }
  async playConfiguredScene(source = 'automatic') {
    const projects = this.store.data.published;
    const saved = this.store.settings.lastPlayback;
    if (this.store.settings.afterPairingView === 'last-scene' && saved) {
      try { sceneIn(projects, saved.projectId, saved.sceneId); return await this.switchTo(saved.projectId, saved.sceneId, source); }
      catch { /* Removed or missing last content falls back to the configured default. */ }
    }
    const project = projects.find(p => p.id === this.store.settings.defaultProjectId) || projects[0];
    if (project) return this.switchTo(project.id, project.defaultSceneId, source);
  }
  async turnPage(playbackId, direction, source = 'remote') {
    if (!this.output.connected || !this.current || this.current.type !== 'slideshow') throw new AppError('当前没有可翻页的多图场景', 409);
    if (playbackId !== this.current.playbackId) throw new AppError('播放场景已变化，请稍后再翻页', 409);
    const direct = typeof direction === 'number';
    if (direct ? !Number.isInteger(direction) || direction < 0 || direction >= this.current.pageCount : !['previous', 'next'].includes(direction)) throw new AppError('翻页方向或目标页码无效');
    const index = direct ? direction : Math.max(0, Math.min(this.current.pageCount - 1, this.current.pageIndex + (direction === 'next' ? 1 : -1)));
    const paused = !!this.current.slideshowPaused || (this.current.slideshowMode === 'auto' && !!this.activeScene.pauseOnManual);
    const operation = this.beginOperation(source);
    if (index === this.current.pageIndex && paused === !!this.current.slideshowPaused) { this.finishOperation(operation); return this.current; }
    try {
      await this.player.page(index, playbackId, paused);
      this.ensureOperation(operation);
      this.current.pageIndex = index; this.current.slideshowPaused = paused; return this.current;
    } catch (error) { if (operation.cancelled) throw new AppError('手机指令已由电脑本地操作接管', 409); this.error = error.message; throw new AppError(error.message, error.status || 503); }
    finally { this.finishOperation(operation); }
  }
  async setSlideshowPaused(playbackId, paused, source = 'remote') {
    if (!this.output.connected || this.current?.type !== 'slideshow' || this.current.slideshowMode !== 'auto' || playbackId !== this.current.playbackId) throw new AppError('当前自动轮播场景已变化，请刷新后重试', 409);
    if (typeof paused !== 'boolean') throw new AppError('轮播暂停设置无效');
    const operation = this.beginOperation(source);
    try {
      const result = await this.player.setSlideshowPaused(paused, playbackId);
      this.ensureOperation(operation);
      this.current.slideshowPaused = paused;
      if (Number.isInteger(result?.pageIndex) && result.pageIndex >= 0 && result.pageIndex < this.current.pageCount) this.current.pageIndex = result.pageIndex;
      return this.current;
    } catch (error) { if (operation.cancelled) throw new AppError('手机指令已由电脑本地操作接管', 409); this.error = error.message; throw new AppError(error.message, error.status || 503); }
    finally { this.finishOperation(operation); }
  }
  pageChanged({ playbackId, pageIndex }) {
    if (!this.current || playbackId !== this.current.playbackId || this.current.type !== 'slideshow' || this.busy) return;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.current.pageCount) return;
    this.current.pageIndex = pageIndex; this.notify();
  }
}
module.exports = { Controller };
