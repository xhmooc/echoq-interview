/* 自检：node tools/check-asr.js <wav 文件>
 * 先本地转写，再把转写结果交给大模型生成回答，完整走一遍真实链路。
 */
const fs = require('fs');
const path = require('path');
const asr = require('../src/main/asr');
const llm = require('../src/main/llm');
const config = require('../src/main/config');

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath || !fs.existsSync(wavPath)) {
    console.error('用法: node tools/check-asr.js <wav文件>');
    process.exit(1);
  }

  const cfg = config.load();
  console.log('LLM :', cfg.llm.base_url, '|', cfg.llm.model);
  console.log('ASR :', cfg.asr.provider, '|', cfg.asr.llama_bin || cfg.asr.base_url);

  const wav = fs.readFileSync(wavPath);
  console.log('音频:', path.basename(wavPath), `${(wav.length / 1024).toFixed(1)} KB`);

  console.time('ASR 耗时');
  const text = await asr.transcribe(wav);
  console.timeEnd('ASR 耗时');
  console.log('\n=== 转写结果 ===\n' + (text || '(空)'));

  if (!text) {
    console.error('转写为空，检查音频内容或 ASR 配置');
    asr.shutdown();
    process.exit(2);
  }

  console.log('\n=== 生成回答（流式） ===');
  console.time('LLM 耗时');
  const answer = await llm.streamAnswer(text, {
    onDelta: (delta) => process.stdout.write(delta),
  });
  console.timeEnd('LLM 耗时');
  console.log('\n\n=== 完成 ===');
  console.log(answer);
  asr.shutdown();
}

main().catch((err) => {
  console.error('自检失败：', err.message);
  asr.shutdown();
  process.exit(1);
});
