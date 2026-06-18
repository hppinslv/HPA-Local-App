[CmdletBinding()]
param(
  [string]$WorkbookPath = "n:\Documents\Tracking Spreadsheets\Month End Reports\AHA HPA Transaction Summary.xlsm",
  [string]$OutputDirectory,
  [switch]$ExportPdf,
  [switch]$SkipRefresh
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$xlCalculationDone = 0
$xlTypePdf = 0
$xlConnectorProgId = "TaralexLLC.SalesforceEnabler"

$requiredSheets = @(
  "Totals - Billing - Credits ..."
  "Billing Credits"
  "Billing & Direct Debit - Re..."
  "B & DD Refund"
  "Billing - Bounced Checks"
  "B BC"
  "Direct Debit (UMB Bank) - Credi"
  "DD C"
  "Direct Debit (UMB Bank) Returne"
  "DD Returned Items"
  "Credit Cards (UMB) - Credits"
  "CC C"
  "Credit Cards (UMB) - Refunds"
  "CC R"
  "Direct Debit (M&T Bank) - R..."
  "DD RR"
  "Final Report"
)

function Write-Status {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$timestamp] $Message"
}

function Invoke-SalesforceRefresh {
  param(
    [Parameter(Mandatory = $true)]$Excel,
    [Parameter(Mandatory = $true)]$Workbook
  )

  try {
    $connectorAddIn = $Excel.COMAddIns.Item($xlConnectorProgId)

    if ($null -ne $connectorAddIn) {
      if (-not $connectorAddIn.Connect) {
        $connectorAddIn.Connect = $true
      }

      $connectorObject = $connectorAddIn.Object

      if ($null -ne $connectorObject) {
        $connectorObject.Refresh()
        return "XL Connector"
      }
    }
  } catch {
  }

  $Workbook.RefreshAll()
  return "Workbook RefreshAll"
}

function Get-PreviousMonthLabel {
  $reportDate = (Get-Date).AddMonths(-1)
  return $reportDate.ToString("MMMM yyyy")
}

function Wait-ForWorkbookIdle {
  param(
    [Parameter(Mandatory = $true)]$Excel,
    [Parameter(Mandatory = $true)]$Workbook,
    [int]$TimeoutSeconds = 900
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    try {
      $Excel.CalculateUntilAsyncQueriesDone()
    } catch {
    }

    $isRefreshing = $false

    foreach ($worksheet in $Workbook.Worksheets) {
      foreach ($queryTable in $worksheet.QueryTables) {
        if ($queryTable.Refreshing) {
          $isRefreshing = $true
          break
        }
      }

      if ($isRefreshing) {
        break
      }
    }

    if (-not $isRefreshing -and $Excel.CalculationState -eq $xlCalculationDone) {
      return
    }

    Start-Sleep -Seconds 1
  }

  throw "Timed out waiting for workbook refresh/calculation to finish."
}

function Assert-RequiredSheets {
  param([Parameter(Mandatory = $true)]$Workbook)

  $sheetNames = @{}

  foreach ($worksheet in $Workbook.Worksheets) {
    $sheetNames[$worksheet.Name] = $true
  }

  $missingSheets = @()

  foreach ($requiredSheet in $requiredSheets) {
    if (-not $sheetNames.ContainsKey($requiredSheet)) {
      $missingSheets += $requiredSheet
    }
  }

  if ($missingSheets.Count -gt 0) {
    throw "Missing required sheets: $($missingSheets -join ', ')"
  }
}

function Assert-FinalReportHasNoFormulaErrors {
  param([Parameter(Mandatory = $true)]$Worksheet)

  $usedRange = $Worksheet.UsedRange
  $errorCells = New-Object System.Collections.Generic.List[string]

  for ($row = 1; $row -le $usedRange.Rows.Count; $row++) {
    for ($column = 1; $column -le $usedRange.Columns.Count; $column++) {
      $cell = $usedRange.Cells.Item($row, $column)

      if ($cell.HasFormula -and $cell.Text -like "#*") {
        $errorCells.Add("$($cell.Address($false, $false))=$($cell.Text)")
      }
    }
  }

  if ($errorCells.Count -gt 0) {
    $sample = $errorCells | Select-Object -First 10
    throw "Final Report contains formula errors: $($sample -join ', ')"
  }
}

if (-not (Test-Path -LiteralPath $WorkbookPath)) {
  throw "Workbook not found: $WorkbookPath"
}

$resolvedWorkbookPath = (Resolve-Path -LiteralPath $WorkbookPath).Path
$targetDirectory = if ($OutputDirectory) { $OutputDirectory } else { Split-Path -Path $resolvedWorkbookPath -Parent }

if (-not (Test-Path -LiteralPath $targetDirectory)) {
  throw "Output directory not found: $targetDirectory"
}

$resolvedTargetDirectory = (Resolve-Path -LiteralPath $targetDirectory).Path

$reportMonthLabel = Get-PreviousMonthLabel
$outputWorkbookPath = Join-Path $resolvedTargetDirectory "AHA HPA Transaction Summary - $reportMonthLabel.xlsm"
$outputPdfPath = Join-Path $resolvedTargetDirectory "AHA HPA Transaction Summary - $reportMonthLabel.pdf"

if (Test-Path -LiteralPath $outputWorkbookPath) {
  throw "Output workbook already exists: $outputWorkbookPath"
}

if ($ExportPdf -and (Test-Path -LiteralPath $outputPdfPath)) {
  throw "Output PDF already exists: $outputPdfPath"
}

$excel = $null
$workbook = $null
$finalReportSheet = $null

try {
  Write-Status "Opening workbook."
  $excel = New-Object -ComObject Excel.Application
  $excel.AutomationSecurity = 3
  $excel.AskToUpdateLinks = $false
  $excel.DisplayAlerts = $false
  $excel.Visible = $false

  $workbook = $excel.Workbooks.Open($resolvedWorkbookPath, 0, $false)

  if (-not $SkipRefresh) {
    $refreshMode = Invoke-SalesforceRefresh -Excel $excel -Workbook $workbook
    Write-Status "Refreshing Salesforce data using $refreshMode."
    Wait-ForWorkbookIdle -Excel $excel -Workbook $workbook
  } else {
    Write-Status "Skipping refresh by request."
  }

  Write-Status "Running full workbook recalculation."
  $excel.CalculateFullRebuild()
  Wait-ForWorkbookIdle -Excel $excel -Workbook $workbook

  Write-Status "Validating required sheets."
  Assert-RequiredSheets -Workbook $workbook

  Write-Status "Checking Final Report for formula errors."
  $finalReportSheet = $workbook.Worksheets.Item("Final Report")
  Assert-FinalReportHasNoFormulaErrors -Worksheet $finalReportSheet

  Write-Status "Saving dated workbook copy: $outputWorkbookPath"
  $workbook.SaveCopyAs($outputWorkbookPath)

  if ($ExportPdf) {
    Write-Status "Exporting Final Report PDF: $outputPdfPath"
    $finalReportSheet.ExportAsFixedFormat($xlTypePdf, $outputPdfPath)
  }

  Write-Status "Monthly report automation completed successfully."
} catch {
  Write-Status "Monthly report automation failed."
  throw
} finally {
  if ($workbook) {
    $workbook.Close($false)
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($workbook) | Out-Null
  }

  if ($finalReportSheet) {
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($finalReportSheet) | Out-Null
  }

  if ($excel) {
    $excel.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  }

  [gc]::Collect()
  [gc]::WaitForPendingFinalizers()
}
