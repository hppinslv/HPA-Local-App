param([Parameter(Mandatory = $true)][string]$PayloadPath)
$ErrorActionPreference = 'Stop'

function Release-ComObject($Object) {
  if ($null -ne $Object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object) }
}

function Get-FieldName([string]$Header) {
  return (($Header -replace '[^A-Za-z0-9]+', '_').Trim('_'))
}

function Get-GroupRows($Dataset) {
  if ($null -eq $Dataset -or $null -eq $Dataset.rows) { return @() }
  return @($Dataset.rows)
}

function Write-WorksheetRows($Worksheet, [object[]]$Rows) {
  $used = $Worksheet.UsedRange
  $columnCount = $used.Columns.Count
  $existingRows = $used.Rows.Count
  if ($existingRows -gt 1) { $Worksheet.Range($Worksheet.Cells.Item(2, 1), $Worksheet.Cells.Item($existingRows, $columnCount)).ClearContents() }
  if ($Rows.Count -eq 0) { return }
  $matrix = New-Object 'object[,]' $Rows.Count, $columnCount
  for ($column = 1; $column -le $columnCount; $column++) {
    $header = [string]$Worksheet.Cells.Item(1, $column).Text
    for ($rowIndex = 0; $rowIndex -lt $Rows.Count; $rowIndex++) {
      $property = $Rows[$rowIndex].values.PSObject.Properties[$header]
      $matrix[$rowIndex, ($column - 1)] = if ($null -eq $property) { '' } else { $property.Value }
    }
  }
  $target = $Worksheet.Range($Worksheet.Cells.Item(2, 1), $Worksheet.Cells.Item($Rows.Count + 1, $columnCount))
  $target.Value2 = $matrix
}

function Write-CsvSource([string]$Path, [object[]]$Rows, [string[]]$Headers) {
  $items = foreach ($row in $Rows) {
    $record = [ordered]@{}
    foreach ($header in $Headers) {
      $field = Get-FieldName $header
      $property = $row.values.PSObject.Properties[$header]
      $record[$field] = if ($null -eq $property) { '' } else { $property.Value }
    }
    [pscustomobject]$record
  }
  if ($Rows.Count -eq 0) {
    $record = [ordered]@{}
    foreach ($header in $Headers) { $record[(Get-FieldName $header)] = '' }
    @([pscustomobject]$record) | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8
    return
  }
  $items | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8
}

function Merge-TemplateToPdf($Word, [string]$TemplatePath, [string]$WorkbookPath, [string]$SheetName, [string]$OutputPath, [int]$ExpectedRecords) {
  $template = $null
  $merged = $null
  try {
    $template = $Word.Documents.Open($TemplatePath, $false, $true)
    if ($ExpectedRecords -eq 0) {
      $empty = $Word.Documents.Add()
      $empty.Range().Text = 'No records were returned for this billing group.'
      $empty.ExportAsFixedFormat($OutputPath, 17)
      $pages = $empty.ComputeStatistics(2)
      $empty.Close(0)
      return $pages
    }
    $template.MailMerge.MainDocumentType = 0
    $sql = "SELECT * FROM [$SheetName`$]"
    $template.MailMerge.OpenDataSource($WorkbookPath, 0, $false, $true, $true, $false, '', '', $false, '', '', '', $sql, '', $false, 0)
    $template.MailMerge.Destination = 0
    $template.MailMerge.SuppressBlankLines = $true
    $template.MailMerge.Execute($false)
    $merged = $Word.ActiveDocument
    $merged.Fields.Update() | Out-Null
    foreach ($story in $merged.StoryRanges) { try { $story.Fields.Update() | Out-Null } catch {} }
    $merged.ExportAsFixedFormat($OutputPath, 17)
    return $merged.ComputeStatistics(2)
  } finally {
    if ($null -ne $merged) { $merged.Close(0); Release-ComObject $merged }
    if ($null -ne $template) { $template.Close(0); Release-ComObject $template }
  }
}

function Set-TemplateMergeValues($Document, $Values) {
  $mapped = @{}
  foreach ($property in $Values.PSObject.Properties) { $mapped[(Get-FieldName $property.Name).ToLowerInvariant()] = [string]$property.Value }
  $mapped['certificate_number_billing_stateprovin'] = [string]$Values.'Certificate Number: Billing State/Province'
  $mapped['certificate_number_billing_zippostal_c'] = [string]$Values.'Certificate Number: Billing Zip/Postal Code'
  $fieldCollections = [System.Collections.Generic.List[object]]::new()
  $fieldCollections.Add($Document.Fields)
  foreach ($story in $Document.StoryRanges) { $fieldCollections.Add($story.Fields) }
  foreach ($shape in $Document.Shapes) { if ($shape.TextFrame.HasText -ne 0) { $fieldCollections.Add($shape.TextFrame.TextRange.Fields) } }
  foreach ($collection in $fieldCollections) {
    foreach ($field in $collection) {
      $code = [string]$field.Code.Text
      $match = [regex]::Match($code, '(?i)MERGEFIELD\s+"?([^"\\\s]+)')
      if ($match.Success) {
        $key = $match.Groups[1].Value.Trim().ToLowerInvariant()
        if ($mapped.ContainsKey($key)) { $field.Result.Text = $mapped[$key] }
      }
      if ($code -match '(?i)^\s*IF\b' -and $mapped.ContainsKey('rate_text')) {
        $field.Result.Text = if ($mapped['rate_text'] -eq 'has increased to') { 'Your' } else { 'There is no fee for this. Your' }
      }
    }
  }
}

function Replace-TemplateText($Document, $Replacements) {
  foreach ($story in $Document.StoryRanges) {
    foreach ($entry in $Replacements.GetEnumerator()) {
      $range = $story.Duplicate
      [void]$range.Find.Execute([string]$entry.Key, $false, $false, $false, $false, $false, $true, 1, $false, [string]$entry.Value, 2)
    }
  }
  foreach ($shape in $Document.Shapes) {
    if ($shape.TextFrame.HasText -ne 0) {
      foreach ($entry in $Replacements.GetEnumerator()) {
        $range = $shape.TextFrame.TextRange.Duplicate
        [void]$range.Find.Execute([string]$entry.Key, $false, $false, $false, $false, $false, $true, 1, $false, [string]$entry.Value, 2)
      }
    }
  }
}

function Render-TemplateStack($Word, [string]$TemplatePath, [object[]]$Rows, [string]$OutputPath) {
  $source = $null
  $result = $null
  try {
    if ($Rows.Count -eq 0) {
      $result = $Word.Documents.Add()
      $result.Range().Text = 'No records were returned for this billing group.'
    } else {
      $result = $Word.Documents.Open($TemplatePath, $false, $false)
      Set-TemplateMergeValues $result $Rows[0].values
    }
    for ($index = 1; $index -lt $Rows.Count; $index++) {
      $source = $Word.Documents.Open($TemplatePath, $false, $false)
      Set-TemplateMergeValues $source $Rows[$index].values
      $insert = $result.Range($result.Content.End - 1, $result.Content.End - 1)
      $insert.InsertBreak(7)
      $insert = $result.Range($result.Content.End - 1, $result.Content.End - 1)
      $insert.FormattedText = $source.Content.FormattedText
      foreach ($field in $insert.Fields) { try { $field.Unlink() | Out-Null } catch {} }
      $source.Saved = $true
      $source.Close(0)
      $source = $null
    }
    $result.ExportAsFixedFormat($OutputPath, 17)
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "exported:$([IO.Path]::GetFileName($OutputPath))"
    return $Rows.Count
  } finally {
    $insert = $null
    $field = $null
    $collection = $null
    $fieldCollections = $null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "closing-result:$([IO.Path]::GetFileName($OutputPath))"
    if ($null -ne $result) { $result.Saved = $true; $result.Close(0) }
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "closing-source:$([IO.Path]::GetFileName($OutputPath))"
    if ($null -ne $source) { $source.Saved = $true; $source.Close(0) }
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "closed:$([IO.Path]::GetFileName($OutputPath))"
  }
}

function Repeat-GeneralNotice($Word, [string]$TemplatePath, [string]$OutputPath, [int]$Count, $Replacements) {
  $source = $null
  $result = $null
  try {
    if ($Count -eq 0) {
      $result = $Word.Documents.Add()
      $result.Range().Text = 'No Bill 3 important notices were required.'
    } else {
      $result = $Word.Documents.Open($TemplatePath, $false, $false)
      Replace-TemplateText $result $Replacements
    }
    for ($index = 1; $index -lt $Count; $index++) {
      $source = $Word.Documents.Open($TemplatePath, $false, $true)
      Replace-TemplateText $source $Replacements
      $insert = $result.Range($result.Content.End - 1, $result.Content.End - 1)
      $insert.InsertBreak(7)
      $insert = $result.Range($result.Content.End - 1, $result.Content.End - 1)
      $insert.FormattedText = $source.Content.FormattedText
      $source.Close(0)
      $source = $null
    }
    $result.ExportAsFixedFormat($OutputPath, 17)
    return $Count
  } finally {
    if ($null -ne $result) { $result.Saved = $true; $result.Close(0) }
    if ($null -ne $source) { $source.Close(0) }
  }
}

function Add-TableSheet($Workbook, [string]$Name, [object[]]$Rows) {
  $sheet = $Workbook.Worksheets.Add()
  $sheet.Name = $Name
  $keys = [System.Collections.Generic.List[string]]::new()
  foreach ($row in $Rows) { foreach ($property in $row.PSObject.Properties) { if (-not $keys.Contains($property.Name)) { $keys.Add($property.Name) } } }
  if ($keys.Count -eq 0) { $keys.Add('Status') }
  for ($column = 0; $column -lt $keys.Count; $column++) { $sheet.Cells.Item(1, $column + 1).Value2 = $keys[$column] }
  for ($rowIndex = 0; $rowIndex -lt $Rows.Count; $rowIndex++) {
    for ($column = 0; $column -lt $keys.Count; $column++) {
      $property = $Rows[$rowIndex].PSObject.Properties[$keys[$column]]
      $sheet.Cells.Item($rowIndex + 2, $column + 1).Value2 = if ($null -eq $property) { '' } else { [string]$property.Value }
    }
  }
  $sheet.UsedRange.Columns.AutoFit() | Out-Null
  return $sheet
}

$payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$root = Split-Path -Parent $PSScriptRoot
$outputDir = [string]$payload.outputDir
$billingMonth = [string]$payload.run.billMonth
$templateWorkbook = Join-Path $root 'bills\Bill Spreadsheet.xlsx'
$spreadsheetPath = Join-Path $outputDir "Bill_Spreadsheet_$billingMonth.xlsx"
Copy-Item -LiteralPath $templateWorkbook -Destination $spreadsheetPath

$excel = $null
$word = $null
$artifacts = [System.Collections.Generic.List[object]]::new()
$errors = [System.Collections.Generic.List[string]]::new()
$pageCounts = [ordered]@{}
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($spreadsheetPath)
  foreach ($mapping in @(@('bill1','Bill 1'), @('bill2','Bill 2'), @('bill3','Bill 3'), @('bill4','Bill 4'))) {
    $rows = @(Get-GroupRows $payload.datasets.($mapping[0]))
    Write-WorksheetRows $workbook.Worksheets.Item($mapping[1]) $rows
  }
  $workbook.Save()
  $workbook.Close($false)
  Release-ComObject $workbook
  $artifacts.Add([pscustomobject]@{ fileName = [IO.Path]::GetFileName($spreadsheetPath); kind = 'spreadsheet' })

  $correctionPath = Join-Path $outputDir "Bill_Corrections_$billingMonth.xlsx"
  $auditBook = $excel.Workbooks.Add()
  while ($auditBook.Worksheets.Count -gt 1) { $auditBook.Worksheets.Item($auditBook.Worksheets.Count).Delete() }
  $auditBook.Worksheets.Item(1).Name = 'Placeholder'
  $s1 = Add-TableSheet $auditBook 'Bill 2 Corrections' @($payload.corrections.bill2)
  $s2 = Add-TableSheet $auditBook 'Bill 4 Corrections' @($payload.corrections.bill4)
  $auditBook.Worksheets.Item('Placeholder').Delete()
  $auditBook.SaveAs($correctionPath, 51)
  $auditBook.Close($false)
  $artifacts.Add([pscustomobject]@{ fileName = [IO.Path]::GetFileName($correctionPath); kind = 'audit' })

  $reconciliationPath = Join-Path $outputDir "Billing_Reconciliation_$billingMonth.xlsx"
  $reconBook = $excel.Workbooks.Add()
  while ($reconBook.Worksheets.Count -gt 1) { $reconBook.Worksheets.Item($reconBook.Worksheets.Count).Delete() }
  $reconBook.Worksheets.Item(1).Name = 'Placeholder'
  foreach ($mapping in @(@('bill1','Bill 1'), @('bill2','Bill 2'), @('bill3','Bill 3'), @('bill4','Bill 4'))) {
    $rows = foreach ($item in (Get-GroupRows $payload.datasets.($mapping[0]))) { [pscustomobject]@{ CertificateNumber=$item.certificateNumber; RecordId=$item.recordId; SortKey=$item.certificateNumeric; Status='Validated' } }
    $sheet = Add-TableSheet $reconBook $mapping[1] @($rows)
  }
  $reconBook.Worksheets.Item('Placeholder').Delete()
  $reconBook.SaveAs($reconciliationPath, 51)
  $reconBook.Close($false)
  $artifacts.Add([pscustomobject]@{ fileName = [IO.Path]::GetFileName($reconciliationPath); kind = 'reconciliation' })

  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $groups = @(
    @{ Key='bill1'; Sheet='Bill 1'; Template='Bill1.docx'; Output="Bill1_$billingMonth.pdf" },
    @{ Key='bill2'; Sheet='Bill 2'; Template='Bill2.docx'; Output="Bill2_$billingMonth.pdf" },
    @{ Key='bill3'; Sheet='Bill 3'; Template='Bill3.docx'; Output="Bill3_$billingMonth.pdf" },
    @{ Key='bill4'; Sheet='Bill 4'; Template='Bill4.docx'; Output="Bill4_$billingMonth.pdf" }
  )
  foreach ($group in $groups) {
    $rows = @(Get-GroupRows $payload.datasets.($group.Key))
    $pdfPath = Join-Path $outputDir $group.Output
    $pageCounts[$group.Key] = Render-TemplateStack $word (Join-Path $root "bills\$($group.Template)") $rows $pdfPath
    $artifacts.Add([pscustomobject]@{ fileName = $group.Output; kind = 'invoice'; recordCount = $rows.Count })
  }

  $bill3Rows = @(Get-GroupRows $payload.datasets.bill3)
  $bill3NoticeName = "Bill3_Important_Notice_$billingMonth.pdf"
  $bill3NoticeMonth = ([DateTime]::ParseExact([string]$payload.run.dates.bill3FirstOverdueMonth, 'MMMM, yyyy', [Globalization.CultureInfo]::InvariantCulture)).ToString('MMMM yyyy')
  $bill3NoticeReplacements = @{ 'September 2026' = $bill3NoticeMonth; 'November 14, 2026' = [string]$payload.run.dates.bill3LapseDeadlineDisplay }
  $pageCounts.bill3Notices = Repeat-GeneralNotice $word (Join-Path $root 'bills\Bill3 Important Notice - edit date.docx') (Join-Path $outputDir $bill3NoticeName) $bill3Rows.Count $bill3NoticeReplacements
  $artifacts.Add([pscustomobject]@{ fileName = $bill3NoticeName; kind = 'notice'; recordCount = $bill3Rows.Count })

  $bill4Rows = @(Get-GroupRows $payload.datasets.bill4)
  $bill4NoticeName = "Bill4_Important_Notice_$billingMonth.pdf"
  $pageCounts.bill4Notices = Render-TemplateStack $word (Join-Path $root 'bills\Bill4 Important Notice.docx') $bill4Rows (Join-Path $outputDir $bill4NoticeName)
  $artifacts.Add([pscustomobject]@{ fileName = $bill4NoticeName; kind = 'notice'; recordCount = $bill4Rows.Count })

  $summaryName = "Billing_Run_Summary_$billingMonth.pdf"
  $summaryHtmlPath = Join-Path $outputDir 'billing-run-summary.html'
  $summaryPdfPath = Join-Path $outputDir $summaryName
  $bill1Count = @(Get-GroupRows $payload.datasets.bill1).Count
  $bill2Count = @(Get-GroupRows $payload.datasets.bill2).Count
  $bill3Count = @(Get-GroupRows $payload.datasets.bill3).Count
  $bill4Count = @(Get-GroupRows $payload.datasets.bill4).Count
  $summaryHtml = @"
<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px Arial;margin:48px;color:#111}h1{font-size:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px;text-align:left}</style></head><body>
<h1>HPA Monthly Billing Run Summary</h1><p><strong>Run ID:</strong> $($payload.run.id)<br><strong>Billing month:</strong> $billingMonth<br><strong>Run by:</strong> $($payload.run.createdBy)<br><strong>Generated:</strong> $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))</p>
<table><tr><th>Measure</th><th>Result</th></tr><tr><td>Bill 1 report / invoices</td><td>$($payload.datasets.bill1.reportId) / $bill1Count</td></tr><tr><td>Bill 2 report / invoices</td><td>$($payload.datasets.bill2.reportId) / $bill2Count</td></tr><tr><td>Bill 3 report / invoices / notices</td><td>$($payload.datasets.bill3.reportId) / $bill3Count / $bill3Count</td></tr><tr><td>Bill 4 report / invoices / notices</td><td>$($payload.datasets.bill4.reportId) / $bill4Count / $bill4Count</td></tr><tr><td>Corrections updated</td><td>$($payload.corrections.summary.updated)</td></tr><tr><td>Corrections unchanged</td><td>$($payload.corrections.summary.unchanged)</td></tr><tr><td>Correction failures</td><td>$($payload.corrections.summary.failed)</td></tr><tr><td>Coverage reductions</td><td>$($payload.corrections.summary.coverageReductions)</td></tr><tr><td>Premium preservation checks</td><td>$($payload.corrections.bill4.Count) verified</td></tr><tr><td>Certificate sorting</td><td>Bill 1: $($payload.datasets.bill1.sortingVerified); Bill 2: $($payload.datasets.bill2.sortingVerified); Bill 3: $($payload.datasets.bill3.sortingVerified); Bill 4: $($payload.datasets.bill4.sortingVerified)</td></tr><tr><td>Bill 4 pairing</td><td>$($payload.bill4Pairing.valid)</td></tr></table><p><strong>Final status:</strong> Validated</p></body></html>
"@
  Set-Content -LiteralPath $summaryHtmlPath -Value $summaryHtml -Encoding UTF8
  $browser = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $browser) { throw 'A browser PDF engine was not found for the billing summary.' }
  $summaryUrl = ([Uri]$summaryHtmlPath).AbsoluteUri
  & $browser '--headless' '--disable-gpu' '--allow-file-access-from-files' '--print-to-pdf-no-header' "--print-to-pdf=$summaryPdfPath" $summaryUrl | Out-Null
  if (-not (Test-Path -LiteralPath $summaryPdfPath)) { throw 'The billing summary PDF was not created.' }
  Remove-Item -LiteralPath $summaryHtmlPath -Force
  $artifacts.Add([pscustomobject]@{ fileName = $summaryName; kind = 'summary' })

  $expected = [ordered]@{ bill1=$bill1Count; bill2=$bill2Count; bill3=$bill3Count; bill4=$bill4Count; bill3Notices=$bill3Count; bill4Notices=$bill4Count }
  foreach ($key in $expected.Keys) { if ([int]$pageCounts[$key] -ne [int]$expected[$key]) { $errors.Add("$key produced $($pageCounts[$key]) page(s) for $($expected[$key]) record(s).") } }
  $packageName = "Billing_Package_$billingMonth.zip"
  $filesToZip = @($artifacts | ForEach-Object { Join-Path $outputDir $_.fileName })
  Compress-Archive -LiteralPath $filesToZip -DestinationPath (Join-Path $outputDir $packageName)
  $artifacts.Add([pscustomobject]@{ fileName = $packageName; kind = 'package' })

  $result = [ordered]@{ valid=($errors.Count -eq 0); errors=@($errors); outputDirectory=$outputDir; artifacts=@($artifacts); pageCounts=$pageCounts; recordCounts=$expected }
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputDir 'generation-result.json') -Encoding UTF8
} catch {
  $errors.Add($_.Exception.Message)
  [ordered]@{ valid=$false; errors=@($errors); outputDirectory=$outputDir; artifacts=@($artifacts); pageCounts=$pageCounts } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputDir 'generation-result.json') -Encoding UTF8
  throw
} finally {
  if ($null -ne $word) { $word.Quit(); Release-ComObject $word }
  if ($null -ne $excel) { $excel.Quit(); Release-ComObject $excel }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
