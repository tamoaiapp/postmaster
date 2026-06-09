# Upload de video no YouTube Studio via Chrome real + UI Automation Windows.
# UIA acha elementos por NAME (acessibilidade) - funciona em qualquer resolucao/zoom.
#
# Uso: powershell -File upload-yt-uia.ps1 -VideoPath "..." -Title "..." [-Description "..."]

param(
    [Parameter(Mandatory=$true)] [string]$VideoPath,
    [Parameter(Mandatory=$true)] [string]$Title,
    [string]$Description = "",
    [string]$Visibility = "private",
    [switch]$KidsContent = $false,
    [string]$ChannelId = "",
    [switch]$DryRun = $false
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
. "$PSScriptRoot\win32.ps1"

$outDir = "$PSScriptRoot\out"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$ts = (Get-Date).ToString("yyyyMMdd-HHmmss")

function Snap([string]$label) {
    $path = "$outDir\uia-$label-$ts.png"
    Save-WindowScreenshot $script:hwnd $path | Out-Null
    Write-Host "  [shot] $label"
}

function Get-RootAE { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$script:hwnd) }

# Acha elemento por substring + filtra por Y range. Mais robusto que exact match.
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

# Remove diacriticos via Normalize NFD (metodo canonico .NET, encoding-safe)
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

# Acha 1o elemento cujo Name CONTEM substring (case insensitive, sem acentos)
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

# Acha 1o elemento descendente por Name. opts: -ControlType "Button|Edit|RadioButton|..."
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

# Click - Win32 mouse SEMPRE (UIA so pra LOCALIZAR o elemento).
# Invoke nao dispara React listeners do YT - mouse real e indistinguivel de humano.
function Click-UIA($el, [string]$label) {
    if (-not $el) { throw "elemento nulo: $label" }
    $r = $el.Current.BoundingRectangle
    $cx = [int](($r.Left + $r.Right) / 2)
    $cy = [int](($r.Top + $r.Bottom) / 2)
    Write-Host "  [click] '$label' via Win32 mouse em ($cx, $cy)"
    Invoke-HumanClick $cx $cy
}

# Lista elementos por tipo pra debug
function List-UIA-Elements([string]$controlType) {
    $root = Get-RootAE
    $ctMember = [System.Windows.Automation.ControlType]::$controlType
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ctMember)
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    Write-Host "  ${controlType} total: $($els.Count)"
    foreach ($el in $els) {
        $n = $el.Current.Name
        if (-not $n) { continue }
        $r = $el.Current.BoundingRectangle
        Write-Host "    '${n}' rect=($([int]$r.Left),$([int]$r.Top))-($([int]$r.Right),$([int]$r.Bottom))"
    }
}

# Set value em elemento UIA editavel (textarea, input)
# v1.1.9: YT Studio usa contenteditable React. ValuePattern.SetValue muda o DOM
# mas NAO dispara input event do React, e o titulo fica como filename default.
# Usa sempre Click + Ctrl+A + Delete + Clipboard paste (Ctrl+V dispara input event ok).
function Set-UIAValue($el, [string]$text) {
    if (-not $el) { throw "elemento nulo" }
    Click-UIA $el "campo"
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("{DELETE}")
    Start-Sleep -Milliseconds 200
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 400
}

# === STEP 1: valida video, abre Chrome ===
Write-Host "[1] Validando video + abrindo Chrome..."
if (-not (Test-Path $VideoPath)) { throw "Video nao existe: $VideoPath" }
$videoFull = (Resolve-Path $VideoPath).Path
Write-Host "  video: $videoFull"

$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
$studioUrl = if ($ChannelId -match '^UC[\w-]+$') { "https://studio.youtube.com/channel/$ChannelId/" } else { "https://studio.youtube.com/" }
Write-Host "  abrindo: $studioUrl"
Start-Process -FilePath $chrome -ArgumentList "--new-window", "--start-maximized", $studioUrl
Write-Host "  aguardando 20s pra carregar (Studio React eh lento)..."
Start-Sleep -Seconds 20

# === STEP 2: achar janela ===
Write-Host "[2] Achando janela Studio..."
$win = Find-Window 'YouTube Studio'
if (-not $win) { throw "Janela Studio nao encontrada" }
$script:hwnd = $win.hwnd
Write-Host "  HWND=$($script:hwnd)  $($win.title)"
[W32]::ShowWindow($script:hwnd, [W32]::SW_SHOWMAXIMIZED) | Out-Null
Start-Sleep -Milliseconds 1500
Set-WindowFocus $script:hwnd
Start-Sleep -Milliseconds 800
Snap "01-ready"

# === STEP 3: aguardar Studio renderizar (espera 'Recolher menu') + click Criar ===
Write-Host "[3] Aguardando Studio renderizar completamente (procura 'Recolher menu')..."
$ready = Find-UIA-Like "Recolher menu" "Button" 30000
if (-not $ready) {
    Write-Host "  WARN: 'Recolher menu' nao apareceu - Studio pode nao ter carregado"
} else {
    Write-Host "  Studio pronto (Recolher menu visivel)"
}
Start-Sleep -Milliseconds 800

Write-Host "  procurando 'Criar' (timeout 15s)..."
$criar = Find-UIA "Criar" "Button" 15000
if (-not $criar) { $criar = Find-UIA-Like "Criar" "Button" 5000 }
if (-not $criar) {
    Write-Host "  Criar nao achado. Listando Buttons:"
    List-UIA-Elements "Button"
    throw "Botao 'Criar' nao achado via UIA"
}

# v1.3.10: dispensa overlays/tour do YT Studio que aparecem em primeira visita
# Bloqueava o menu do Criar - botoes 'Dispensar', 'Mostrar opcoes', 'Confira aqui'
# do tour ficavam sobrepostos e o menu nao abria.
Write-Host "  dispensando tour overlays (Dispensar, Fechar)..."
$rootDis = Get-RootAE
foreach ($el in $rootDis.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
        if ($el.Current.IsOffscreen) { continue }
        $n = $el.Current.Name
        if ($n -match '^(Dispensar|Got it|Entendi|Pular|Skip|Close|Fechar tour)$') {
            $ip = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
                $ip.Invoke()
                Write-Host "    dispensei: '$n'"
                Start-Sleep -Milliseconds 400
            }
        }
    } catch {}
}
Start-Sleep -Milliseconds 800

Click-UIA $criar "Criar"
Start-Sleep -Seconds 2
Snap "02-after-criar"

# === STEP 4: abrir popup Enviar videos com loop robusto (3 estrategias) ===
# YT React eh chato - tenta varias estrategias de click no item do menu Criar.
# Sucesso = popup com "Selecionar arquivos" aparece.
Write-Host "[4] Loop pra abrir 'Enviar videos' (3 estrategias)..."

$strategies = @('uia-invoke', 'win32-click', 'down-enter')  # UIA Invoke primeiro (funciona em React menu items)
$popupBtn = $null
foreach ($strat in $strategies) {
    Write-Host "  tentando estrategia: $strat"

    # v1.3.10: busca "Enviar" em QUALQUER ControlType (MenuItem, Button, ListItem)
    # YT mudou tipo do menu item entre updates - antes "Button" agora pode ser MenuItem.
    $enviar = Find-UIA-Like "Enviar v" "" 2000
    if (-not $enviar) { $enviar = Find-UIA-Like "Enviar" "" 1500 }
    if (-not $enviar) {
        Write-Host "    menu fechado - reabrindo Criar..."
        $criar2 = Find-UIA "Criar" "Button" 5000
        if (-not $criar2) { Write-Host "    Criar nao achado - skip"; continue }
        Click-UIA $criar2 "Criar (re-abrir)"
        Start-Sleep -Milliseconds 1500
        $enviar = Find-UIA-Like "Enviar v" "" 3000
        if (-not $enviar) { $enviar = Find-UIA-Like "Enviar" "" 1500 }
    }
    if (-not $enviar) { Write-Host "    Enviar nao achado - skip"; continue }

    # Set focus na janela Chrome antes da estrategia
    Set-WindowFocus $script:hwnd
    Start-Sleep -Milliseconds 500

    switch ($strat) {
        'win32-click' {
            Click-UIA $enviar "Enviar (Win32)"
        }
        'uia-invoke' {
            $invokePat = $null
            if ($enviar.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePat)) {
                Write-Host "    UIA Invoke disparado"
                $invokePat.Invoke()
            } else {
                Write-Host "    InvokePattern nao disponivel - skip"
                continue
            }
        }
        'down-enter' {
            # Reclica Criar antes pra garantir menu aberto + foco
            $criar3 = Find-UIA "Criar" "Button" 3000
            if ($criar3) { Click-UIA $criar3 "Criar (down-enter pre)"; Start-Sleep -Milliseconds 1500 }
            [System.Windows.Forms.SendKeys]::SendWait("{DOWN}")
            Start-Sleep -Milliseconds 400
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        }
    }

    # Aguarda popup aparecer (procura "Selecionar arquivos" ou "Arrastar")
    Start-Sleep -Seconds 3
    $popupBtn = Find-UIA-Like "Selecionar arquivos" "Button" 4000
    if (-not $popupBtn) { $popupBtn = Find-UIA-Like "Arraste" "" 2000 }
    if ($popupBtn) {
        Write-Host "  POPUP ABRIU na estrategia '$strat'!"
        Snap "03-yt-popup-via-$strat"
        break
    }
    Write-Host "  estrategia '$strat' falhou - popup nao apareceu"
    Snap "03-failed-$strat"
}

if (-not $popupBtn) {
    Write-Host ""
    Write-Host "=== NENHUMA estrategia abriu o popup ==="
    Write-Host "Listando Buttons atuais pra debug:"
    List-UIA-Elements "Button"
    throw "Falha em abrir popup 'Enviar videos' apos 3 estrategias"
}

# === STEP 5a: popup aberto, click 'Selecionar arquivos' (popupBtn ja achado no loop) ===
Write-Host "[5a] Clicando 'Selecionar arquivos' pra abrir OS dialog..."
Click-UIA $popupBtn "Selecionar arquivos"
Start-Sleep -Seconds 3

# === STEP 5b: agora OS file dialog abriu - achar e preencher ===
Write-Host "[5b] OS dialog deve estar aberto - achando campo Nome do arquivo via UIA SCREEN..."
Snap "04-os-dialog"
# Procura Edit no DESKTOP inteiro (root), nao so na janela Chrome
$rootScreen = [System.Windows.Automation.AutomationElement]::RootElement
$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Nome do arquivo:")
$nomeArqEdit = $rootScreen.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.AndCondition($editCond, $nameCond)))
if ($nomeArqEdit) {
    Write-Host "  achei 'Nome do arquivo:' Edit no OS dialog"
    Set-UIAValue $nomeArqEdit $videoFull
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
} else {
    Write-Host "  WARN: campo 'Nome do arquivo' nao achado - tentando SendKeys direto"
    Set-Clipboard -Value $videoFull
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
}
Write-Host "  path enviado: $videoFull"
Start-Sleep -Seconds 8

# === STEP 6: dialog de detalhes ===
Write-Host "[6] Aguardando dialog de detalhes abrir..."
Start-Sleep -Seconds 8
Snap "05-details-dialog"

Write-Host "  procurando campo Titulo via UIA (Find-UIA-Like 'Titulo')..."
$tituloEdit = Find-UIA-Like "Titulo" "Edit" 5000
if ($tituloEdit) {
    Write-Host "  achei Titulo: '$($tituloEdit.Current.Name)'"
    Set-UIAValue $tituloEdit $Title
    Start-Sleep -Milliseconds 600
    Snap "06-after-title"
} else {
    Write-Host "  AVISO: Titulo nao achado. Listando Edits:"
    List-UIA-Elements "Edit"
}

if ($Description) {
    Write-Host "  procurando campo Descricao via 'Conte aos espectadores' ou 'descricao'..."
    $descEdit = Find-UIA-Like "Conte aos espectadores" "Edit" 3000
    if (-not $descEdit) { $descEdit = Find-UIA-Like "descricao do video" "Edit" 2000 }
    if (-not $descEdit) { $descEdit = Find-UIA-Like "descricao" "Edit" 2000 }
    if ($descEdit) {
        Write-Host "  achei Descricao: '$($descEdit.Current.Name)'"
        Set-UIAValue $descEdit $Description
        Start-Sleep -Milliseconds 500
        Snap "07-after-desc"
    } else {
        Write-Host "  AVISO: Descricao nao achada"
    }
}

# === STEP 7: Audiencia kids via UIA SelectionItemPattern (nao depende de viewport) ===
Write-Host "[7] Marcando 'Nao e conteudo para criancas' via UIA SelectionItemPattern..."
$naoKids = Find-UIA-Like "nao e conteudo" "RadioButton" 5000
if ($naoKids) {
    Write-Host "  achei radio: '$($naoKids.Current.Name)'"
    $scrollPat = $null
    if ($naoKids.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollPat)) {
        $scrollPat.ScrollIntoView()
        Start-Sleep -Milliseconds 500
    }
    # v1.3.3: SetFocus + tecla ESPACO. React captura keydown(Space) e toggle o radio.
    # SEM mover mouse - usuario reclamou de mouse pulando na tela.
    Write-Host "  SetFocus + SendKeys ESPACO"
    Set-WindowFocus $script:hwnd
    Start-Sleep -Milliseconds 200
    try { $naoKids.SetFocus() } catch {}
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    Start-Sleep -Milliseconds 1000
    Snap "08-after-kids"
} else {
    Write-Host "  AVISO: radio kids nao achado. RadioButtons:"
    List-UIA-Elements "RadioButton"
}

# === STEP 8: Avancar 3x (filtra por Y > 200 pra evitar Avancar do navegador) ===
Write-Host "[8] Clicando Avancar 3 vezes ate visibilidade (Y>200 - filtra Chrome nav)..."
# v1.1.7: loop dinamico ate Visibilidade (canais monetizados tem 5 abas, nao 4).
# Detecta tela Visibilidade pelo radio "Privado" ou "Salvar ou publicar" presente.
$maxAvancar = 6  # safety: canais com monetizacao+verificacoes podem ter ate ~5 telas
for ($i = 1; $i -le $maxAvancar; $i++) {
    Start-Sleep -Milliseconds 2000
    # Checa se ja chegou em Visibilidade (radio "Privado" visivel)
    $visRadio = Find-UIA-Like "Privado" "RadioButton" 1500
    if ($visRadio) {
        Write-Host "  Visibilidade alcancada apos $($i-1) Avancar(es)"
        break
    }
    $avancar = Find-UIA-Like-InBounds "avancar" "Button" 200 9999 5000
    if (-not $avancar) {
        Write-Host "  Avancar #$i nao achado - parando"
        break
    }
    $r = $avancar.Current.BoundingRectangle
    # Checa se Avancar esta enabled
    $isEnabled = $true
    try { $isEnabled = $avancar.Current.IsEnabled } catch {}
    if (-not $isEnabled) {
        Write-Host "  Avancar #$i DISABLED (pode ser tela Monetizacao pendente) - tentando pular..."
        # Procura botoes alternativos: "Pular", "Mais tarde", "Sem monetizacao"
        $skip = Find-UIA-Like "Pular" "Button" 1500
        if (-not $skip) { $skip = Find-UIA-Like "Mais tarde" "Button" 1500 }
        if (-not $skip) { $skip = Find-UIA-Like "Sem monetizacao" "RadioButton" 1500 }
        if ($skip) {
            Write-Host "  achei alternativa: '$($skip.Current.Name)' - clicando"
            $sInv = $null
            if ($skip.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$sInv)) { $sInv.Invoke() } else { Click-UIA $skip "skip" }
            Start-Sleep -Milliseconds 2000
            continue
        } else {
            Write-Host "  sem alternativa - parando (canal exige config manual)"
            Snap "09-disabled-avancar-$i"
            break
        }
    }
    Write-Host "  Avancar #$i em rect=($([int]$r.Left),$([int]$r.Top))-($([int]$r.Right),$([int]$r.Bottom))"
    $invokePat = $null
    if ($avancar.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePat)) {
        Write-Host "  Avancar #$i via UIA Invoke"
        $invokePat.Invoke()
    } else {
        Click-UIA $avancar "Avancar #$i (Win32)"
    }
    Start-Sleep -Milliseconds 2500
    Snap "09-after-avancar-$i"
}

# === STEP 9: Visibilidade Privado via SelectionItemPattern ===
Write-Host "[9] Selecionando visibilidade '$Visibility' via SelectionItemPattern..."
$visLabel = switch ($Visibility) { 'private' { 'Privado' } 'unlisted' { 'Nao listado' } 'public' { 'Publico' } default { 'Privado' } }
# Procura RadioButton exato - NAO 'Salvo como privado' (que eh status)
$visRadio = $null
$allRadios = (Get-RootAE).FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)))
foreach ($r in $allRadios) {
    $n = (Remove-Diacritics $r.Current.Name).ToLower()
    $needle = (Remove-Diacritics $visLabel).ToLower()
    if ($n -eq $needle -or $n.StartsWith($needle + ' ') -or $n.StartsWith($needle + '.')) {
        $visRadio = $r
        break
    }
}
if ($visRadio) {
    Write-Host "  achei: '$($visRadio.Current.Name)'"
    $scrollPat = $null
    if ($visRadio.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollPat)) {
        $scrollPat.ScrollIntoView()
        Start-Sleep -Milliseconds 400
    }
    # v1.3.3: SetFocus + tecla ESPACO. React captura keydown(Space) e toggle.
    Write-Host "  SetFocus + SendKeys ESPACO"
    Set-WindowFocus $script:hwnd
    Start-Sleep -Milliseconds 200
    try { $visRadio.SetFocus() } catch {}
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    Start-Sleep -Milliseconds 1000
    Snap "10-after-vis"
} else {
    Write-Host "  '$visLabel' RadioButton exato nao achado. RadioButtons:"
    List-UIA-Elements "RadioButton"
}

# === STEP 10: Publicar (ou skip se -DryRun) ===
if ($DryRun) {
    Write-Host "[10] DRY RUN - NAO clicando Publicar. Video fica como RASCUNHO pra inspecao."
    Write-Host "  Modo dry-run: deixa video upload + detalhes preenchidos, mas nao confirma publish."
    Snap "11-dryrun-rascunho"
    Write-Host "  RASCUNHO_SALVO"
    return
}
Write-Host "[10] Clicando Publicar..."
Start-Sleep -Milliseconds 1500

# v1.3.0: YouTube React NAO expoe Publicar como UIA Button (shadow DOM / role mal-configurado).
# Tentativas UIA caem em texto "publicar" do header ou dos termos, nao no botao real.
# Solucao: calcula coord do botao geometricamente (bottom-right da janela do Chrome com Studio).
# Validado em (winRight-110, winBottom-50) com dialog YT upload. Single click fechou o dialog.
$publicado = $false

# 1) Tentativa UIA primeiro (versao antiga, pode funcionar em alguns layouts)
$publicar = Find-UIA-Like-InBounds "publicar" "Button" 200 9999 4000
if (-not $publicar) { $publicar = Find-UIA-Like-InBounds "salvar" "Button" 200 9999 2000 }
if ($publicar) {
    Write-Host "  via UIA: '$($publicar.Current.Name)'"
    $invokePat = $null
    if ($publicar.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePat)) {
        $invokePat.Invoke()
    } else {
        Click-UIA $publicar "Publicar"
    }
    Start-Sleep -Seconds 4
    Snap "11-after-publish"
    $stillOpen = Find-UIA-Like "Visibilidade" "" 1500
    if (-not $stillOpen) {
        Write-Host "  PUBLICADO (UIA)!"
        $publicado = $true
    }
}

# 2) Fallback: calcula coord geometrica e clica via mouse_event
if (-not $publicado) {
    Write-Host "  UIA falhou ou dialog ainda aberto - usando coord geometrica..."
    # Acha janela do Chrome com Studio
    $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
    $winCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $wins = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
    $chromeWin = $null
    foreach ($w in $wins) {
        $n = $w.Current.Name
        if ($n -match 'Google Chrome' -and ($n -match 'Studio' -or $n -match 'YouTube')) { $chromeWin = $w; break }
    }
    if ($chromeWin) {
        $r = $chromeWin.Current.BoundingRectangle
        # Botao Publicar no canto inferior direito do dialog (que ocupa quase a janela toda)
        $px = [int]$r.Right - 110
        $py = [int]$r.Bottom - 50
        Write-Host "  janela rect=($([int]$r.Left),$([int]$r.Top))-($([int]$r.Right),$([int]$r.Bottom))"
        Write-Host "  clicando em ($px, $py)"
        # Foco
        [W32]::SetForegroundWindow($chromeWin.Current.NativeWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 500
        [W32]::SetCursorPos($px, $py) | Out-Null
        Start-Sleep -Milliseconds 200
        [W32]::mouse_event(0x0002, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 80
        [W32]::mouse_event(0x0004, 0, 0, 0, 0)
        Start-Sleep -Seconds 5
        Snap "11-after-publish-coord"

        # Verifica fechamento
        $check = Find-UIA-Like "Visibilidade" "" 2000
        if (-not $check) {
            Write-Host "  PUBLICADO (coord geometrica)!"
            $publicado = $true
        } else {
            Write-Host "  Dialog ainda aberto. Retry com offset alternativo (right-90, bottom-40)..."
            [W32]::SetCursorPos(([int]$r.Right - 90), ([int]$r.Bottom - 40)) | Out-Null
            Start-Sleep -Milliseconds 200
            [W32]::mouse_event(0x0002, 0, 0, 0, 0)
            Start-Sleep -Milliseconds 80
            [W32]::mouse_event(0x0004, 0, 0, 0, 0)
            Start-Sleep -Seconds 5
            $check2 = Find-UIA-Like "Visibilidade" "" 2000
            if (-not $check2) { Write-Host "  PUBLICADO (retry)!"; $publicado = $true }
        }
    } else {
        Write-Host "  ERRO: janela do Chrome com Studio nao encontrada"
    }
}

if (-not $publicado) {
    Write-Host "  AVISO: NAO consegui publicar via UIA NEM coord. Buttons:"
    List-UIA-Elements "Button"
}

# === STEP 11: Confirma "Publicar mesmo assim" se YT abrir modal de verificacao incompleta ===
# v1.3.1: quando verificacao initial ainda ta rodando, YT abre 2o modal:
# "Ainda estamos verificando seu conteudo - Publicar mesmo assim / Voltar"
# Se nao clicar nesse, video fica em rascunho mesmo tendo clicado o Publicar do dialog principal.
Start-Sleep -Seconds 2
Write-Host "[11] Procurando modal 'Ainda estamos verificando'..."
$rootAE = Get-RootAE
$ainda = $null
foreach ($e in $rootAE.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
        $n = $e.Current.Name
        if ($n -and $n -match 'Ainda estamos verificando' -and -not $e.Current.IsOffscreen) {
            $ainda = $e; break
        }
    } catch {}
}
if ($ainda) {
    Write-Host "  Modal de confirmacao detectado - procurando botao 'Publicar mesmo assim' via UIA"
    # v1.3.10: busca com retry + match flexivel + fallback no desktop root.
    # Antes: busca unica no window (Get-RootAE) com nome exato - falhava se modal
    # renderiza em shadow DOM ou se nome tem espaco extra.
    $btnConfirm = $null
    $desktopRoot = [System.Windows.Automation.AutomationElement]::RootElement
    $confirmDeadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $confirmDeadline -and -not $btnConfirm) {
        # 1) Procura no window do hwnd (mais rapido)
        foreach ($e in $rootAE.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            try {
                if ($e.Current.IsOffscreen) { continue }
                $n = $e.Current.Name
                if ($n -and ($n -match '(?i)publicar mesmo assim|publish anyway|publish anyway')) {
                    $btnConfirm = $e; break
                }
            } catch {}
        }
        if ($btnConfirm) { break }
        # 2) Fallback: busca no desktop root inteiro (modal pode estar em janela popup separada)
        foreach ($e in $desktopRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            try {
                if ($e.Current.IsOffscreen) { continue }
                $n = $e.Current.Name
                if ($n -and ($n -match '(?i)publicar mesmo assim|publish anyway')) {
                    $btnConfirm = $e; break
                }
            } catch {}
        }
        if (-not $btnConfirm) { Start-Sleep -Milliseconds 800 }
    }
    if ($btnConfirm) {
        $r = $btnConfirm.Current.BoundingRectangle
        # Primeiro tenta UIA Invoke (mais limpo, sem mover mouse)
        $ip = $null
        if ($btnConfirm.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) {
            Write-Host "  via UIA Invoke"
            $ip.Invoke()
        } else {
            # Fallback: SetFocus + Enter
            Write-Host "  via SetFocus + Enter"
            try { $btnConfirm.SetFocus() } catch {}
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        }
        Start-Sleep -Seconds 5
        Snap "12-after-confirm"
        Write-Host "  Modal de confirmacao processado"
    } else {
        Write-Host "  AVISO: 'Publicar mesmo assim' nao achado via UIA"
    }
} else {
    Write-Host "  Nenhum modal de confirmacao (verificacao ja completa OU video sem aviso)"
}

Write-Host ""
Write-Host "=== STEP 6 OK - verificar screenshots e prosseguir step 7+ depois ==="
Write-Host "Screenshots em: $outDir"
