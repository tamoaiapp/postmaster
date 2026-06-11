# Win32 helpers para controle de Chrome real (sem Playwright).
# Carregado via Add-Type dentro de outros scripts.

Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class W32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, uint e);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint tid1, uint tid2, bool attach);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
    public const uint MOUSEEVENTF_LEFTUP = 0x04;
    public const int SW_RESTORE = 9;
    public const int SW_SHOWMAXIMIZED = 3;
    public const uint PW_RENDERFULLCONTENT = 0x00000002;
}
"@ -ReferencedAssemblies System.Drawing -ErrorAction SilentlyContinue

# Acha janela cujo titulo casa com padrao (regex)
function Find-Window([string]$pattern) {
    $found = $null
    $cb = [W32+EnumWindowsProc]{
        param($hwnd, $lp)
        if (-not [W32]::IsWindowVisible($hwnd)) { return $true }
        $sb = New-Object System.Text.StringBuilder 512
        [W32]::GetWindowText($hwnd, $sb, 512) | Out-Null
        $title = $sb.ToString()
        if ($title -match $pattern) {
            $script:found = @{ hwnd = $hwnd; title = $title }
            return $false
        }
        return $true
    }
    [W32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    return $script:found
}

# Tira screenshot via PrintWindow (captura janela mesmo escondida atras de outra).
# Mais robusto que CopyFromScreen que pega pixels da TELA (pode pegar o que tah na frente).
function Save-WindowScreenshot([IntPtr]$hwnd, [string]$outPath) {
    $r = New-Object W32+RECT
    [W32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { throw "Janela com dimensao invalida" }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [W32]::PrintWindow($hwnd, $hdc, [W32]::PW_RENDERFULLCONTENT)
    $g.ReleaseHdc($hdc)
    if (-not $ok) {
        # Fallback: CopyFromScreen (pega pixels da tela na posicao da janela)
        $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    }
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    return @{ x = $r.Left; y = $r.Top; w = $w; h = $h; path = $outPath; printWindow = $ok }
}

# Forca foco de janela (AttachThreadInput trick - contorna anti-focus-stealing do Windows)
function Set-WindowFocus([IntPtr]$hwnd) {
    $myTid = [W32]::GetCurrentThreadId()
    $fgWin = [W32]::GetForegroundWindow()
    $fgPid = 0
    $fgTid = [W32]::GetWindowThreadProcessId($fgWin, [ref]$fgPid)
    if ($fgTid -ne $myTid) {
        [W32]::AttachThreadInput($myTid, $fgTid, $true) | Out-Null
    }
    [W32]::ShowWindow($hwnd, [W32]::SW_RESTORE) | Out-Null
    [W32]::BringWindowToTop($hwnd) | Out-Null
    [W32]::SetForegroundWindow($hwnd) | Out-Null
    if ($fgTid -ne $myTid) {
        [W32]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null
    }
}

# Click humanizado em coord da tela (mouse move progressivo + hover + click)
function Invoke-HumanClick([int]$tx, [int]$ty) {
    $sx = 200 + (Get-Random -Min 0 -Max 400)
    $sy = 200 + (Get-Random -Min 0 -Max 300)
    [W32]::SetCursorPos($sx, $sy) | Out-Null
    Start-Sleep -Milliseconds 80
    for ($i = 1; $i -le 10; $i++) {
        $t = $i / 10.0
        $e = if ($t -lt 0.5) { 2 * $t * $t } else { 1 - [math]::Pow(-2 * $t + 2, 2) / 2 }
        $cx = [int]($sx + ($tx - $sx) * $e + (Get-Random -Min -2 -Max 3))
        $cy = [int]($sy + ($ty - $sy) * $e + (Get-Random -Min -2 -Max 3))
        [W32]::SetCursorPos($cx, $cy) | Out-Null
        Start-Sleep -Milliseconds (35 + (Get-Random -Min 0 -Max 25))
    }
    [W32]::SetCursorPos($tx, $ty) | Out-Null
    Start-Sleep -Milliseconds (450 + (Get-Random -Min 0 -Max 250))
    [W32]::mouse_event([W32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    Start-Sleep -Milliseconds (55 + (Get-Random -Min 0 -Max 50))
    [W32]::mouse_event([W32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
}
# v1.1.7 - Win32+UIA YT poster
