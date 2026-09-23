# tray.ps1 - Baton's Windows tray icon. Keeps the daemon running and gives one-click access to the
# app, phone pairing and settings. Started by `baton tray` or the `baton autostart` logon task.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
$Data = if ($env:BATON_HOME) { $env:BATON_HOME } else { Join-Path $env:USERPROFILE '.baton' }

# One tray per user.
$mutex = New-Object System.Threading.Mutex($false, 'Local\BatonTray')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Settings {
  $s = @{ port = 8788; appPort = 8790 }
  try {
    $j = Get-Content (Join-Path $Data 'settings.json') -Raw | ConvertFrom-Json
    if ($j.port) { $s.port = [int]$j.port }
    if ($j.appPort) { $s.appPort = [int]$j.appPort }
  } catch {}
  return $s
}
function Token {
  try { return (Get-Content (Join-Path $Data 'mobile\secret.json') -Raw | ConvertFrom-Json).token } catch { return '' }
}
function Node {
  $n = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $n) { $n = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  return $n
}
function Healthy {
  $s = Settings
  try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$($s.port)/api/health"; return $r.StatusCode -eq 200 } catch { return $false }
}
function StartDaemon {
  if (Healthy) { return }
  $log = Join-Path $Data 'state\daemon-stdio.log'
  New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
  $p = New-Object System.Diagnostics.ProcessStartInfo
  $p.FileName = Node
  $p.Arguments = '"' + (Join-Path $Root 'server.js') + '"'
  $p.WorkingDirectory = $env:USERPROFILE
  $p.UseShellExecute = $false
  $p.CreateNoWindow = $true
  [System.Diagnostics.Process]::Start($p) | Out-Null
}
function StopDaemon {
  $s = Settings
  try { Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 5 "http://127.0.0.1:$($s.port)/api/shutdown" | Out-Null } catch {}
}
function OpenApp([string]$hash) {
  $s = Settings
  $url = "http://127.0.0.1:$($s.appPort)/?k=" + [uri]::EscapeDataString((Token)) + $hash
  Start-Process $url
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$png = Join-Path $Root 'assets\tray.png'
if (Test-Path $png) { $bmp = New-Object System.Drawing.Bitmap $png; $icon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon()) }
else { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'Baton'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add('Starting...'); $status.Enabled = $false
[void]$menu.Items.Add('-')
$menu.Items.Add('Open Baton', $null, { OpenApp '' }) | Out-Null
$menu.Items.Add('Pair a phone (QR code)', $null, { OpenApp '#pair' }) | Out-Null
$menu.Items.Add('Settings', $null, { OpenApp '#settings' }) | Out-Null
[void]$menu.Items.Add('-')
$menu.Items.Add('Restart Baton', $null, { StopDaemon; Start-Sleep -Seconds 3; StartDaemon }) | Out-Null
$menu.Items.Add('Quit (stop Baton)', $null, {
  StopDaemon; $icon.Visible = $false; $icon.Dispose(); [System.Windows.Forms.Application]::Exit()
}) | Out-Null
$icon.ContextMenuStrip = $menu
$icon.add_MouseDoubleClick({ OpenApp '' })

StartDaemon

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 20000
$timer.add_Tick({
  if (Healthy) { $status.Text = 'Baton is running'; $icon.Text = 'Baton - running' }
  else { $status.Text = 'Baton stopped - restarting'; $icon.Text = 'Baton - restarting'; StartDaemon }
})
$timer.Start()
$status.Text = 'Baton is running'

[System.Windows.Forms.Application]::Run()
