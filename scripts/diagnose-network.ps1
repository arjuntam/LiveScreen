param([ValidateRange(1024,65535)][int]$Port = 8080)
# Read-only: never changes firewall, network profiles, services, credentials or media.
$ErrorActionPreference = 'Continue'
$reportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ('LiveScreen-network-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
function Test-PrivateIPv4([string]$Address) {
  $parts = $Address.Split('.')
  return $parts.Count -eq 4 -and ($parts[0] -eq '10' -or ($parts[0] -eq '192' -and $parts[1] -eq '168') -or ($parts[0] -eq '172' -and [int]$parts[1] -ge 16 -and [int]$parts[1] -le 31))
}
function Test-LiveScreenHTTP([string]$Address, [int]$TestPort) {
  $url = 'http://' + $Address + ':' + $TestPort + '/api/health'
  try {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Proxy = $null; $request.Timeout = 3000; $request.ReadWriteTimeout = 3000
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      [PSCustomObject]@{ URL=$url; Result=('HTTP ' + [int]$response.StatusCode); Detail=$body.Substring(0,[Math]::Min(240,$body.Length)) }
    } finally { $response.Close() }
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response) {
      try { [PSCustomObject]@{ URL=$url; Result=('HTTP ' + [int]$response.StatusCode); Detail='已到达 HTTP 服务，但请求被拒绝；旧版 health 接口可能返回 401。' } }
      finally { $response.Close() }
    } else { [PSCustomObject]@{ URL=$url; Result='无法连接'; Detail=$_.Exception.Message } }
  }
}
& {
  'LiveScreen 局域网只读诊断'; Get-Date
  '此报告不含配对码、管理口令、浏览器凭证或素材。不会修改任何系统设置。'
  '=== 软件进程 ==='
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='LiveScreen.exe'" -ErrorAction Continue)
  $processes | Select-Object Name,ProcessId,ExecutablePath | Format-List
  if ($processes.Count -eq 0) { '未发现 LiveScreen.exe。请先打开软件，再运行诊断。' }
  '=== 保存端口（只读） ==='
  $settings = Join-Path $env:APPDATA 'LiveScreen\settings.json'
  if (Test-Path -LiteralPath $settings) {
    try {
      $saved = Get-Content -LiteralPath $settings -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($saved.port -ge 1024 -and $saved.port -le 65535) { $Port = [int]$saved.port }
    } catch { '无法读取默认位置的端口配置，继续使用参数端口。' }
  }
  '检查端口：' + $Port
  '=== 网卡地址与网络类别 ==='
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Continue | Where-Object { $_.AddressState -eq 'Preferred' -and (Test-PrivateIPv4 $_.IPAddress) })
  $addresses | Select-Object InterfaceAlias,InterfaceIndex,IPAddress,PrefixLength | Format-Table -AutoSize
  Get-NetConnectionProfile -ErrorAction Continue | Select-Object InterfaceAlias,NetworkCategory,IPv4Connectivity | Format-Table -AutoSize
  if ($addresses.Count -eq 0) { '未发现可用私有 IPv4 地址。连接公司网络后重试。' }
  '=== 监听端口与占用进程 ==='
  $processIds = @($processes | ForEach-Object { [int]$_.ProcessId })
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Continue | Where-Object { $_.LocalPort -eq $Port -or $_.OwningProcess -in $processIds })
  $listeners | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize
  $testPorts = @($Port) + @($listeners | Where-Object { $_.OwningProcess -in $processIds } | ForEach-Object { [int]$_.LocalPort })
  $testPorts = @($testPorts | Select-Object -Unique)
  '=== 本机 HTTP 实际访问（每项最多约 3 秒） ==='
  foreach ($testPort in $testPorts) {
    Test-LiveScreenHTTP '127.0.0.1' $testPort | Format-List
    foreach ($address in $addresses) { Test-LiveScreenHTTP $address.IPAddress $testPort | Format-List }
  }
  '=== Windows 防火墙配置（只读） ==='
  Get-NetFirewallProfile -ErrorAction Continue | Select-Object Name,Enabled,DefaultInboundAction | Format-Table -AutoSize
  $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Continue | Where-Object { $_.DisplayName -like '*LiveScreen*' -or $_.Name -like '*LiveScreen*' })
  foreach ($exe in @($processes.ExecutablePath | Where-Object { $_ } | Select-Object -Unique)) {
    $rules += @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $exe -ErrorAction Continue | Get-NetFirewallRule -ErrorAction Continue)
  }
  $rules = @($rules | Sort-Object Name -Unique)
  if ($rules.Count -eq 0) { '未查到 LiveScreen 专用规则；这不是完整的有效策略判断，仍需结合 IT 管理策略。' }
  foreach ($rule in $rules) {
    $rule | Select-Object Name,DisplayName,Enabled,Direction,Action,Profile | Format-List
    $rule | Get-NetFirewallApplicationFilter -ErrorAction Continue | Select-Object Program | Format-List
    $rule | Get-NetFirewallPortFilter -ErrorAction Continue | Select-Object Protocol,LocalPort | Format-List
    $rule | Get-NetFirewallAddressFilter -ErrorAction Continue | Select-Object RemoteAddress | Format-List
  }
  '=== 判读提示 ==='
  '1. 回环和电脑自身的内网地址均失败：检查软件是否运行、监听端口是否正确、是否被其他程序占用。'
  '2. 回环成功、内网地址失败：检查监听列表与网卡是否对应，再看本机安全软件/防火墙策略。'
  '3. 电脑自身内网地址成功、手机失败：继续检查防火墙入站、手机认证、子网/VLAN 和客户端隔离。'
  '4. 网络类别为 DomainAuthenticated 或 Public 时，仅 Private 规则不会覆盖该类别；交给 IT 确认，不要关闭防火墙。'
  '5. 本工具不能从电脑端证明手机可达，也不能判断所在网络的认证是否完成。请保留手机浏览器报错和扫码地址。'
} 2>&1 | Out-File -LiteralPath $reportPath -Encoding UTF8 -Width 220
Write-Host ('报告已保存：' + $reportPath)
Write-Host '请把这份 txt 报告交给开发排查。本工具没有更改网络或防火墙。'
