/* 硬件检测：只在首次初始化或手动重新检测时跑一次，用来推荐识别方式。
 *
 * 判断只依赖逻辑核心数和总内存，避免读取 CPU 指令集这类不稳定信息；
 * llama.cpp 会自己按 CPU 选择指令集变体，这里只回答「本机跑得动吗」。
 */
const fs = require('fs');
const os = require('os');
const paths = require('./paths');

const GB = 1024 ** 3;

function freeDiskGb() {
  try {
    const stat = fs.statfsSync(paths.userRoot());
    return Math.round((stat.bsize * stat.bavail) / GB);
  } catch (err) {
    return null;
  }
}

function detect() {
  const cpus = os.cpus() || [];
  const logical = cpus.length || 1;
  const memGb = Math.round((os.totalmem() / GB) * 10) / 10;
  const freeGb = freeDiskGb();
  const cpuModel = String((cpus[0] && cpus[0].model) || '').replace(/\s+/g, ' ').trim();

  let tier = 'cloud';
  let reason = '';
  if (memGb >= 8 && logical >= 4) {
    tier = 'local';
    reason = '配置足够，本机识别更省钱、不占流量';
  } else if (memGb >= 6 && logical >= 4) {
    tier = 'maybe';
    reason = '可以尝试本机识别，速度可能偏慢';
  } else {
    tier = 'cloud';
    reason = '内存或核心数偏低，建议先用云端识别';
  }

  return {
    logical_cores: logical,
    memory_gb: memGb,
    free_disk_gb: freeGb,
    cpu_model: cpuModel,
    tier,
    reason,
    summary: `${logical} 核 / ${memGb} GB 内存`,
    detected_at: Date.now(),
  };
}

module.exports = { detect };
