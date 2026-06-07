# Helpers Win32 chamaveis com argumentos.
# Uso:
#   powershell -File winhelpers.ps1 -Action find-window -Pattern "YouTube Studio"
#   powershell -File winhelpers.ps1 -Action screenshot -Hwnd 1234 -Out "img.png"
#   powershell -File winhelpers.ps1 -Action click -X 100 -Y 200
#   powershell -File winhelpers.ps1 -Action maximize -Hwnd 1234
#   powershell -File winhelpers.ps1 -Action focus -Hwnd 1234
#   powershell -File winhelpers.ps1 -Action sendkeys -Keys "^v"
#   powershell -File winhelpers.ps1 -Action setclip -Text "texto"

param(
    [Parameter(Mandatory=$true)] [string]$Action,
    [string]$Pattern,
    [Int64]$Hwnd,
    [string]$Out,
    [int]$X,
    [int]$Y,
    [string]$Keys,
    [string]$Text
)

. "$PSScriptRoot\win32.ps1"

function Get-WindowRectInfo([IntPtr]$h) {
    $r = New-Object W32+RECT
    [W32]::GetWindowRect($h, [ref]$r) | Out-Null
    return @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}

switch ($Action) {
    'find-window' {
        $r = Find-Window $Pattern
        if ($r) {
            $info = Get-WindowRectInfo $r.hwnd
            @{ hwnd = [Int64]$r.hwnd; title = $r.title; x = $info.x; y = $info.y; w = $info.w; h = $info.h } | ConvertTo-Json -Compress
        } else {
            "null"
        }
    }
    'screenshot' {
        $info = Save-WindowScreenshot ([IntPtr]$Hwnd) $Out
        @{ x = $info.x; y = $info.y; w = $info.w; h = $info.h; path = $info.path } | ConvertTo-Json -Compress
    }
    'click' {
        Invoke-HumanClick $X $Y
        "ok"
    }
    'maximize' {
        [W32]::ShowWindow([IntPtr]$Hwnd, [W32]::SW_SHOWMAXIMIZED) | Out-Null
        Start-Sleep -Milliseconds 800
        "ok"
    }
    'focus' {
        Set-WindowFocus ([IntPtr]$Hwnd)
        "ok"
    }
    'sendkeys' {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait($Keys)
        "ok"
    }
    'setclip' {
        Set-Clipboard -Value $Text
        "ok"
    }
    default {
        throw "Acao desconhecida: $Action"
    }
}
