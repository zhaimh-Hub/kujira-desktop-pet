# 一键准备：装依赖 + 把页面装进 player 的 example 目录
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$player = Join-Path (Split-Path $here -Parent) 'player'

Write-Host "== 检查上游 player 库 ==" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $player 'dist\index.js'))) {
  Write-Host "找不到 ../player/dist/index.js" -ForegroundColor Yellow
  Write-Host "请先：git clone https://github.com/livliv-dev/player.git ..\player && cd ..\player && pnpm install && pnpm build" -ForegroundColor Yellow
  exit 1
}

Write-Host "== 把页面装进 player/example ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $player 'example') | Out-Null
Get-ChildItem (Join-Path $here 'pages') -Filter *.html | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $player "example\$($_.Name)") -Force
  Write-Host "  + example\$($_.Name)"
}

Write-Host "== 安装 electron ==" -ForegroundColor Cyan
Push-Location $here
npm install
Pop-Location

if (-not (Test-Path (Join-Path $here 'config.json'))) {
  Copy-Item (Join-Path $here 'config.example.json') (Join-Path $here 'config.json')
  Write-Host "已生成 config.json，记得填 deepseekKey（或设置环境变量 DEEPSEEK_API_KEY）" -ForegroundColor Yellow
}
Write-Host "完成。运行 npm start 启动桌宠。" -ForegroundColor Green