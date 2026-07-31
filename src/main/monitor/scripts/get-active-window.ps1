# get-active-window.ps1
#
# Returns the foreground window's process name, window title, and executable
# path as a single JSON object on stdout. Run with:
#
#   powershell.exe -NoProfile -NonInteractive -File get-active-window.ps1
#
# On UWP / Windows 11 ApplicationFrameHost-wrapped windows we walk one level
# down to the real child process (CoreWindow) so the app name reflects the
# actual app the user sees (e.g. "Calculator") instead of the frame host.
#
# Output shape:
#   { "app_name": "chrome", "window_title": "Inbox", "process_path": "C:\\..." }
#
# On error or when there is no foreground window, prints `{}` and exits 0 so
# the caller's JSON parse doesn't blow up. The caller treats missing fields
# as nulls.

$ErrorActionPreference = 'Stop'

try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class TaskPilotForeground {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
}
"@

    $hwnd = [TaskPilotForeground]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Output '{}'
        exit 0
    }

    $titleLen = [TaskPilotForeground]::GetWindowTextLength($hwnd)
    $title = ''
    if ($titleLen -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($titleLen + 1)
        [void][TaskPilotForeground]::GetWindowText($hwnd, $sb, $sb.Capacity)
        $title = $sb.ToString()
    }

    $procId = 0
    [void][TaskPilotForeground]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -le 0) {
        Write-Output '{}'
        exit 0
    }

    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        Write-Output '{}'
        exit 0
    }

    # UWP apps render under ApplicationFrameHost — walk one level into the
    # frame to find the real CoreWindow child process so the app name reflects
    # the app the user actually sees.
    if ($proc.ProcessName -eq 'ApplicationFrameHost') {
        $childPid = 0
        $cb = [TaskPilotForeground+EnumWindowsProc]{
            param($childHwnd, $lParam)
            $cpid = 0
            [void][TaskPilotForeground]::GetWindowThreadProcessId($childHwnd, [ref]$cpid)
            if ($cpid -ne 0 -and $cpid -ne $procId) {
                $script:childPid = $cpid
                return $false
            }
            return $true
        }
        [void][TaskPilotForeground]::EnumChildWindows($hwnd, $cb, [IntPtr]::Zero)
        if ($childPid -ne 0) {
            $childProc = Get-Process -Id $childPid -ErrorAction SilentlyContinue
            if ($null -ne $childProc) {
                $proc = $childProc
            }
        }
    }

    $exePath = $null
    try { $exePath = $proc.Path } catch { $exePath = $null }

    $payload = [PSCustomObject]@{
        app_name = $proc.ProcessName
        window_title = $title
        process_path = $exePath
    }

    $payload | ConvertTo-Json -Compress
} catch {
    Write-Output '{}'
    exit 0
}
