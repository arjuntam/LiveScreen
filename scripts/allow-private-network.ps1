#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory=$true)][string]$ExecutablePath,
  [ValidateRange(1024,65535)][int]$Port = 8080
)
$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([System.IO.Path]::GetFileName($resolvedExecutable) -ne 'LiveScreen.exe') { throw '请选择实际安装的 LiveScreen.exe' }
$ruleName = 'LiveScreen-LAN-Private'
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name $ruleName -DisplayName 'LiveScreen trusted LAN only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $resolvedExecutable -Profile Private -RemoteAddress LocalSubnet | Out-Null
Write-Host "已允许专用网络本地子网访问 LiveScreen，端口 $Port。请确认 Wi-Fi 与有线网互通。"
Write-Host "移除此规则：Remove-NetFirewallRule -Name $ruleName"
