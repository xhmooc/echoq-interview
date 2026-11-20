/* 隐藏的采集页：维持一条桌面视频流；主进程要截图时，直接把当前帧画到 canvas 上导出。 */
const video = document.getElementById('video');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
const output = document.createElement('canvas');

let started = false;

function ensureSize() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return true;
}

async function boot() {
  const sourceId = new URLSearchParams(location.search).get('source') || '';
  if (!sourceId) {
    window.recorderApi.fail('没有可采集的屏幕');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 15,
        },
      },
    });
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve) => { video.onloadedmetadata = resolve; });
    }
    if (!ensureSize()) throw new Error('桌面流没有返回画面');
    started = true;
    window.recorderApi.ready();
  } catch (err) {
    window.recorderApi.fail(err && err.message ? err.message : String(err));
  }
}

/* 取整屏最新一帧：JPEG 只用于冻结层预览，体积小、解码快。 */
window.recorderApi.onGrab(({ id }) => {
  if (!started || !ensureSize()) {
    window.recorderApi.frame({ id, error: '桌面流未就绪' });
    return;
  }
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', 0.92);
    window.recorderApi.frame({ id, jpeg, width: canvas.width, height: canvas.height });
  } catch (err) {
    window.recorderApi.frame({ id, error: err.message });
  }
});

/* 框选完成后按物理像素裁切，PNG 体积小、文字不糊，直接用于 OCR。 */
window.recorderApi.onCrop(({ id, rect }) => {
  if (!started || !ensureSize()) {
    window.recorderApi.frame({ id, error: '桌面流未就绪' });
    return;
  }
  const sx = Math.max(0, Math.round(Number(rect && rect.x) || 0));
  const sy = Math.max(0, Math.round(Number(rect && rect.y) || 0));
  const sw = Math.max(1, Math.round(Number(rect && rect.width) || 1));
  const sh = Math.max(1, Math.round(Number(rect && rect.height) || 1));
  try {
    output.width = sw;
    output.height = sh;
    const octx = output.getContext('2d');
    octx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    window.recorderApi.frame({ id, png: output.toDataURL('image/png'), width: sw, height: sh });
  } catch (err) {
    window.recorderApi.frame({ id, error: err.message });
  }
});

boot();
