'use strict';
const scenes = [
  { kicker: 'YOUR NEXT SCENE', lines: ['好内容，', '值得大一点。'], sub: '把注意力留给现场。', name: '开场背景' },
  { kicker: 'SPACE FOR THE DETAILS', lines: ['把细节，', '讲得更清楚。'], sub: '图片、视频与多图内容。', name: '内容介绍' },
  { kicker: 'SEE YOU NEXT TIME', lines: ['下一场，', '继续精彩。'], sub: '内容已就位，随时再开始。', name: '展示结束' }
];
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => {
  const index = Number(button.dataset.scene), scene = scenes[index];
  document.getElementById('demoScreen').dataset.current = String(index);
  document.getElementById('screenNumber').textContent = String(index + 1).padStart(2, '0');
  document.getElementById('posterKicker').textContent = scene.kicker;
  const title = document.getElementById('posterTitle'); title.replaceChildren(document.createTextNode(scene.lines[0]), document.createElement('br'), document.createTextNode(scene.lines[1]));
  document.getElementById('posterSub').textContent = scene.sub;
  document.getElementById('sceneName').textContent = scene.name;
  document.querySelectorAll('[data-scene]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
}));
