# 贡献指南

感谢你愿意参与这个项目。下面是最小的上手路径和提交约定。

## 开发环境

- Windows 10 / 11（其它平台的采集逻辑尚未适配）
- Node.js 18 及以上
- 首次开发需要能访问 GitHub / huggingface（用于下载引擎与模型）

```bash
npm install
npm start
```

## 贡献许可

本项目采用 PolyForm Noncommercial License 1.0.0，作者保留商业授权权利。提交 Pull Request 即表示你同意将本次贡献的版权授予项目作者，并允许作者在非商业许可和商业许可下使用该贡献。如果你不希望这样授权，请先联系作者，不要直接提交。

## 版本号规则

只有产品能力发生变化时才递增版本号。界面优化、文案调整、交互修复、性能修复、重新打包都不算版本变更，版本号保持不动。

- 新增功能：修订号 +0.01，例如 `0.3.0 → 0.3.1`。
- 大版本更新：次版本号 +0.1，例如 `0.3.1 → 0.4.0`。
- 客户端与服务端由作者同步发布，对外仓库只包含客户端；服务端代码与服务端版本文件不对贡献者开放。
- 同版本重打包只更换文件哈希，不代表新版本，`CHANGELOG.md` 不新增版本条目。

每次真正发版时，以下位置必须同步更新，缺一不可：

`package.json`、`package-lock.json`（顶层两处）、`website/index.html` 的版本号 / 下载文件名 / SHA256、`FEATURE-PLAN.md` 顶部适用版本、`CHANGELOG.md` 新条目，以及 `website/downloads/` 下的安装包文件名。服务端相关位置由作者在内部仓库同步。

## 代码结构

| 目录 | 说明 |
| --- | --- |
| `main.js` | 主进程：窗口、快捷键、IPC |
| `preload.js` | 渲染进程可用的安全 API |
| `src/main/` | 配置、路径、资源下载、ASR、LLM、日志 |
| `src/renderer/` | 界面与音频采集（原生 HTML/CSS/JS，无框架） |
| `tools/check-asr.js` | 命令行自检 |

新增 IPC 时，请同时更新 `main.js` 与 `preload.js`，渲染进程只通过 `window.api` 访问主进程能力。

## 修改前建议

- 涉及本地识别：不要改动 `-c 8192 --parallel 1` 的上下文设置，这是 Qwen3-ASR 的既定精度配置
- 涉及窗口透明 / 置顶：不要在启动时禁用硬件加速，会导致透明窗口不绘制
- 涉及下载：保持 `%APPDATA%\interview-copilot\runtime` 这一目录约定，不要在程序目录写运行文件

## 自检

提交前至少确认：

1. `npm start` 能正常启动，主界面与设置页可交互
2. 设置 → 语音识别 → 一键下载 可以正常开始、取消、续传
3. `npm run check-asr -- <wav 文件>` 能完成「转写 → 生成回答」

## 提交与 PR

- 一个 PR 尽量只解决一个问题，附带简短说明和验证方式
- commit message 建议使用 `feat: / fix: / docs: / refactor: / chore:` 前缀
- 界面改动请附截图；修复类改动请说明复现步骤
- 不要提交 `config.json`、`runtime/`、`logs/`、`release/` 等本地产物

## Issue

- Bug 请使用 Bug 报告模板，附上版本号与日志片段（设置 → 界面 → 日志目录）
- 功能建议请说明使用场景，而不只是实现方式
