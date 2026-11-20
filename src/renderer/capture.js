/* 框选层：只负责画矩形并把 CSS 像素坐标交回主进程，缩放换算在主进程做。 */
const shot = document.getElementById('shot');
const sel = document.getElementById('sel');
const sizeTag = document.getElementById('size');
const bar = document.getElementById('bar');
const hint = document.getElementById('hint');

let dragging = false;
let start = null;
let rect = null;
let scale = 1;

function draw() {
  if (!rect) {
    sel.style.display = 'none';
    sizeTag.style.display = 'none';
    bar.style.display = 'none';
    return;
  }
  sel.style.display = 'block';
  sel.style.left = `${rect.x}px`;
  sel.style.top = `${rect.y}px`;
  sel.style.width = `${rect.width}px`;
  sel.style.height = `${rect.height}px`;

  sizeTag.style.display = 'block';
  sizeTag.textContent = `${Math.round(rect.width * scale)} × ${Math.round(rect.height * scale)}`;
  sizeTag.style.left = `${Math.min(window.innerWidth - 120, rect.x)}px`;
  sizeTag.style.top = `${Math.max(6, rect.y - 24)}px`;

  /* 工具栏贴着选区右下角，空间不够时收进选区内部，和微信截图的习惯一致。 */
  const barWidth = 132;
  const barHeight = 38;
  let barLeft = Math.round(rect.x + rect.width - barWidth);
  let barTop = Math.round(rect.y + rect.height + 8);
  if (barTop + barHeight > window.innerHeight - 8) {
    barTop = Math.round(rect.y + rect.height - barHeight - 8);
  }
  barLeft = Math.max(8, Math.min(barLeft, window.innerWidth - barWidth - 8));
  barTop = Math.max(8, Math.min(barTop, window.innerHeight - barHeight - 8));
  bar.style.display = 'flex';
  bar.style.left = `${barLeft}px`;
  bar.style.top = `${barTop}px`;
}

function reset() {
  dragging = false;
  start = null;
  rect = null;
  draw();
  hint.style.display = '';
}

function point(event) {
  return { x: event.clientX, y: event.clientY };
}

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest('#bar')) return;
  start = point(event);
  rect = { x: start.x, y: start.y, width: 0, height: 0 };
  dragging = true;
  hint.style.display = 'none';
  draw();
});

window.addEventListener('mousemove', (event) => {
  if (!dragging || !start) return;
  const now = point(event);
  rect = {
    x: Math.min(start.x, now.x),
    y: Math.min(start.y, now.y),
    width: Math.abs(now.x - start.x),
    height: Math.abs(now.y - start.y),
  };
  draw();
});

window.addEventListener('mouseup', (event) => {
  if (!dragging) return;
  /* 快速拖动时最后一次 mousemove 可能没送达，用松手位置补一次，避免选区比实际拖的小。 */
  if (start) {
    const now = point(event);
    rect = {
      x: Math.min(start.x, now.x),
      y: Math.min(start.y, now.y),
      width: Math.abs(now.x - start.x),
      height: Math.abs(now.y - start.y),
    };
  }
  dragging = false;
  if (!rect || rect.width < 8 || rect.height < 8) {
    reset();
    return;
  }
  draw();
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.captureApi.cancel();
});

window.addEventListener('dragstart', (event) => {
  event.preventDefault();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.captureApi.cancel();
    return;
  }
  if (event.key === 'Enter' && rect && rect.width >= 8 && rect.height >= 8) {
    window.captureApi.done(rect);
  }
});

document.getElementById('btnCancel').addEventListener('click', () => window.captureApi.cancel());
document.getElementById('btnOk').addEventListener('click', () => {
  if (rect && rect.width >= 8 && rect.height >= 8) window.captureApi.done(rect);
});

window.captureApi.onInit((data) => {
  scale = Number(data.scale) || 1;
  reset();
  /* 等整屏截图真正解码并绘制完再通知主进程显示：decode 只保证解码，画面要到下一帧才合成。
   * 主进程收到 ready 才 show，这样不会再先露一帧黑底（闪一下）。 */
  let readySent = false;
  const markReady = () => {
    if (readySent) return;
    readySent = true;
    const send = () => window.captureApi.ready();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(send));
      setTimeout(send, 150); // rAF 被系统挂起时兜底，不会卡住不显示
    } else {
      setTimeout(send, 30);
    }
  };
  shot.onload = markReady;
  shot.onerror = markReady;
  shot.src = data.image;
  if (shot.complete && shot.naturalWidth > 0) markReady();
  else if (typeof shot.decode === 'function') shot.decode().then(markReady).catch(markReady);
});
