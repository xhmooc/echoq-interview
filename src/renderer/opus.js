/* 云端识别专用：把 16k 单声道 WAV 压成 24kbps 的 Ogg/Opus。
 *
 * 走浏览器内置的 Opus 编码器（WebCodecs AudioEncoder），不额外引入二进制，
 * 也不增加安装包体积。本机识别完全不需要这一步，调用方只在走云端时才用。
 * 编码失败时返回 null，上层按原样上传 WAV，不影响识别。
 */
(function () {
  /* 后端建议 24kbps：再低识别率掉得明显。 */
  const BITS_PER_SECOND = 24000;
  /* Ogg 的 granule 固定按 48kHz 计时，与输入采样率无关。 */
  const GRANULE_RATE = 48000;
  const VENDOR = 'Yingsheng Interview Copilot';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i << 24;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1);
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    }
    return crc >>> 0;
  }

  function ascii(text, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) out[i] = i < text.length ? text.charCodeAt(i) : 0;
    return out;
  }

  function concat(list, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const item of list) {
      out.set(item, offset);
      offset += item.length;
    }
    return out;
  }

  /* 一页最多 255 个分段表项；包长 255 的整数倍要用 255 标记「未完」再加 0 收尾。 */
  function lacing(length) {
    const out = [];
    let rest = length;
    while (rest >= 255) {
      out.push(255);
      rest -= 255;
    }
    out.push(rest);
    return out;
  }

  function makePage(headerType, granule, serial, sequence, segments, payload) {
    const page = new Uint8Array(27 + segments.length + payload.length);
    page[0] = 0x4f; // OggS
    page[1] = 0x67;
    page[2] = 0x67;
    page[3] = 0x53;
    page[4] = 0; // 版本
    page[5] = headerType;
    let rest = granule;
    for (let i = 0; i < 8; i += 1) {
      page[6 + i] = rest & 0xff;
      rest = Math.floor(rest / 256);
    }
    for (let i = 0; i < 4; i += 1) {
      page[14 + i] = (serial >>> (i * 8)) & 0xff;
      page[18 + i] = (sequence >>> (i * 8)) & 0xff;
    }
    page[26] = segments.length;
    page.set(segments, 27);
    page.set(payload, 27 + segments.length);
    // 校验和覆盖整页，计算时该字段必须为 0（上面本来就没写）。
    const crc = crc32(page);
    for (let i = 0; i < 4; i += 1) page[22 + i] = (crc >>> (i * 8)) & 0xff;
    return page;
  }

  function defaultHead(channels, sampleRate) {
    const head = new Uint8Array(19);
    head.set(ascii('OpusHead', 8), 0);
    head[8] = 1;
    head[9] = channels;
    head[10] = 0; // pre-skip 低位
    head[11] = 0;
    for (let i = 0; i < 4; i += 1) head[12 + i] = (sampleRate >>> (i * 8)) & 0xff;
    return head;
  }

  function opusTags() {
    const vendor = ascii(VENDOR, VENDOR.length);
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(ascii('OpusTags', 8), 0);
    for (let i = 0; i < 4; i += 1) tags[8 + i] = (vendor.length >>> (i * 8)) & 0xff;
    tags.set(vendor, 12);
    return tags;
  }

  /* 只认我们自己写出的单声道 16bit WAV，但按标准的块结构遍历，兼容其它写入方式。 */
  function parseWav(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 44) throw new Error('WAV 长度不足');
    const tag = (offset) => String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是 WAV 文件');

    let sampleRate = 16000;
    let channels = 1;
    let dataStart = 44;
    let dataSize = view.byteLength - 44;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const id = tag(offset);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (id === 'fmt ' && start + 16 <= view.byteLength) {
        channels = view.getUint16(start + 2, true) || 1;
        sampleRate = view.getUint32(start + 4, true) || 16000;
      } else if (id === 'data') {
        dataStart = start;
        dataSize = Math.min(size, view.byteLength - start);
      }
      offset = start + size + (size % 2);
    }

    const frames = Math.floor(dataSize / 2 / channels);
    if (frames <= 0) throw new Error('WAV 没有音频数据');
    let pcm;
    if (channels === 1) {
      pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i += 1) pcm[i] = view.getInt16(dataStart + i * 2, true);
    } else {
      // 采集链路本来就是单声道，这里只做兜底：直接取第一声道。
      pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i += 1) pcm[i] = view.getInt16(dataStart + i * 2 * channels, true);
    }
    return { pcm, sampleRate };
  }

  function mux(packets, description, sampleRate) {
    const head = description && description.length >= 19 ? description : defaultHead(1, sampleRate);
    const preskip = head[10] | (head[11] << 8);
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const pages = [];
    let sequence = 0;

    pages.push(makePage(0x02, 0, serial, sequence, lacing(head.length), head));
    sequence += 1;
    const tags = opusTags();
    pages.push(makePage(0x00, 0, serial, sequence, lacing(tags.length), tags));
    sequence += 1;

    let done = 0;
    let segments = [];
    let payloads = [];
    let payloadBytes = 0;
    let pageSamples = 0;

    const flush = (last) => {
      if (!segments.length) return;
      done += pageSamples;
      // granule 从「包含 pre-skip 的累计样本数」算，播放器再减掉 pre-skip。
      pages.push(makePage(last ? 0x04 : 0x00, preskip + done, serial, sequence, segments, concat(payloads, payloadBytes)));
      sequence += 1;
      segments = [];
      payloads = [];
      payloadBytes = 0;
      pageSamples = 0;
    };

    for (const packet of packets) {
      const lace = lacing(packet.bytes.length);
      if (segments.length + lace.length > 255 || payloadBytes + packet.bytes.length > 4000) {
        flush(false);
      }
      for (const value of lace) segments.push(value);
      payloads.push(packet.bytes);
      payloadBytes += packet.bytes.length;
      pageSamples += Math.round((packet.duration * GRANULE_RATE) / 1000000);
    }
    flush(true);

    const totalBytes = pages.reduce((sum, page) => sum + page.length, 0);
    return concat(pages, totalBytes);
  }

  async function encodeWav(buffer, bitrate) {
    if (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function') return null;
    if (!buffer || buffer.byteLength < 1000) return null;

    const wav = parseWav(buffer);
    const packets = [];
    let description = null;
    let failure = null;

    const encoder = new AudioEncoder({
      output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        packets.push({ bytes, duration: Number(chunk.duration) || 20000 });
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          description = new Uint8Array(meta.decoderConfig.description);
        }
      },
      error(err) {
        failure = err;
      },
    });

    encoder.configure({
      codec: 'opus',
      sampleRate: wav.sampleRate,
      numberOfChannels: 1,
      bitrate: Number(bitrate) || BITS_PER_SECOND,
    });

    const audio = new AudioData({
      format: 's16',
      sampleRate: wav.sampleRate,
      numberOfFrames: wav.pcm.length,
      numberOfChannels: 1,
      timestamp: 0,
      data: wav.pcm,
    });
    encoder.encode(audio);
    audio.close();
    await encoder.flush();
    encoder.close();

    if (failure) throw failure;
    if (!packets.length) return null;
    return mux(packets, description, wav.sampleRate);
  }

  window.InterviewOpus = { encodeWav };
})();
