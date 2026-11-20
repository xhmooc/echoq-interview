/* 运行期目录：配置、日志、引擎、模型都放在用户数据目录里。
 *
 * 这样换一台电脑、或者把项目挪到别的路径，程序都能自己找到（或下载）依赖，
 * 不再依赖开发机上的 clipforge 目录。纯 node 环境（tools/check-asr.js）下
 * 自动退回项目根目录。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MODEL_FILE = 'Qwen3-ASR-0.6B-Q8_0.gguf';
const MMPROJ_FILE = 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf';

function electronApp() {
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') return electron.app;
  } catch (err) {
    // 纯 node 环境：require('electron') 拿到的是可执行文件路径，没有 app
  }
  return null;
}

function userRoot() {
  const app = electronApp();
  if (app) {
    try {
      return app.getPath('userData');
    } catch (err) {
      // 落到项目目录
    }
  }
  return ROOT;
}

function runtimeRoot() {
  return path.join(userRoot(), 'runtime');
}

function binDir() {
  return path.join(runtimeRoot(), 'bin');
}

function modelsDir() {
  return path.join(runtimeRoot(), 'models');
}

function logsDir() {
  return path.join(userRoot(), 'logs');
}

function configPath() {
  return path.join(userRoot(), 'config.json');
}

function legacyConfigPath() {
  return path.join(ROOT, 'config.json');
}

/* 开发期复用：本机如果还留着 clipforge 的 vendor，直接借它的引擎和模型。 */
function legacyVendor() {
  const base = path.join(ROOT, '..', 'clipforge', 'vendor');
  return {
    binary: path.join(base, 'llama', 'llama-server.exe'),
    model: path.join(base, 'models', MODEL_FILE),
    mmproj: path.join(base, 'models', MMPROJ_FILE),
  };
}

/* 随安装包内置的引擎目录（electron-builder extraResources → resources/engine）。
 * Electron 33 在开发模式下也会把 isPackaged 报成 true，所以这里以 exe 是否真的存在为准：
 * 打包目录里有就用 resources/engine，否则退回项目的 build/engine。 */
function bundledBinDir() {
  const app = electronApp();
  if (app && app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'engine');
    if (fs.existsSync(path.join(packaged, 'llama-server.exe'))) return packaged;
  }
  return path.join(ROOT, 'build', 'engine');
}

function bundledPaths() {
  const dir = bundledBinDir();
  return { dir, binary: path.join(dir, 'llama-server.exe') };
}

function runtimePaths() {
  return {
    binary: path.join(binDir(), 'llama-server.exe'),
    model: path.join(modelsDir(), MODEL_FILE),
    mmproj: path.join(modelsDir(), MMPROJ_FILE),
  };
}

/* 允许自定义的引擎/模型路径范围：应用运行目录（用户数据 runtime）或随包内置引擎。
 * 渲染层传进来的任意绝对路径（比如 C:\Windows\...）一律视为非法。 */
function engineRoots() {
  return [runtimeRoot(), bundledBinDir()].map((dir) => path.resolve(dir));
}

function isEnginePath(file) {
  if (typeof file !== 'string' || !file.trim()) return false;
  const target = path.resolve(file.trim());
  return engineRoots().some((root) => {
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return target === root || target.startsWith(prefix);
  });
}

function ensureDirs() {
  for (const dir of [runtimeRoot(), binDir(), modelsDir(), logsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  ROOT,
  MODEL_FILE,
  MMPROJ_FILE,
  userRoot,
  runtimeRoot,
  binDir,
  modelsDir,
  logsDir,
  configPath,
  legacyConfigPath,
  legacyVendor,
  bundledBinDir,
  bundledPaths,
  runtimePaths,
  isEnginePath,
  ensureDirs,
};
