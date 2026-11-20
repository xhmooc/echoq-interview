/* 简单文件日志：Electron 没有控制台时也能事后排查。
 * 按天轮转成 app-YYYY-MM-DD.log，不再因为文件变大而整份清空。 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const LOG_DIR = paths.logsDir();

function stamp(date) {
  const value = date || new Date();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function logPath(date) {
  return path.join(LOG_DIR, `app-${stamp(date)}.log`);
}

function write(level, args) {
  const parts = args.map((item) => {
    if (typeof item === 'string') return item;
    if (item instanceof Error) return item.stack || item.message;
    try {
      return JSON.stringify(item);
    } catch (err) {
      return String(item);
    }
  });
  const line = `[${new Date().toISOString()}] [${level}] ${parts.join(' ')}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logPath(), line, 'utf-8');
  } catch (err) {
    // 日志失败不能影响主流程
  }
}

function install() {
  const origin = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => { write('info', args); origin.log(...args); };
  console.error = (...args) => { write('error', args); origin.error(...args); };
  console.warn = (...args) => { write('warn', args); origin.warn(...args); };
}

module.exports = { install, write, logPath, LOG_PATH: logPath() };
