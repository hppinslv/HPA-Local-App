[CmdletBinding()]
param(
  [string]$WorkbookPath = "n:\Documents\Tracking Spreadsheets\Month End Reports\AHA HPA Transaction Summary.xlsm",
  [string]$ModulePath = ".\excel\AhaHpaMonthlyReport.bas"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ResolvedPathString {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return (Resolve-Path -LiteralPath $PathValue).Path
}

if (-not (Test-Path -LiteralPath $WorkbookPath)) {
  throw "Workbook not found: $WorkbookPath"
}

if (-not (Test-Path -LiteralPath $ModulePath)) {
  throw "Module file not found: $ModulePath"
}

$resolvedWorkbookPath = Get-ResolvedPathString -PathValue $WorkbookPath
$resolvedModulePath = Get-ResolvedPathString -PathValue $ModulePath
$workbookDirectory = Split-Path -Path $resolvedWorkbookPath -Parent
$backupPath = Join-Path $workbookDirectory ("AHA HPA Transaction Summary.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".xlsm")

$excel = $null
$workbook = $null
$finalReportSheet = $null
$button = $null
$component = $null
$previousAccessVbom = $null
$accessVbomWasPresent = $false
$securityKeyPath = "HKCU:\Software\Microsoft\Office\16.0\Excel\Security"

try {
  $currentSetting = Get-ItemProperty -Path $securityKeyPath -Name AccessVBOM -ErrorAction SilentlyContinue
  if ($null -ne $currentSetting) {
    $accessVbomWasPresent = $true
    $previousAccessVbom = $currentSetting.AccessVBOM
  }

  New-ItemProperty -Path $securityKeyPath -Name AccessVBOM -PropertyType DWord -Value 1 -Force | Out-Null

  $excel = New-Object -ComObject Excel.Application
  $excel.AutomationSecurity = 3
  $excel.AskToUpdateLinks = $false
  $excel.DisplayAlerts = $false
  $excel.Visible = $false

  $workbook = $excel.Workbooks.Open($resolvedWorkbookPath, 0, $false)
  $workbook.SaveCopyAs($backupPath)

  foreach ($existingComponent in $workbook.VBProject.VBComponents) {
    if ($existingComponent.Name -eq "AhaHpaMonthlyReport") {
      $workbook.VBProject.VBComponents.Remove($existingComponent)
      break
    }
  }

  $component = $workbook.VBProject.VBComponents.Import($resolvedModulePath)

  $finalReportSheet = $workbook.Worksheets.Item("Final Report")

  foreach ($shape in $finalReportSheet.Shapes) {
    if ($shape.Name -eq "RunMonthlyReportButton") {
      $shape.Delete()
      break
    }
  }

  $button = $finalReportSheet.Shapes.AddShape(1, 520, 18, 180, 32)
  $button.Name = "RunMonthlyReportButton"
  $button.TextFrame.Characters().Text = "Run Monthly Report"
  $button.OnAction = "'" + $workbook.Name + "'!RunMonthlyReport"
  $button.Fill.ForeColor.RGB = 4143421
  $button.Line.ForeColor.RGB = 3155730
  $button.TextFrame.Characters().Font.Color = 16777215
  $button.TextFrame.Characters().Font.Bold = $true

  $workbook.Save()
  Write-Output "Workbook macro installed successfully."
  Write-Output "Backup created at: $backupPath"
} finally {
  if ($button) {
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($button) | Out-Null
  }

  if ($finalReportSheet) {
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($finalReportSheet) | Out-Null
  }

  if ($component) {
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($component) | Out-Null
  }

  if ($workbook) {
    $workbook.Close($true)
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($workbook) | Out-Null
  }

  if ($excel) {
    $excel.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  }

  if ($accessVbomWasPresent) {
    Set-ItemProperty -Path $securityKeyPath -Name AccessVBOM -Value $previousAccessVbom
  } else {
    Remove-ItemProperty -Path $securityKeyPath -Name AccessVBOM -ErrorAction SilentlyContinue
  }

  [gc]::Collect()
  [gc]::WaitForPendingFinalizers()
}
