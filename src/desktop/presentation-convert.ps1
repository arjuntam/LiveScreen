param([Parameter(Mandatory=$true)][string]$InputFile,
      [Parameter(Mandatory=$true)][string]$OutputFile,
      [Parameter(Mandatory=$true)][string]$OwnerFile)
$ErrorActionPreference = 'Stop'
$application = $null; $presentation = $null; $owned = $false
$security = $null; $alerts = $null
try {
  $before = @(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $application = New-Object -ComObject PowerPoint.Application
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LiveScreenPptWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'
  [uint32]$processId = 0
  [void][LiveScreenPptWindow]::GetWindowThreadProcessId([IntPtr]$application.HWND, [ref]$processId)
  if ($processId -gt 0 -and $before -notcontains [int]$processId) {
    $owned = $true
    $process = Get-Process -Id $processId
    @{id=[int]$processId; ticks=$process.StartTime.Ticks.ToString()} | ConvertTo-Json -Compress | Set-Content -LiteralPath $OwnerFile -Encoding UTF8
  }
  $security = $application.AutomationSecurity; $alerts = $application.DisplayAlerts
  $application.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
  $application.DisplayAlerts = 1 # ppAlertsNone
  # Read-only, not untitled, without a presentation window. Never save the source.
  $presentation = $application.Presentations.Open($InputFile, -1, 0, 0)
  $presentation.SaveAs($OutputFile, 32) # ppSaveAsPDF
  if (-not (Test-Path -LiteralPath $OutputFile)) { throw 'PDF export did not produce a file' }
} finally {
  if ($null -ne $presentation) { try { $presentation.Close() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
  if ($null -ne $application) {
    if ($null -ne $security) { try { $application.AutomationSecurity = $security } catch {} }
    if ($null -ne $alerts) { try { $application.DisplayAlerts = $alerts } catch {} }
    if ($owned) { try { $application.Quit() } catch {} }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
