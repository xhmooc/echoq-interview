<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="EchoQ Interview" />
</p>

<h1 align="center">应声面试 · EchoQ-Interview</h1>

<p align="center">
  Windows 桌面面试 / 笔试助手：听清面试官的问题，给出可以直接说出口的回答。
</p>

<p align="center">
  <a href="https://github.com/xhmooc/echoq-interview/releases/latest"><img src="https://img.shields.io/github/v/release/xhmooc/echoq-interview?label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/license-MIT-22c993" alt="License" />
</p>

| 面试演示 | 笔试演示 |
| --- | --- |
| ![面试演示](docs/ui/interview.gif) | ![笔试演示](docs/ui/written.gif) |

应声面试是一个 Windows 桌面悬浮窗助手。它实时听清面试官的问题，转成文字，并用大模型流式生成能直接说出口的回答；笔试模式下框选题目截图，识别后生成答案。

## 功能

- **本地离线语音识别**：安装包内置 llama.cpp 引擎，首次在应用内下载 Qwen3-ASR 模型，之后语音识别完全离线运行
- **两路收音**：直接抓取电脑声音（面试官的声音），也可以切到麦克风（现场面试）
- **实时回答**：识别到问题自动生成，也可以随时按快捷键手动作答
- **笔试截图答题**：切到笔试模式，框选题目即可 OCR + 大模型作答；答案可显示在置顶悬浮窗，也可推到手机副屏
- **悬浮窗设计**：置顶、可拖动、鼠标穿透、防录屏隐身
- **账号登录即用**：回答由 EchoQ 云端生成，登录账号后自动生效，不需要填写接口地址或 Key
- **可自带 Key**：大模型、语音识别、笔试视觉识别都可以改用自己接入的 OpenAI 兼容服务

> 仅用于个人学习与技术面试准备，请在符合当地法律与面试方规定的前提下使用。

## 快速开始

下载安装包：[GitHub Releases](https://github.com/xhmooc/echoq-interview/releases/latest) · [官网下载页](https://job.echoq.cn/#download)

从源码运行：

```bash
npm install
npm start
```

需要 Node.js 18+ 与 Windows 10 / 11。首次启动如果缺少本地引擎或模型，按界面提示下载；也可以在设置里接入自己的服务。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `main.js` / `preload.js` | 主进程：窗口、快捷键、IPC |
| `src/main/` | 配置、路径、资源下载、ASR、LLM、账号与日志 |
| `src/renderer/` | 界面与音频采集（原生 HTML / CSS / JS，无框架） |
| `tools/` | 命令行自检与引擎准备脚本 |
| `website/` | 官网静态页 |
| `build/` | 图标与打包资源 |

## 架构

客户端完全在本机运行：采集声音 → 本地语音识别 → 云端生成回答 → 悬浮窗渲染。账号、计时、云端 ASR 与大模型中转、自动更新由 EchoQ 提供，不属于本仓库。

## EchoQ 系列

- **应声面试（EchoQ Interview）**：本仓库 · [官网](https://job.echoq.cn/)
- **应声运营（EchoQ Ops）**：[GitHub](https://github.com/xhmooc/echoq-ops) · [官网](https://ops.echoq.cn/)

## 许可证

[MIT](LICENSE)。产品名称、Logo 与 EchoQ 云端服务不在授权范围内。
