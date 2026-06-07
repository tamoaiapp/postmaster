# Teste UI Automation Windows - mais robusto que OCR + coord.
# Acha elementos UI por NAME (acessibilidade) — funciona em qualquer Chrome window
# mesmo com viewport apertado.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

. "$PSScriptRoot\win32.ps1"

Write-Host "[1] Achando janela Chrome com Studio..."
$winInfo = Find-Window 'YouTube Studio'
if (-not $winInfo) {
    Write-Host "  janela nao encontrada. Procurando 'YouTube' geral..."
    $winInfo = Find-Window 'YouTube'
}
if (-not $winInfo) { throw "Nenhuma janela YouTube/Studio encontrada. Abre Chrome primeiro." }
Write-Host "  HWND=$($winInfo.hwnd)  $($winInfo.title)"

Write-Host "[2] Pegando AutomationElement da janela..."
$ae = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$winInfo.hwnd)
Write-Host "  raiz: $($ae.Current.Name) [$($ae.Current.ControlType.LocalizedControlType)]"

Write-Host "[3] Procurando todos os Buttons descendentes..."
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$buttons = $ae.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
Write-Host "  total botoes: $($buttons.Count)"

Write-Host "[4] Listando botoes (top 50):"
$i = 0
foreach ($btn in $buttons) {
    $i++
    if ($i -gt 50) { break }
    $name = $btn.Current.Name
    if (-not $name) { continue }
    $rect = $btn.Current.BoundingRectangle
    Write-Host "  Button '$name'  rect=($([int]$rect.Left),$([int]$rect.Top))-($([int]$rect.Right),$([int]$rect.Bottom))"
}

Write-Host ""
Write-Host "[5] Procurando especificamente Name='Criar'..."
$criarCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Criar")
$criar = $ae.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $criarCondition)
if ($criar) {
    $r = $criar.Current.BoundingRectangle
    Write-Host "  ACHEI! Criar em ($([int]$r.Left),$([int]$r.Top))-($([int]$r.Right),$([int]$r.Bottom))"
    Write-Host "  Tipo: $($criar.Current.ControlType.LocalizedControlType)"

    $cx = [int](($r.Left + $r.Right) / 2)
    $cy = [int](($r.Top + $r.Bottom) / 2)
    Write-Host "  Vai clicar em ($cx, $cy) via Win32..."
    Invoke-HumanClick $cx $cy
    Write-Host "  click disparado"
} else {
    Write-Host "  Criar NAO ACHADO via UIA Name property"
    Write-Host ""
    Write-Host "[6] Procurando por NameProperty que contem 'criar' (case insensitive)..."
    foreach ($btn in $buttons) {
        $name = $btn.Current.Name
        if ($name -match 'criar|enviar|upload') {
            $rect = $btn.Current.BoundingRectangle
            Write-Host "  MATCH: '$name' rect=($([int]$rect.Left),$([int]$rect.Top))-($([int]$rect.Right),$([int]$rect.Bottom))"
        }
    }
}
