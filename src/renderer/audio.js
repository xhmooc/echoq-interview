/* 音频采集 + 自适应 VAD 断句 + 16k 单声道 WAV 编码。
 *
 * 断句策略（只依赖声学特征，不引入语义依赖）：
 *  1. 双阈值滞回：开口需要越过较高阈值并连续若干帧，收尾只要低于较低阈值就算仍在说话，
 *     避免句尾轻声字（吗/呢/儿的尾音）被当成静音，把一句话切掉尾巴。
 *  2. 噪声地板自适应：明确安静的帧快速跟低；环境持续偏响时缓慢上调，且始终压在观察值之下，
 *     既不会让底噪触发假开口，也不会把说话声学成底噪后听不见人。开头 400ms 先估一次环境。
 *  3. 停顿抗抖：停顿中零星的短促声响（敲键盘、换气）不会重置静音计时，
 *     避免两句话之间的响动把两句粘成一段。
 *  4. 短片段宽限：已经说了很短（<1.2s）就遇到停顿，多等 300ms 再断，
 *     防止「我想问一下」这种半句话被单独切出来。
 *  5. 超长软切：到上限时回退到最近 2.5s 内能量最低处切开，尾音留给下一段，
 *     不再从句子中间硬切。
 *  6. 停止收音时把正在说的一段冲出来，避免最后一句因没等到静音阈值而丢失。
 */
(function () {
  const TARGET_RATE = 16000;

  const ONSET_FRAMES = 3; // 连续 3 帧（约 130ms）越过开口阈值才算真的开口
  const RESUME_FRAMES = 3; // 停顿中重新连续出声，才认为话没说完
  const SHORT_SPEECH_MS = 1200; // 短于这个时长的片段遇到停顿先多等一会
  const GRACE_MS = 300; // 短片段额外等待时长
  const TAIL_MS = 280; // 句尾保留一点非语音段，避免切掉收尾辅音
  const PREROLL_MS = 450; // 开口前保留的音频，避免吞掉句首
  const QUIET_SEARCH_MS = 2500; // 超长切分时回看多长一段寻找最安静的切点
  const QUIET_KEEP_MS = 500; // 超长切分时至少留给下一段的音频

  /* 过零率：人声（尤其元音）能量集中在低频，过零率通常明显低于白噪声、
   * 咳嗽和键盘敲击。用它把「响但不像人声」的帧排除在开口/续说判断之外。 */
  function zeroCrossingRate(frame) {
    if (!frame || frame.length < 2) return 0;
    let crossings = 0;
    let prev = frame[0];
    for (let i = 1; i < frame.length; i += 1) {
      const cur = frame[i];
      if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings += 1;
      prev = cur;
    }
    return crossings / (frame.length - 1);
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return buffer;
  }

  function resampleLinear(data, inRate, outRate) {
    if (inRate === outRate) return data;
    const ratio = inRate / outRate;
    const length = Math.max(1, Math.floor(data.length / ratio));
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, data.length - 1);
      const weight = pos - i0;
      out[i] = data[i0] * (1 - weight) + data[i1] * weight;
    }
    return out;
  }

  /* 同一份配置在渲染层是 camelCase，在主进程 config 里是 snake_case，两种都认。 */
  function pickOption(options, camel, snake, fallback) {
    if (options) {
      if (Number.isFinite(Number(options[camel])) && options[camel] !== '' && options[camel] != null) {
        return Number(options[camel]);
      }
      if (Number.isFinite(Number(options[snake])) && options[snake] !== '' && options[snake] != null) {
        return Number(options[snake]);
      }
    }
    return fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  class InterviewAudio {
    constructor(handlers) {
      this.onSegment = handlers.onSegment || (() => {});
      this.onSegmentDebug = handlers.onSegmentDebug || (() => {});
      this.onLevel = handlers.onLevel || (() => {});
      this.onState = handlers.onState || (() => {});
      this.reset();
    }

    reset() {
      this.stream = null;
      this.ctx = null;
      this.source = null;
      this.processor = null;
      this.silent = null;
      this.active = false;
      this.rate = TARGET_RATE;
      this.speaking = false;
      this.chunks = [];
      this.chunkRms = [];
      this.totalSamples = 0;
      this.leadSamples = 0;
      this.silenceSamples = 0;
      this.lastVoicedAt = 0;
      this.voicedRun = 0;
      this.preroll = [];
      this.prerollRms = [];
      this.prerollSamples = 0;
      this.warmupSamples = 0;
      this.recent = [];
      this.speechWin = [];
      this.speechWindowFrames = 60;
      this.noise = 0.006;
      // 断句诊断：每段由什么原因切出来、段内有哪些停顿、切点时的阈值快照
      this.segIndex = 0;
      this.segStartedAt = 0;
      this.peakRms = 0;
      this.voicedSamples = 0;
      this.pauses = [];
      this.pauseStart = 0;
    }

    get listening() {
      return this.active;
    }

    async start(mode, options) {
      this.stop();
      const silenceMs = clamp(pickOption(options, 'silenceMs', 'silence_ms', 650), 300, 2500);
      const maxSegmentS = clamp(pickOption(options, 'maxSegmentS', 'max_segment_s', 14), 6, 40);
      const sensitivity = clamp(pickOption(options, 'sensitivity', 'sensitivity', 0.012), 0.002, 0.08);
      /* 设备 ID 是字符串，不能走 pickOption（会转成数字）。空字符串表示系统默认。 */
      const inputDeviceId = String(
        (options && (options.input_device_id || options.inputDeviceId)) || ''
      ).trim();

      let stream;
      if (mode === 'mic') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });
      }

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(
          '没有抓到音频轨道。请确认面试声音从系统扬声器/耳机输出；若用的是网页会议，先播放声音再重试。'
        );
      }
      stream.getVideoTracks().forEach((track) => track.stop());

      this.stream = stream;
      try {
        this.ctx = new AudioContext();
        await this.ctx.resume();

        const rate = this.ctx.sampleRate;
        // 约 32ms 一帧：窗口越短，开口点和静音计时越准，不会因为帧太粗而多算/少算静音。
        const frame = Math.pow(2, Math.round(Math.log2(rate * 0.032)));
        this.frameSamples = frame;
        this.rate = rate;
        this.silenceMs = silenceMs;
        this.silenceLimit = Math.round(rate * silenceMs / 1000);
        // 宽限只能比基础静音更长：用户把静音设到 2s 以上时，不能再被 2s 上限压回去。
        this.graceLimit = Math.max(
          this.silenceLimit,
          Math.min(this.silenceLimit + Math.round(rate * GRACE_MS / 1000), Math.round(rate * 2)),
        );
        this.maxSamples = Math.round(rate * maxSegmentS);
        this.sensitivity = sensitivity;
        this.prerollLimit = Math.round(rate * PREROLL_MS / 1000);
        this.tailSamples = Math.round(rate * TAIL_MS / 1000);
        this.warmupSamples = Math.round(rate * 0.4);
        this.speechWindowFrames = Math.max(20, Math.round((rate * 2.5) / frame));

        this.source = this.ctx.createMediaStreamSource(stream);
        this.processor = this.ctx.createScriptProcessor(frame, 1, 1);
        this.silent = this.ctx.createGain();
        this.silent.gain.value = 0;

        this.processor.onaudioprocess = (event) => {
          if (!this.active) return;
          this.handleFrame(new Float32Array(event.inputBuffer.getChannelData(0)), rate);
        };
        this.source.connect(this.processor);
        this.processor.connect(this.silent);
        this.silent.connect(this.ctx.destination);
      } catch (err) {
        // 媒体流已拿到但音频图没建起来：必须释放轨道，否则麦克风/共享会一直被占用
        stream.getTracks().forEach((track) => track.stop());
        this.reset();
        throw err;
      }

      this.active = true;
      audioTracks[0].onended = () => {
        if (this.active) {
          this.stop('ended');
          this.onState('ended');
        }
      };
      this.onState('listening');
    }

    /* 明确安静：快速跟低，且只降不升。
     * 句首的轻声渐强、句尾的气声都可能落在「比底噪响、但还没到收尾阈值」的区间里，
     * 如果也拿去学，底噪会被人声一点点抬上去，用户调低灵敏度后阈值仍被 noise×2.6 顶住，
     * 等于灵敏度设置失效。这里只跟随真正的安静帧往下走，环境变响交给 learnAmbient。 */
    learnQuiet(rms) {
      if (rms >= this.noise) return;
      this.noise = Math.max(0.0015, this.noise + (rms - this.noise) * 0.35);
    }

    /* 稳定但比当前估计响（会议软件开始出声、房间变吵）：慢速上调，
     * 且永远压在观察值之下，避免把正常说话声学成底噪后自己听聋。 */
    learnAmbient(rms) {
      const next = this.noise + (rms - this.noise) * 0.04;
      this.noise = clamp(next, this.noise, Math.min(0.02, rms * 0.9));
    }

    isStationary(win, need) {
      if (win.length < need) return false;
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < win.length; i += 1) {
        if (win[i] < min) min = win[i];
        if (win[i] > max) max = win[i];
      }
      return { steady: max <= min * 1.5, min, max };
    }

    handleFrame(frame, rate) {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      this.onLevel(Math.min(1, rms * 9));
      this.recent.push(rms);
      if (this.recent.length > 6) this.recent.shift();

      // 开头 400ms 只估环境噪声、不出句：一进会议就有底噪时不会先把噪声当成开口。
      // 上限压在 0.02（约 -34dBFS）；但只在「明显比人声轻」的帧上学习——
      // 用户一点开始面试官就正在说话时，不能把人声学成底噪，否则整场都听不见人。
      if (this.warmupSamples > 0) {
        this.warmupSamples = Math.max(0, this.warmupSamples - frame.length);
        if (rms < Math.min(0.02, this.noise * 4)) {
          this.noise = clamp(this.noise * 0.7 + Math.min(rms, 0.02) * 0.3, 0.0015, 0.02);
        }
        // 预热期也要留着：用户一点开始面试官就在说话时，句首不能丢。
        this.pushPreroll(frame, rms);
        return;
      }

      const onsetThreshold = Math.max(this.sensitivity, this.noise * 2.6);
      // 收尾阈值明显低于开口阈值：句尾轻声、气声仍算「还在说话」。
      const releaseThreshold = this.releaseThresholdValue();
      // 咳嗽、清嗓、键盘声往往又响又尖；过零率过高时不当作人声，避免把两问粘成一段。
      const voiceLike = zeroCrossingRate(frame) < 0.35;
      const strong = rms > onsetThreshold && voiceLike;
      const voiced = rms > releaseThreshold && voiceLike;

      if (!this.speaking) {
        this.voicedRun = strong ? this.voicedRun + 1 : 0;
        if (this.voicedRun >= ONSET_FRAMES) {
          this.beginSegment(frame, rms);
          return;
        }
        if (this.voicedRun === 0) {
          if (rms < releaseThreshold) this.learnQuiet(rms);
          else {
            const stat = this.isStationary(this.recent, 6);
            if (stat && stat.steady) this.learnAmbient(rms);
          }
        }
        this.pushPreroll(frame, rms);
        return;
      }

      this.pushChunk(frame, rms);
      if (rms > this.peakRms) this.peakRms = rms;
      // 整整 2.5 秒完全平直、能量又不高，那是环境音（音乐、风扇、会场底噪），
      // 不是人说话：把底噪抬上去，让它尽快结束，别把后面几问都吞进同一段。
      this.speechWin.push(rms);
      if (this.speechWin.length > this.speechWindowFrames) this.speechWin.shift();
      const stat = this.isStationary(this.speechWin, this.speechWindowFrames);
      if (stat && stat.steady && stat.max < onsetThreshold * 2.2) this.learnAmbient(stat.max);

      if (voiced) {
        this.voicedRun += 1;
        this.voicedSamples += frame.length;
        this.lastVoicedAt = this.totalSamples;
        this.closePause();
        // 停顿中的零星声响（敲键盘、换气、短促杂音）不重置静音计时，否则两句会粘成一段。
        if (this.voicedRun >= RESUME_FRAMES) this.silenceSamples = 0;
      } else {
        this.voicedRun = 0;
        this.silenceSamples += frame.length;
        if (!this.pauseStart) this.pauseStart = this.totalSamples;
      }

      const softLimit = this.softSilenceLimit();
      if (this.silenceSamples >= softLimit) {
        this.finishSegment('silence');
      } else if (this.totalSamples >= this.maxSamples) {
        this.finishLongSegment();
      }
    }

    releaseThresholdValue() {
      const onset = Math.max(this.sensitivity, this.noise * 2.6);
      return Math.max(Math.min(onset * 0.55, onset - 0.001), this.noise * 1.4);
    }

    /* 诊断用：把段内每一次 250ms 以上的停顿记成一条，用来判断
     * 「源音频本身没有句间停顿」还是「停顿有、但没到静音阈值」。 */
    closePause() {
      if (!this.pauseStart) return;
      const pauseMs = Math.round(((this.totalSamples - this.pauseStart) / this.rate) * 1000);
      if (pauseMs >= 250 && this.pauses.length < 12) {
        this.pauses.push({ atSec: +(this.pauseStart / this.rate).toFixed(2), ms: pauseMs });
      }
      this.pauseStart = 0;
    }

    /* 半句话的停顿多等一点：整句还没成形就切断，损失的是一整个问题。 */
    softSilenceLimit() {
      const speechSamples = Math.max(0, this.lastVoicedAt - this.leadSamples);
      const speechMs = (speechSamples / this.rate) * 1000;
      return speechMs < SHORT_SPEECH_MS ? this.graceLimit : this.silenceLimit;
    }

    beginSegment(frame, rms) {
      this.speaking = true;
      this.speechWin = [];
      this.chunks = this.preroll.slice();
      this.chunkRms = this.prerollRms.slice();
      this.leadSamples = this.prerollSamples;
      this.totalSamples = this.prerollSamples;
      this.preroll = [];
      this.prerollRms = [];
      this.prerollSamples = 0;
      this.silenceSamples = 0;
      this.pushChunk(frame, rms);
      this.lastVoicedAt = this.totalSamples;
      this.segStartedAt = Date.now();
      this.peakRms = rms;
      this.voicedSamples = frame.length;
      this.pauses = [];
      this.pauseStart = 0;
    }

    pushChunk(frame, rms) {
      this.chunks.push(frame);
      this.chunkRms.push(rms);
      this.totalSamples += frame.length;
    }

    pushPreroll(frame, rms) {
      this.preroll.push(frame);
      this.prerollRms.push(rms);
      this.prerollSamples += frame.length;
      while (this.prerollSamples > this.prerollLimit && this.preroll.length > 1) {
        this.prerollSamples -= this.preroll.shift().length;
        this.prerollRms.shift();
      }
    }

    /* 按采样数把已缓存的音频拼出来。 */
    collect(count) {
      const size = Math.max(0, Math.min(count, this.totalSamples));
      const out = new Float32Array(size);
      let offset = 0;
      for (const chunk of this.chunks) {
        if (offset >= size) break;
        const take = Math.min(chunk.length, size - offset);
        out.set(chunk.subarray(0, take), offset);
        offset += take;
      }
      return out.subarray(0, offset);
    }

    clearSegment() {
      this.speaking = false;
      this.chunks = [];
      this.chunkRms = [];
      this.totalSamples = 0;
      this.leadSamples = 0;
      this.silenceSamples = 0;
      this.lastVoicedAt = 0;
      this.voicedRun = 0;
      this.preroll = [];
      this.prerollRms = [];
      this.prerollSamples = 0;
    }

    /* 一段切出来时顺手记一份诊断：切分原因、段内停顿、切点阈值与能量快照。
     * 生产环境拿不到录音，这份记录就是判断「切早了 / 切晚了 / 压根没切」的唯一证据。 */
    segmentMeta(trigger, durationSamples) {
      const rate = this.rate || TARGET_RATE;
      const speechSamples = Math.min(
        Math.max(0, this.lastVoicedAt - this.leadSamples),
        durationSamples,
      );
      return {
        trigger,
        startAt: this.segStartedAt ? new Date(this.segStartedAt).toISOString() : '',
        durationSec: +(durationSamples / rate).toFixed(2),
        speechSec: +(speechSamples / rate).toFixed(2),
        voicedRatio: durationSamples > 0 ? +(Math.min(1, this.voicedSamples / durationSamples)).toFixed(2) : 0,
        peakRms: +this.peakRms.toFixed(4),
        noise: +this.noise.toFixed(4),
        onset: +Math.max(this.sensitivity, this.noise * 2.6).toFixed(4),
        release: +this.releaseThresholdValue().toFixed(4),
        silenceMs: Math.round((this.silenceSamples / rate) * 1000),
        silenceLimitMs: this.silenceMs,
        graceLimitMs: Math.round((this.graceLimit / rate) * 1000),
        maxSegmentMs: Math.round((this.maxSamples / rate) * 1000),
        frameMs: +(((this.frameSamples || 0) / rate) * 1000).toFixed(1),
        rate,
        pauses: this.pauses.slice(),
      };
    }

    publish(samples, meta) {
      const rate = this.rate || TARGET_RATE;
      if (!samples || samples.length < rate * 0.3) return;
      const resampled = resampleLinear(samples, rate, TARGET_RATE);
      if (resampled.length < TARGET_RATE * 0.3) return;
      const wav = encodeWav(resampled, TARGET_RATE);
      this.onSegment(wav, resampled.length / TARGET_RATE, meta);
      if (meta) {
        this.segIndex += 1;
        try {
          this.onSegmentDebug({ seq: this.segIndex, bytes: wav.byteLength, ...meta });
        } catch (err) {
          // 诊断失败不能影响识别
        }
      }
    }

    /* 正常断句：切在最后一段语音之后，留一点尾巴保护收尾辅音。 */
    finishSegment(trigger) {
      const end = Math.min(this.totalSamples, this.lastVoicedAt + this.tailSamples);
      this.closePause();
      const meta = this.segmentMeta(trigger || 'silence', end);
      const samples = this.collect(end);
      this.clearSegment();
      this.publish(samples, meta);
    }

    /* 超长：回退到最近窗口里能量最低的一帧切开，前半段出结果，后半段接着攒，
     * 这样既不会从词中间硬切，也不会丢音频。 */
    finishLongSegment() {
      const rate = this.rate || TARGET_RATE;
      const from = Math.max(0, this.totalSamples - Math.round(rate * QUIET_SEARCH_MS / 1000));
      const to = Math.max(from, this.totalSamples - Math.round(rate * QUIET_KEEP_MS / 1000));

      let bestIndex = -1;
      let bestRms = Infinity;
      let cursor = 0;
      for (let i = 0; i < this.chunks.length; i += 1) {
        const start = cursor;
        cursor += this.chunks[i].length;
        if (start < from) continue;
        if (start > to) break;
        if (this.chunkRms[i] < bestRms) {
          bestRms = this.chunkRms[i];
          bestIndex = i;
        }
      }
      if (bestIndex < 0) bestIndex = this.chunks.length - 1;

      let cut = 0;
      for (let i = 0; i < bestIndex; i += 1) cut += this.chunks[i].length;
      this.closePause();
      const meta = this.segmentMeta('max', cut);
      const head = this.collect(cut);
      const tailChunks = this.chunks.slice(bestIndex);
      const tailRms = this.chunkRms.slice(bestIndex);
      const tailSamples = this.totalSamples - cut;

      this.chunks = tailChunks;
      this.chunkRms = tailRms;
      this.totalSamples = tailSamples;
      this.silenceSamples = 0;
      this.voicedRun = 0;
      this.lastVoicedAt = tailSamples;
      this.leadSamples = 0;
      // 尾部接着攒成下一段，诊断统计重新起算
      this.segStartedAt = Date.now();
      this.peakRms = 0;
      this.voicedSamples = 0;
      this.pauses = [];
      this.pauseStart = 0;

      this.publish(head, meta);
    }

    stop(reason) {
      const wasSpeaking = this.speaking;
      this.active = false;
      // 用户点停止（或音频源断开）时，正在说的这一段也要送去识别，不能整段丢掉。
      if (wasSpeaking) this.finishSegment(reason || 'stop');
      if (this.processor) {
        this.processor.disconnect();
        this.processor.onaudioprocess = null;
      }
      if (this.source) this.source.disconnect();
      if (this.silent) this.silent.disconnect();
      if (this.ctx) {
        this.ctx.close().catch(() => {});
      }
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
      }
      this.reset();
      if (wasSpeaking) this.onState('stopped');
    }
  }

  window.InterviewAudio = InterviewAudio;
})();
