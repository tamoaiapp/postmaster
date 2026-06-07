# POC: abre Chrome normal (sem Playwright/CDP) em studio.youtube.com,
# acha a janela, tira screenshot, testa Win32 click.
# Objetivo: provar que Google NAO rejeita esse Chrome (vs Playwright que rejeitava).

. "$PSScriptRoot\win32.ps1"

$outDir = "$PSScriptRoot\out"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host "[1/5] Abrindo Chrome normal pra studio.youtube.com..."
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { throw "Chrome.exe nao encontrado" }

# Abre NOVA janela (--new-window) usando perfil do user (sem flags suspeitas)
Start-Process -FilePath $chrome -ArgumentList "--new-window", "https://studio.youtube.com/"
Write-Host "  Aguardando 12s pra Studio carregar (login persistente do user vale)..."
Start-Sleep -Seconds 12

Write-Host "[2/5] Procurando janela do Studio..."
$win = Find-Window 'YouTube Studio'
if (-not $win) {
    Write-Host "  janela nao achada. Janelas Chrome visiveis:"
    Get-Process chrome -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | ForEach-Object {
        Write-Host "    PID $($_.Id): $($_.MainWindowTitle)"
    }
    throw "Janela YouTube Studio nao encontrada"
}
Write-Host "  encontrada: $($win.title)  HWND=$($win.hwnd)"

Write-Host "[3/6] Maximizar Chrome + foco + screenshot inicial..."
[W32]::ShowWindow($win.hwnd, [W32]::SW_SHOWMAXIMIZED) | Out-Null
Start-Sleep -Milliseconds 800
Set-WindowFocus $win.hwnd
Start-Sleep -Milliseconds 800

$ts = (Get-Date).ToString("yyyyMMdd-HHmmss")
$shot = "$outDir\01-studio-maximized-$ts.png"
$info = Save-WindowScreenshot $win.hwnd $shot
Write-Host "  screenshot: $shot  ($($info.w)x$($info.h)  origem ($($info.x), $($info.y)))"

Write-Host "[4/6] Teste click Win32 no menu HAMBURGUER (canto sup esq, sempre visivel)..."
# Hamburguer fica em ~(50, 130) absoluto numa janela maximizada.
# Top bar do Chrome (titlebar+tabs+URL): ~110-130px. Hamburguer em x=20, y=20 da viewport.
$clickX = $info.x + 50
$clickY = $info.y + 135
Write-Host "  click em ($clickX, $clickY) â€” esperando sidebar colapsar/expandir..."
Invoke-HumanClick $clickX $clickY
Start-Sleep -Seconds 2

$shot2 = "$outDir\02-after-hamburger-$ts.png"
Save-WindowScreenshot $win.hwnd $shot2 | Out-Null
Write-Host "  screenshot pos-click: $shot2"

Write-Host "[5/6] Teste click no botao CRIAR (canto sup dir, sempre presente)..."
$clickX2 = $info.x + $info.w - 120
$clickY2 = $info.y + 135
Write-Host "  click em ($clickX2, $clickY2)..."
Invoke-HumanClick $clickX2 $clickY2
Start-Sleep -Seconds 2

$shot3 = "$outDir\03-after-criar-$ts.png"
Save-WindowScreenshot $win.hwnd $shot3 | Out-Null
Write-Host "  screenshot pos-criar: $shot3"

Write-Host "[6/6] Screenshots:"
Write-Host "  01 inicial: $shot"
Write-Host "  02 pos-hamburger: $shot2"
Write-Host "  03 pos-criar: $shot3"
