# Drena rascunhos de um canal YouTube — abre Studio, itera lista de Rascunhos,
# publica cada um (Publicos + espera verificacao + handle modal).
#
# v1.3.20: complemento do upload-yt.ps1 — o uploader pode terminar com video
# em rascunho se verificacao do YT atrasou. Esse script roda em paralelo via
# cron 15min e drena rascunhos residuais.
#
# Uso: powershell -File publish-drafts.ps1 -ChannelId UCxxx [-MaxToPublish 5] [-Visibility public]

param(
    [Parameter(Mandatory=$true)] [string]$ChannelId,
    [int]$MaxToPublish = 5,
    [string]$Visibility = "public"
)

# --- Lock: skip se upload-yt.ps1 esta rodando ---
$lockFile = "$env:TEMP\postmaster-yt-busy.lock"
if (Test-Path $lockFile) {
    $age = ((Get-Date) - (Get-Item $lockFile).LastWriteTime).TotalMinutes
    if ($age -lt 30) {
        Write-Host "AVISO: upload-yt.ps1 esta rodando (lock $lockFile com $([math]::Round($age,1))min) - skip"
        Write-Host "DRAFTS_PUBLISHED:0"
        exit 0
    }
    Write-Host "Lock antigo ($([math]::Round($age,1))min) - ignorando"
    Remove-Item $lockFile -ErrorAction SilentlyContinue
}
# Cria proprio lock pra outros workers (upload-yt tb skipa se ja tem)
"publish-drafts $PID $(Get-Date -Format o)" | Out-File -FilePath $lockFile -Encoding utf8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
. "$PSScriptRoot\win32.ps1"

$outDir = "$PSScriptRoot\out"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$ts = (Get-Date).ToString("yyyyMMdd-HHmmss")

function Snap([string]$label) {
    $path = "$outDir\drafts-$label-$ts.png"
    try { Save-WindowScreenshot $script:hwnd $path | Out-Null } catch {}
    Write-Host "  [shot] $label"
}

function Get-RootAE { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$script:hwnd) }

function Remove-Diacritics([string]$s) {
    if (-not $s) { return '' }
    $sb = New-Object System.Text.StringBuilder
    foreach ($c in $s.Normalize([System.Text.NormalizationForm]::FormD).ToCharArray()) {
        if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($c)
        }
    }
    return $sb.ToString()
}

function Find-UIA-Like([string]$substr, [string]$controlType = $null, [int]$timeoutMs = 8000) {
    $needle = (Remove-Diacritics $substr).ToLower()
    $start = Get-Date
    while (((Get-Date) - $start).TotalMilliseconds -lt $timeoutMs) {
        $root = Get-RootAE
        if ($controlType) {
            $ctMember = [System.Windows.Automation.ControlType]::$controlType
            $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMember)
            $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
        } else {
            $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        }
        foreach ($el in $els) {
            $n = $el.Current.Name
            if (-not $n) { continue }
            $nNorm = (Remove-Diacritics $n).ToLower()
            if ($nNorm.Contains($needle)) { return $el }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Find-UIA-Like-InBounds([string]$substr, [string]$controlType, [int]$yMin = 0, [int]$yMax = 9999, [int]$timeoutMs = 5000) {
    $needle = (Remove-Diacritics $substr).ToLower()
    $start = Get-Date
    while (((Get-Date) - $start).TotalMilliseconds -lt $timeoutMs) {
        $root = Get-RootAE
        if ($controlType) {
            $ctMember = [System.Windows.Automation.ControlType]::$controlType
            $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMember)
            $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
        } else {
            $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        }
        foreach ($el in $els) {
            $n = $el.Current.Name
            if (-not $n) { continue }
            $nNorm = (Remove-Diacritics $n).ToLower()
            if ($nNorm.Contains($needle)) {
                $r = $el.Current.BoundingRectangle
                if ($r.Top -ge $yMin -and $r.Top -le $yMax) { return $el }
            }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Find-UIA([string]$name, [string]$controlType = $null, [int]$timeoutMs = 10000) {
    $start = Get-Date
    while (((Get-Date) - $start).TotalMilliseconds -lt $timeoutMs) {
        $root = Get-RootAE
        $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
        if ($controlType) {
            $ctMember = [System.Windows.Automation.ControlType]::$controlType
            $ctCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMember)
            $cond = New-Object System.Windows.Automation.AndCondition($nameCond, $ctCond)
        } else {
            $cond = $nameCond
        }
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($el) { return $el }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Click-UIA($el, [string]$label) {
    if (-not $el) { throw "elemento nulo: $label" }
    $r = $el.Current.BoundingRectangle
    $cx = [int](($r.Left + $r.Right) / 2)
    $cy = [int](($r.Top + $r.Bottom) / 2)
    Write-Host "  [click] '$label' via Win32 mouse em ($cx, $cy)"
    Invoke-HumanClick $cx $cy
}

# Achar 1o item da lista que esta como Rascunho.
# v1.3.21: descoberto via probe que o YT Studio renderiza um botao
# "Editar rascunho" (Name exato) em cada linha de rascunho - 10px abaixo do
# badge. Esse botao tem InvokePattern OK. Bem mais simples que a heuristica
# Hyperlink anterior (que nao existia no UIA).
function Find-FirstDraftLink {
    $root = Get-RootAE
    $buttonCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $btns = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCond)
    $best = $null
    $bestY = 999999
    foreach ($b in $btns) {
        try {
            if ($b.Current.IsOffscreen) { continue }
            if ($b.Current.Name -ne 'Editar rascunho') { continue }
            $r = $b.Current.BoundingRectangle
            if ($r.Top -lt 200) { continue }   # filtra header
            if ($r.Top -lt $bestY) { $bestY = $r.Top; $best = $b }
        } catch {}
    }
    if ($best) { Write-Host "  'Editar rascunho' achado em Y=$bestY" }
    return $best
}

# === STEP 1: abre Chrome no canal ===
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { throw "Chrome nao instalado" }

$videosUrl = "https://studio.youtube.com/channel/$ChannelId/videos/upload"
Write-Host "[1] Abrindo Chrome em: $videosUrl"
Start-Process -FilePath $chrome -ArgumentList "--new-window", "--start-maximized", $videosUrl
Write-Host "  aguardando 20s..."
Start-Sleep -Seconds 20

# === STEP 2: acha janela ===
Write-Host "[2] Achando janela Studio..."
$win = Find-Window 'YouTube Studio'
if (-not $win) { Write-Host "ERRO: janela Studio nao encontrada"; Remove-Item $lockFile -ErrorAction SilentlyContinue; Write-Host "DRAFTS_PUBLISHED:0"; exit 1 }
$script:hwnd = $win.hwnd
Write-Host "  HWND=$($script:hwnd)  $($win.title)"

# v1.3.24: forca maximize agressivo. Chrome ignora --start-maximized se
# outras janelas Chrome ja estao abertas - cria nova janela no tamanho
# default (~1024x768). Sem janela cheia, lista de videos pode nao caber
# todos os botoes "Editar rascunho" na viewport.
[W32]::ShowWindow($script:hwnd, [W32]::SW_RESTORE) | Out-Null
Start-Sleep -Milliseconds 200
[W32]::ShowWindow($script:hwnd, [W32]::SW_SHOWMAXIMIZED) | Out-Null
Start-Sleep -Milliseconds 600

# Confirma maximize via bounds. Se < tela cheia, manda WM_SYSCOMMAND SC_MAXIMIZE
$r = New-Object W32+RECT
[W32]::GetWindowRect($script:hwnd, [ref]$r) | Out-Null
$winW = $r.Right - $r.Left
$winH = $r.Bottom - $r.Top
$scrW = [W32]::GetSystemMetrics(0)
$scrH = [W32]::GetSystemMetrics(1)
Write-Host "  janela: ${winW}x${winH} em ($($r.Left),$($r.Top))  tela: ${scrW}x${scrH}"
if ($winW -lt ($scrW - 50)) {
    Write-Host "  janela menor que tela - forcando via WM_SYSCOMMAND SC_MAXIMIZE"
    # WM_SYSCOMMAND = 0x0112, SC_MAXIMIZE = 0xF030
    [W32]::PostMessage($script:hwnd, 0x0112, [IntPtr]0xF030, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 1000
}

Set-WindowFocus $script:hwnd
Start-Sleep -Milliseconds 800

# espera Studio renderizar
$ready = Find-UIA-Like "Recolher menu" "Button" 30000
if (-not $ready) { Write-Host "  WARN: Studio nao terminou de carregar" }
Start-Sleep -Seconds 3
Snap "01-after-load"

# v1.3.24: YT redireciona /videos/upload pro Painel se Chrome reaproveita tab/sessao.
# Detecta header "Conteudo do canal" - se nao achou, forca navegacao via omnibox.
$onContent = Find-UIA-Like "Conteudo do canal" $null 1500
if (-not $onContent) {
    Write-Host "  [nav] nao estamos em /videos/upload - forcando via Ctrl+L"
    Set-WindowFocus $script:hwnd
    Start-Sleep -Milliseconds 400
    Set-Clipboard -Value $videosUrl
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^l')   # Ctrl+L = focus omnibox
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('^a')   # select all (pode ter texto)
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^v')   # paste URL
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Seconds 8
    Snap "01b-after-nav-fix"
} else {
    Write-Host "  ja estamos em Conteudo do canal"
}
Start-Sleep -Seconds 2
Snap "01-list-ready"

# === LOOP por rascunho ===
$published = 0
for ($n = 1; $n -le $MaxToPublish; $n++) {
    Write-Host ""
    Write-Host "=== Rascunho #$n ==="

    # Tenta achar primeiro rascunho na lista
    $draftLink = Find-FirstDraftLink
    if (-not $draftLink) {
        Write-Host "  Sem mais rascunhos (ou layout nao reconhecido) - parando"
        Snap "no-more-drafts"
        break
    }

    # Click no botao "Editar rascunho" - abre dialog de edicao
    # v1.3.21: prefere InvokePattern (botao tem suporte). Fallback pra Win32 click.
    $ip = $null
    if ($draftLink.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
        Write-Host "  abrindo rascunho via UIA Invoke"
        $ip.Invoke()
    } else {
        Click-UIA $draftLink "Editar rascunho"
    }
    Start-Sleep -Seconds 5
    Snap "02-after-click-titulo-$n"

    # Espera dialog renderizar - procura "Detalhes" ou aba/tab
    $dialogReady = Find-UIA-Like "Detalhes" "" 10000
    if (-not $dialogReady) {
        Write-Host "  AVISO: dialog nao abriu - skip"
        Snap "fail-no-dialog-$n"
        # ESC pra voltar pra lista
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Seconds 2
        continue
    }

    # v1.3.23: espera verificacao YT acabar ANTES de Avancar.
    # Patterns observados no rodape do dialog:
    #   - "Tempo restante: N minutos" (upload ainda subindo)
    #   - "minutos restantes" / "minuto restante" / "segundos restantes" (countdown verif)
    #   - "As verificacoes estao demorando mais que o esperado" (verif lenta - aguardar igual)
    # Se algum desses textos esta visivel, aguarda ate sumir ou max 10min.
    Write-Host "  Aguardando verificacao YT..."
    $verifDeadline = (Get-Date).AddMinutes(10)
    $verifIter = 0
    while ((Get-Date) -lt $verifDeadline) {
        $verifIter++
        $hint = Find-UIA-Like "minutos restantes" $null 1000
        if (-not $hint) { $hint = Find-UIA-Like "minuto restante" $null 600 }
        if (-not $hint) { $hint = Find-UIA-Like "segundos restantes" $null 600 }
        if (-not $hint) { $hint = Find-UIA-Like "demorando mais que o esperado" $null 600 }
        if (-not $hint) { $hint = Find-UIA-Like "verificacoes em andamento" $null 600 }
        if (-not $hint) { Write-Host "    verificacao concluida apos $verifIter check(s)"; break }
        Write-Host "    [$verifIter] aguarda 15s ('$($hint.Current.Name)')"
        Start-Sleep -Seconds 15
    }
    if ((Get-Date) -ge $verifDeadline) { Write-Host "    AVISO: timeout 10min - segue mesmo assim" }
    Snap "03-after-verif-wait-$n"

    # === Avancar ate Visibilidade ===
    Write-Host "  Avancando ate Visibilidade..."
    $maxAvancar = 6
    for ($i = 1; $i -le $maxAvancar; $i++) {
        Start-Sleep -Milliseconds 1500
        $visRadio = Find-UIA-Like "Privado" "RadioButton" 1500
        if ($visRadio) { Write-Host "  Visibilidade alcancada apos $($i-1) Avancar(es)"; break }
        $avancar = Find-UIA-Like-InBounds "avancar" "Button" 200 9999 3000
        if (-not $avancar) { Write-Host "  Avancar #$i nao achado"; Snap "fail-no-avancar-${n}-${i}"; break }
        $invokePat = $null
        if ($avancar.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePat)) {
            $invokePat.Invoke()
        } else {
            Click-UIA $avancar "Avancar #$i"
        }
        Start-Sleep -Milliseconds 2000
        Snap "04-after-avancar-${n}-${i}"
    }

    # === Marcar visibility ===
    Write-Host "  Marcando '$Visibility'..."
    $visLabel = switch ($Visibility) { 'private' { 'Privado' } 'unlisted' { 'Nao listado' } 'public' { 'Publicos' } default { 'Privado' } }
    $visRadio = $null
    $allRadios = (Get-RootAE).FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)))
    foreach ($rb in $allRadios) {
        $rn = (Remove-Diacritics $rb.Current.Name).ToLower()
        $needle = (Remove-Diacritics $visLabel).ToLower()
        if ($rn -eq $needle -or $rn.StartsWith($needle + ' ') -or $rn.StartsWith($needle + '.')) { $visRadio = $rb; break }
    }
    if ($visRadio) {
        Write-Host "    achei: '$($visRadio.Current.Name)'"
        Set-WindowFocus $script:hwnd
        try { $visRadio.SetFocus() } catch {}
        Start-Sleep -Milliseconds 400
        [System.Windows.Forms.SendKeys]::SendWait(' ')
        Start-Sleep -Milliseconds 1000
        Snap "05-after-vis-$n"
    } else {
        # v1.3.23: snap pra debug ANTES de sair
        Write-Host "    '$visLabel' nao achado - listando RadioButtons disponiveis:"
        Snap "fail-no-radio-$n"
        $allRb = (Get-RootAE).FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)))
        foreach ($rb in $allRb) { try { Write-Host "      '$($rb.Current.Name)'" } catch {} }
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Seconds 3
        $sair = Find-UIA-Like "Sair" "Button" 2000
        if ($sair) { Click-UIA $sair "Sair sem salvar" ; Start-Sleep -Seconds 2 }
        continue
    }

    # === Espera verificacao ===
    Write-Host "  Esperando verificacao YT acabar..."
    $verifDeadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $verifDeadline) {
        $hint = Find-UIA-Like "minutos restantes" $null 1500
        if (-not $hint) { $hint = Find-UIA-Like "minuto restante" $null 800 }
        if (-not $hint) { $hint = Find-UIA-Like "segundos restantes" $null 800 }
        if (-not $hint) { Write-Host "    verificacao OK"; break }
        Write-Host "    aguarda 15s ('$($hint.Current.Name)')"
        Start-Sleep -Seconds 15
    }

    # === Click Publicar ===
    Write-Host "  Clicando Publicar..."
    Start-Sleep -Milliseconds 1500
    $publicado = $false
    # Tenta UIA Button "publicar" no rodape do dialog (Y > 200)
    $publicar = Find-UIA-Like-InBounds "publicar" "Button" 200 9999 4000
    if (-not $publicar) { $publicar = Find-UIA-Like-InBounds "salvar" "Button" 200 9999 2000 }
    if ($publicar) {
        $ip2 = $null
        if ($publicar.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip2)) { $ip2.Invoke() } else { Click-UIA $publicar "Publicar" }
        Start-Sleep -Seconds 4
        $still = Find-UIA-Like "Visibilidade" "" 1500
        if (-not $still) { Write-Host "    PUBLICADO (UIA)!"; $publicado = $true }
    }
    if (-not $publicado) {
        # Fallback coord (igual upload-yt.ps1 step 10)
        $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
        $wins = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
        $chromeWin = $null
        foreach ($w in $wins) { if ($w.Current.Name -match 'Studio|YouTube' -and $w.Current.Name -match 'Chrome') { $chromeWin = $w; break } }
        if ($chromeWin) {
            $cr = $chromeWin.Current.BoundingRectangle
            $px = [int]$cr.Right - 110
            $py = [int]$cr.Bottom - 50
            Write-Host "    fallback coord ($px, $py)"
            [W32]::SetForegroundWindow($chromeWin.Current.NativeWindowHandle) | Out-Null
            Start-Sleep -Milliseconds 400
            [W32]::SetCursorPos($px, $py) | Out-Null
            Start-Sleep -Milliseconds 200
            [W32]::mouse_event(0x0002, 0, 0, 0, 0)
            Start-Sleep -Milliseconds 80
            [W32]::mouse_event(0x0004, 0, 0, 0, 0)
            Start-Sleep -Seconds 5
            $check2 = Find-UIA-Like "Visibilidade" "" 1500
            if (-not $check2) { Write-Host "    PUBLICADO (coord)!"; $publicado = $true }
        }
    }

    # === Handle modal "Publicar mesmo assim" ===
    Start-Sleep -Seconds 2
    $ainda = $null
    foreach ($e in (Get-RootAE).FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        try { if ($e.Current.Name -match 'Ainda estamos verificando' -and -not $e.Current.IsOffscreen) { $ainda = $e; break } } catch {}
    }
    if ($ainda) {
        Write-Host "  Modal 'Ainda estamos verificando' - clicando 'Publicar mesmo assim'"
        $btn = Find-UIA-Like "publicar mesmo assim" "" 3000
        if ($btn) {
            $ip3 = $null
            if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip3)) { $ip3.Invoke() } else { Click-UIA $btn "Publicar mesmo assim" }
        } else {
            $mr = $ainda.Current.BoundingRectangle
            $px = [int]($mr.Right - 150); $py = [int]($mr.Bottom - 30)
            Write-Host "    fallback coord modal ($px, $py)"
            [W32]::SetCursorPos($px, $py) | Out-Null
            Start-Sleep -Milliseconds 200
            [W32]::mouse_event(0x0002, 0, 0, 0, 0); Start-Sleep -Milliseconds 80; [W32]::mouse_event(0x0004, 0, 0, 0, 0)
        }
        Start-Sleep -Seconds 5
        $publicado = $true
    }

    if ($publicado) {
        $published++
        Write-Host "  +++ Rascunho #$n PUBLICADO ($published total) +++"
        Snap "12-published-$n"
    } else {
        Write-Host "  Rascunho #$n NAO publicou - skipa"
        Snap "fail-publish-$n"
        # ESC + Sair sem salvar pra voltar pra lista
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Seconds 2
        $sair = Find-UIA-Like "Sair" "Button" 2000
        if ($sair) { Click-UIA $sair "Sair sem salvar"; Start-Sleep -Seconds 2 }
    }

    # Aguarda lista atualizar
    Start-Sleep -Seconds 5
}

# === Fecha Chrome ===
Write-Host ""
Write-Host "Fechando janela Chrome..."
try {
    [W32]::PostMessage($script:hwnd, 0x0010, 0, 0) | Out-Null  # WM_CLOSE
    Start-Sleep -Seconds 2
} catch {}

# Remove lock
Remove-Item $lockFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "DRAFTS_PUBLISHED:$published"
exit 0
