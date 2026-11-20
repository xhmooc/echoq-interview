/* 打包前把 llama.cpp 引擎放进 build/engine，随安装包一起分发。
 *
 * 只要本机任何位置已有可用的 llama-server.exe，就直接复用、只做裁剪，绝不联网；
 * 只有完全找不到本地引擎时才下载固定版本，下载后必须通过 SHA-256 校验。
 * 国内网络可用 IC_LLAMA_MIRROR（镜像前缀）或 IC_LLAMA_ZIP_URL（完整地址）指定下载源，
 * 也可以把引擎目录直接用 IC_ENGINE_DIR 指过来。
 * 只保留 llama-server.exe 和 dll，命令行工具（llama-cli/quantize/bench/tts/rpc）不进包。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'build', 'engine');
const STAGE = path.join(ROOT, 'build', '.engine-stage');
const EXTRACT = path.join(ROOT, 'build', '.engine-extract');
const ZIP = path.join(ROOT, 'build', '.engine.zip');

const LLAMA_VERSION = 'b12096';
const ENGINE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`;
const ENGINE_SHA256 = '0540277115a61ee46709bfd317ec73076c0cbfa4072bc06710e520042f6d0d96';
const ENGINE_FILE = /^(llama-server\.exe|llama-server-impl\.dll|llama-common\.dll|llama\.dll|mtmd\.dll|libomp\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-.+\.dll)$/i;

/* 本机可复用的引擎目录：显式指定 > 上次打包产物 > 两个版本的运行目录 > 开发机 clipforge。 */
const LOCAL_SOURCES = [
  process.env.IC_ENGINE_DIR,
  TARGET,
  path.join(ROOT, 'release', 'win-unpacked', 'resources', 'engine'),
  path.join(process.env.APPDATA || '', 'interview-copilot-pro', 'runtime', 'bin'),
  path.join(process.env.APPDATA || '', 'interview-copilot', 'runtime', 'bin'),
  path.join(ROOT, '..', 'clipforge', 'vendor', 'llama'),
].filter(Boolean);

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    return 0;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* 压缩包和本机目录都可能把 exe 放在一层子目录里，这里递归找到真正含 exe 的目录。 */
function findServerDir(dir) {
  if (sizeOf(path.join(dir, 'llama-server.exe')) > 0) return dir;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findServerDir(path.join(dir, entry.name));
    if (found) return found;
  }
  return null;
}

/* 从 source 只挑运行必需文件放进临时目录，再整体替换 build/engine，避免旧文件残留。 */
function accept(source) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  let bytes = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !ENGINE_FILE.test(entry.name)) continue;
    const to = path.join(STAGE, entry.name);
    fs.copyFileSync(path.join(source, entry.name), to);
    bytes += sizeOf(to);
  }
  if (sizeOf(path.join(STAGE, 'llama-server.exe')) === 0) {
    fs.rmSync(STAGE, { recursive: true, force: true });
    return 0;
  }
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.renameSync(STAGE, TARGET);
  return bytes;
}

function engineUrls() {
  const urls = [];
  const custom = String(process.env.IC_LLAMA_ZIP_URL || '').trim();
  const mirror = String(process.env.IC_LLAMA_MIRROR || '').trim().replace(/\/+$/, '');
  if (custom) urls.push(custom);
  if (mirror) urls.push(`${mirror}/${ENGINE_URL}`);
  urls.push(ENGINE_URL);
  return [...new Set(urls)];
}

async function download() {
  let lastError = null;
  for (const url of engineUrls()) {
    console.log(`[engine] 下载 ${url}`);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'interview-copilot' },
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 5 * 1024 * 1024) throw new Error(`文件过小（${buffer.length} 字节）`);
      fs.writeFileSync(ZIP, buffer);
      const digest = sha256File(ZIP);
      if (digest !== ENGINE_SHA256) throw new Error(`SHA-256 校验失败（${digest}）`);
      return;
    } catch (err) {
      lastError = err;
      fs.rmSync(ZIP, { force: true });
      console.warn(`[engine] 下载失败：${err.message}`);
    }
  }
  throw new Error(`没有可用的下载源：${lastError ? lastError.message : '未知错误'}`);
}

function expand() {
  fs.rmSync(EXTRACT, { recursive: true, force: true });
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quote(ZIP)} -DestinationPath ${quote(EXTRACT)} -Force`],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('解压引擎失败');
  const source = findServerDir(EXTRACT);
  if (!source) throw new Error('压缩包里没有 llama-server.exe');
  return source;
}

/* build/engine 已经是可用状态时只做原地裁剪，不删除、不重写 exe/dll。
 * 这样正在运行的开发版 llama-server 锁着文件也能正常打包。 */
function pruneInPlace(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isFile() || !ENGINE_FILE.test(entry.name)) {
      fs.rmSync(full, { recursive: true, force: true });
      continue;
    }
    bytes += sizeOf(full);
  }
  return bytes;
}

async function main() {
  // 1. build/engine 已有引擎：原地裁剪后结束，绝不联网。
  if (sizeOf(path.join(TARGET, 'llama-server.exe')) > 0) {
    const bytes = pruneInPlace(TARGET);
    console.log(`[engine] 复用已有引擎：${TARGET}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
    return;
  }

  // 2. 本机其它位置有引擎：复制到 build/engine，不联网。
  for (const candidate of LOCAL_SOURCES) {
    const source = findServerDir(candidate);
    if (!source) continue;
    const bytes = accept(source);
    if (!bytes) continue;
    console.log(`[engine] 复用本地引擎：${source}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
    return;
  }

  // 3. 本机确实没有：才下载，并且必须过哈希校验。
  await download();
  const source = expand();
  const bytes = accept(source);
  fs.rmSync(ZIP, { force: true });
  fs.rmSync(EXTRACT, { recursive: true, force: true });
  if (!bytes) throw new Error('解压后没有找到可用的 llama-server.exe');
  console.log(`[engine] 已下载并裁剪：${(bytes / 1024 / 1024).toFixed(1)} MB → ${TARGET}`);
}

main().catch((err) => {
  console.error(`[engine] ${err.message}`);
  console.error('[engine] 可设置 IC_ENGINE_DIR 指向本机已有引擎目录，或用 IC_LLAMA_MIRROR / IC_LLAMA_ZIP_URL 指定下载源。');
  process.exit(1);
});
