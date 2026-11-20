const answerEl = document.getElementById('answer');
const ocrEl = document.getElementById('ocr');
const providerEl = document.getElementById('provider');
const btnCapture = document.getElementById('btnCapture');
const hintEl = document.getElementById('hint');

let capturePending = false;

function setHint(text) {
  if (hintEl) hintEl.textContent = text;
}

function resetCaptureButton() {
  capturePending = false;
  btnCapture.disabled = false;
  btnCapture.textContent = '截下一题';
}

function render(payload) {
  if (!payload) return;
  const answer = String(payload.answer || '').trim();
  answerEl.textContent = answer || '没有生成答案';
  ocrEl.textContent = String(payload.text || '').trim() || '没有识别到文字';
  const labels = { local: '本地 OCR', cloud: '云端视觉', custom: '自定义视觉', text: '文字重答' };
  providerEl.textContent = labels[payload.provider] || '';
  if (capturePending) {
    resetCaptureButton();
    setHint('Alt+Shift+A');
  }
}

window.answerApi.onData(render);

document.getElementById('btnCopy').addEventListener('click', async () => {
  const text = answerEl.textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const button = document.getElementById('btnCopy');
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = '复制'; }, 1200);
});

document.getElementById('btnHide').addEventListener('click', () => window.answerApi.hide());

btnCapture.addEventListener('click', async () => {
  if (capturePending) return;
  capturePending = true;
  btnCapture.disabled = true;
  btnCapture.textContent = '截图中…';
  setHint('请在屏幕上框选');
  try {
    const result = await window.answerApi.capture();
    if (result && result.ok) {
      setHint('已更新');
      setTimeout(() => setHint('Alt+Shift+A'), 1600);
    } else if (result && result.cancelled) {
      setHint('已取消');
      setTimeout(() => setHint('Alt+Shift+A'), 1600);
    } else {
      setHint((result && result.error) || '截图失败');
      setTimeout(() => setHint('Alt+Shift+A'), 2600);
    }
  } catch (err) {
    setHint('截图失败');
    setTimeout(() => setHint('Alt+Shift+A'), 2600);
  } finally {
    resetCaptureButton();
  }
});

/* 右下角拖动调整窗口大小；主进程按屏幕坐标计算，鼠标移出窗口也能继续。 */
const grip = document.getElementById('grip');
let resizing = false;

function endResize() {
  if (!resizing) return;
  resizing = false;
  window.answerApi.resizeEnd();
}

grip.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  try { grip.setPointerCapture(event.pointerId); } catch (err) {}
  resizing = true;
  window.answerApi.resizeStart();
});
grip.addEventListener('pointerup', endResize);
grip.addEventListener('pointercancel', endResize);
window.addEventListener('mouseup', endResize);
window.addEventListener('blur', endResize);
