# Interview Copilot launcher: start the app. The ASR engine is managed inside the app.
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$logDir = Join-Path $env:APPDATA 'interview-copilot-pro\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Note($msg) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 (Join-Path $logDir 'launcher.log') }
Note 'launcher start'

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Note "electron not found: $electron"
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("没有找到 Electron 运行环境。`n请先在项目目录执行 npm install。", "应声面试") | Out-Null
  exit 1
}

$app = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root -PassThru
Note "app pid=$($app.Id)"

if ($app) { Wait-Process -Id $app.Id }
Note 'launcher exit'
