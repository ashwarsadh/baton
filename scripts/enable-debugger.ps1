param([switch]$Force, [int]$Port = 9229)
# enable-debugger.ps1 - switch on Claude Desktop's main-process debugger for Baton (Windows).
#
# Clicks Menu > Developer > Enable Main Process Debugger in the Claude Desktop window through UI
# Automation, then dismisses the confirmation dialog. Developer mode must be on in Claude Desktop
# (Help > Troubleshooting > Enable Developer Mode). The window is raised only if its accessibility
# tree is not available, and focus is handed back to whatever you were using afterwards.
# Exit code 0 = debugger listening. It must run in your interactive desktop session.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class N {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  public const uint LEFTDOWN=0x02, LEFTUP=0x04;
}
"@
$ErrorActionPreference = 'Stop'
$UIA = [System.Windows.Automation.AutomationElement]; $root = $UIA::RootElement
$DESC = [System.Windows.Automation.TreeScope]::Descendants
function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -f HH:mm:ss), $m) }
function IsUp { [bool](netstat -ano | Select-String "127.0.0.1:$Port" | Select-String "LISTENING") }
function Find($name) { $c = New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $name); try { return $root.FindFirst($DESC, $c) } catch { return $null } }
function Center($el) { $r = $el.Current.BoundingRectangle; return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) }
function MoveTo($el) { $p = Center $el; [void][N]::SetCursorPos($p[0], $p[1]) }
function RealClick($el) { $p = Center $el; [void][N]::SetCursorPos($p[0], $p[1]); Start-Sleep -Milliseconds 120; [N]::mouse_event([N]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [N]::mouse_event([N]::LEFTUP, 0, 0, 0, [IntPtr]::Zero) }

function Finish([int]$code) {
  try {
    if ($script:tgt) { [void][N]::AttachThreadInput($script:my, $script:tgt, $false) }
    if ($script:fg) { [void][N]::AttachThreadInput($script:my, $script:fg, $false) }
    if ($script:prevFgWin -and $script:prevFgWin -ne [IntPtr]::Zero -and $script:prevFgWin -ne $script:h) {
      [void][N]::SetForegroundWindow($script:prevFgWin)
    }
  } catch {}
  exit $code
}

if ((IsUp) -and (-not $Force)) { Log 'debugger already on'; exit 0 }
$cl = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $cl) { Log 'Claude Desktop is not running (or has no window)'; exit 1 }
$h = $cl.MainWindowHandle; $script:h = $h

$script:my = [N]::GetCurrentThreadId()
$script:prevFgWin = [N]::GetForegroundWindow()
$wasMinimized = [N]::IsIconic($h)

# Chromium only builds its accessibility tree for a foreground window; use it in place if it exists.
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$probe = $null
if ($root) { $probe = $root.FindFirst($DESC, (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, 'Menu'))) }

$raised = $false
if ($probe) {
  $raised = $true
  $script:prevFgWin = [IntPtr]::Zero
} else {
  $script:fg = [N]::GetWindowThreadProcessId($script:prevFgWin, [IntPtr]::Zero)
  $script:tgt = [N]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
  [void][N]::AttachThreadInput($script:my, $script:fg, $true)
  [void][N]::AttachThreadInput($script:my, $script:tgt, $true)
  for ($i = 0; $i -lt 5; $i++) {
    if ($wasMinimized) { [void][N]::ShowWindow($h, 9) } else { [void][N]::ShowWindow($h, 4) }
    [void][N]::BringWindowToTop($h)
    [void][N]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 700
    if ([N]::GetForegroundWindow() -eq $h) { $raised = $true; break }
  }
}
if (-not $raised) { Log 'could not bring Claude Desktop to the foreground'; Finish 7 }
Start-Sleep -Milliseconds 1200

$menu = Find 'Menu'
if (-not $menu) { Log 'Menu not found (accessibility tree not built)'; Finish 2 }
RealClick $menu; Start-Sleep -Milliseconds 1200

$dev = Find 'Developer'
if (-not $dev) { Log 'Developer menu not found - turn on Help > Troubleshooting > Enable Developer Mode first'; Finish 3 }
MoveTo $dev; Start-Sleep -Milliseconds 1300   # a submenu opens on hover, not on click

$dbg = Find 'Enable Main Process Debugger'
if (-not $dbg) { Log 'Enable Main Process Debugger not found'; Finish 4 }
RealClick $dbg; Start-Sleep -Milliseconds 1600

$up = $false
for ($i = 0; $i -lt 25; $i++) { Start-Sleep -Milliseconds 300; if (IsUp) { $up = $true; break } }
if (-not $up) { Log "debugger did not start on port $Port"; Finish 5 }

# Enabling also shows a modal "Inspector" dialog; its default button is OK.
Start-Sleep -Milliseconds 700
$ok = Find 'OK'
if ($ok -and $ok.Current.ControlType.ProgrammaticName -match 'Button') { RealClick $ok }
else { try { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') } catch {} }
Start-Sleep -Milliseconds 700

if (IsUp) { Log "debugger on (port $Port)"; Finish 0 }
Log 'debugger stopped again'
Finish 6
