# Upload de video no YouTube Studio via Chrome real + Win32 (sem Playwright).
#
# Uso: powershell.exe -File upload-yt.ps1 -VideoPath "C:\path\video.mp4" -Title "Titulo" [-Description "desc"]
#
# Pre-requisitos:
#   - Chrome instalado e LOGADO na conta Google do canal alvo
#   - Video MP4 acessivel localmente
#
# Flow:
#   1. Abre Chrome em studio.youtube.com
#   2. Maximize + foco
#   3. Click "Criar" (canto sup direito) → menu abre
#   4. Click "Enviar videos" → file dialog OS abre
#   5. Cola path do video + Enter → upload comeca
#   6. Aguarda dialog de detalhes (titulo/descricao)
#   7. Click no titulo → cola texto via clipboard + Ctrl+V
#   8. Click descricao → cola texto
#   9. Click "Nao eh conteudo para criancas"
#  10. Click "Avancar" 3x ate visibilidade
#  11. Click "Privado"
#  12. Click "Publicar"

param(
    [Parameter(Mandatory=$true)] [string]$VideoPath,
    [Parameter(Mandatory=$true)] [string]$Title,
    [string]$Description = "",
    [string]$Visibility = "private",  # private | unlisted | public
    [switch]$KidsContent = $false
)

. "$PSScriptRoot\win32.ps1"

$outDir = "$PSScriptRoot\out"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$ts = (Get-Date).ToString("yyyyMMdd-HHmmss")

function Snap([string]$label) {
    $path = "$outDir\$label-$ts.png"
    Save-WindowScreenshot $script:hwnd $path | Out-Null
    Write-Host "  screenshot: $label"
    return $path
}

# Helper: relativo aa janela (info atual)
function Click-Rel([double]$px, [double]$py, [string]$label = "") {
    $info = Get-WindowRect $script:hwnd
    $x = [int]($info.x + $info.w * $px)
    $y = [int]($info.y + $info.h * $py)
    if ($label) { Write-Host "  click '$label' em ($x, $y)  rel($px, $py)" }
    Invoke-HumanClick $x $y
}

function Get-WindowRect([IntPtr]$hwnd) {
    $r = New-Object W32+RECT
    [W32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    return @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
}

function Type-Via-Clipboard([string]$text) {
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 200
    # Ctrl+V
    [W32]::mouse_event(0, 0, 0, 0, 0) | Out-Null  # noop pra garantir foco do mouse
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 300
}

# === STEP 1: abrir Chrome ===
Write-Host "[1] Validando video..."
if (-not (Test-Path $VideoPath)) { throw "Video nao existe: $VideoPath" }
$videoFull = (Resolve-Path $VideoPath).Path
Write-Host "  video: $videoFull"
Write-Host "  titulo: $Title"

Write-Host "[2] Abrindo Chrome normal..."
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
Start-Process -FilePath $chrome -ArgumentList "--new-window", "https://studio.youtube.com/"
Write-Host "  aguardando 14s pra Studio carregar..."
Start-Sleep -Seconds 14

# === STEP 3: achar janela ===
Write-Host "[3] Achando janela Studio..."
$win = Find-Window 'YouTube Studio'
if (-not $win) { throw "Janela Studio nao encontrada" }
$script:hwnd = $win.hwnd
Write-Host "  encontrada: $($win.title)"

Write-Host "[4] Maximizando + foco..."
[W32]::ShowWindow($script:hwnd, [W32]::SW_SHOWMAXIMIZED) | Out-Null
Start-Sleep -Milliseconds 1500
Set-WindowFocus $script:hwnd
Start-Sleep -Milliseconds 800
Snap "01-studio-ready" | Out-Null

# === STEP 5: click "Criar" ===
Write-Host "[5] Click no botao Criar (canto sup direito)..."
# Em layout 1920x1080 typical, "Criar" fica em ~(1850, 105) — relativo: (0.96, 0.10)
Click-Rel 0.93 0.10 "Criar"
Start-Sleep -Seconds 2
Snap "02-after-criar" | Out-Null

# === STEP 6: click "Enviar videos" ===
Write-Host "[6] Click em Enviar videos (1o item do menu Criar)..."
# Menu aparece logo abaixo do Criar — item em ~(1800, 165)
Click-Rel 0.91 0.17 "Enviar videos"
Start-Sleep -Seconds 3
Snap "03-after-enviar" | Out-Null

# === STEP 7: file dialog OS abre ===
Write-Host "[7] Aguardando file dialog do Windows abrir..."
Start-Sleep -Seconds 2
# Type o path completo na address bar do dialog (Ctrl+L em explorer focus + cola)
Add-Type -AssemblyName System.Windows.Forms
Set-Clipboard -Value $videoFull
[System.Windows.Forms.SendKeys]::SendWait("^l")
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Host "  path enviado: $videoFull"
Start-Sleep -Seconds 4
Snap "04-after-file-selected" | Out-Null

# === STEP 8: aguarda dialog de detalhes abrir ===
Write-Host "[8] Aguardando dialog de detalhes (10s)..."
Start-Sleep -Seconds 10
Snap "05-details-dialog" | Out-Null

# === STEP 9: titulo ===
Write-Host "[9] Limpando titulo e digitando '$Title'..."
# Campo titulo fica ~ (0.35, 0.27) na janela maximizada
Click-Rel 0.35 0.27 "campo titulo"
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{DELETE}")
Start-Sleep -Milliseconds 200
Type-Via-Clipboard $Title
Snap "06-after-title" | Out-Null

# === STEP 10: descricao (opcional) ===
if ($Description) {
    Write-Host "[10] Descricao..."
    Click-Rel 0.35 0.43 "campo descricao"
    Start-Sleep -Milliseconds 400
    Type-Via-Clipboard $Description
    Snap "07-after-desc" | Out-Null
}

# === STEP 11: kids ===
Write-Host "[11] Audiencia kids..."
$kidsOption = if ($KidsContent) { 0.30 } else { 0.36 }  # Y do radio "Sim" vs "Nao"
Click-Rel 0.27 $kidsOption "audiencia"
Start-Sleep -Milliseconds 600
Snap "08-after-kids" | Out-Null

# === STEP 12: Avancar 3x ===
Write-Host "[12] Avancando 3x ate visibilidade..."
for ($i = 1; $i -le 3; $i++) {
    # Botao Avancar fica no canto inferior direito do dialog
    Click-Rel 0.78 0.92 "Avancar #$i"
    Start-Sleep -Seconds 3
    Snap "09-step-$i" | Out-Null
}

# === STEP 13: visibilidade ===
Write-Host "[13] Selecionando visibilidade: $Visibility"
$visY = switch ($Visibility) { 'private' { 0.40 } 'unlisted' { 0.46 } 'public' { 0.34 } default { 0.40 } }
Click-Rel 0.27 $visY "vis-$Visibility"
Start-Sleep -Milliseconds 800
Snap "10-after-vis" | Out-Null

# === STEP 14: Publicar ===
Write-Host "[14] Click Publicar..."
Click-Rel 0.78 0.92 "Publicar"
Start-Sleep -Seconds 5
Snap "11-after-publish" | Out-Null

Write-Host ""
Write-Host "=== FLOW COMPLETO ==="
Write-Host "Screenshots em: $outDir"
Write-Host "Verifica 11-after-publish.png pra ver se publicou."
