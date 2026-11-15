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

function Get-RowValue($Values, [string]$Header) {
  $property = $Values.PSObject.Properties[$Header]
  if ($null -ne $property) { return $property.Value }
  $normalizedHeader = (Get-FieldName $Header).ToLowerInvariant()
  foreach ($candidate in $Values.PSObject.Properties) {
    if ((Get-FieldName $candidate.Name).ToLowerInvariant() -eq $normalizedHeader) { return $candidate.Value }
  }
  return ''
}

function Get-BillingFileDateStamp($Run) {
  $source = [string]$Run.scheduledProcessingDate
  if ([string]::IsNullOrWhiteSpace($source)) { $source = [string]$Run.dates.processingDate }
  if ([string]::IsNullOrWhiteSpace($source)) { $source = [string]$Run.processingDate }
  $parsed = [DateTime]::MinValue
  if (-not [DateTime]::TryParseExact($source, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)) {
    throw "The billing processing date must use YYYY-MM-DD before files can be named. Received: $source"
  }
  $productionDate = $parsed.AddMonths(-1)
  return $productionDate.ToString('yyyy.MM.dd', [Globalization.CultureInfo]::InvariantCulture)
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
    if ($header -eq 'Certificate Number: Certificate Name') {
      $Worksheet.Range($Worksheet.Cells.Item(2, $column), $Worksheet.Cells.Item($Rows.Count + 1, $column)).NumberFormat = '@'
    }
    for ($rowIndex = 0; $rowIndex -lt $Rows.Count; $rowIndex++) {
      $matrix[$rowIndex, ($column - 1)] = Get-RowValue $Rows[$rowIndex].values $header
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
      $record[$field] = Get-RowValue $row.values $header
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

function Get-PdfPageCount([string]$Path) {
  $countScript = Join-Path $root 'scripts\count-pdf-pages.js'
  $countOutput = & node $countScript $Path 2>&1
  $countText = ([string]$countOutput).Trim()
  $count = 0
  if ($LASTEXITCODE -ne 0 -or -not [int]::TryParse($countText, [ref]$count)) {
    throw "Unable to count pages in $([IO.Path]::GetFileName($Path)): $countOutput"
  }
  return $count
}

function Remove-BlankSecondMemberParagraphs($Document) {
  $removed = 0
  foreach ($shape in $Document.Shapes) {
    try {
      if ($shape.TextFrame.HasText -eq 0) { continue }
      $paragraphs = $shape.TextFrame.TextRange.Paragraphs
      if ($paragraphs.Count -lt 3 -or $paragraphs.Count -gt 6) { continue }
      $firstRange = $paragraphs.Item(1).Range.Duplicate
      $secondRange = $paragraphs.Item(2).Range.Duplicate
      $thirdRange = $paragraphs.Item(3).Range.Duplicate
      foreach ($range in @($firstRange, $secondRange, $thirdRange)) {
        $range.TextRetrievalMode.IncludeHiddenText = $false
        $range.TextRetrievalMode.IncludeFieldCodes = $false
      }
      $first = [string]$firstRange.Text
      $second = [string]$secondRange.Text
      $third = [string]$thirdRange.Text
      $firstHasVisibleText = $first -match '[\p{L}\p{N}]'
      $secondHasVisibleText = $second -match '[\p{L}\p{N}]'
      $thirdHasVisibleText = $third -match '[\p{L}\p{N}]'
      if ($firstHasVisibleText -and -not $secondHasVisibleText -and $thirdHasVisibleText) {
        [void]$paragraphs.Item(2).Range.Delete()
        $removed += 1
      }
    } catch {
      throw "Unable to remove an empty second-member line from a billing address block: $($_.Exception.Message)"
    }
  }
  return $removed
}

function Normalize-TemplateMemberFields($Document) {
  $removed = 0
  $restructured = 0
  try { $Document.TrackRevisions = $false } catch {}
  try { $Document.Revisions.AcceptAll() } catch {}
  foreach ($shape in $Document.Shapes) {
    try {
      if ($shape.TextFrame.HasText -eq 0) { continue }
      foreach ($paragraph in $shape.TextFrame.TextRange.Paragraphs) {
        $member2Fields = [System.Collections.Generic.List[object]]::new()
        foreach ($field in $paragraph.Range.Fields) {
          if ([string]$field.Code.Text -match '(?i)MERGEFIELD\s+"?Member_2\b') {
            $member2Fields.Add($field)
          }
        }
        for ($index = $member2Fields.Count - 1; $index -ge 1; $index--) {
          [void]$member2Fields[$index].Delete()
          $removed += 1
        }
      }
    } catch {
      throw "Unable to normalize the Member 2 merge field in the billing template: $($_.Exception.Message)"
    }
  }
  if ($removed -gt 0) {
    foreach ($shape in $Document.Shapes) {
      try {
        if ($shape.TextFrame.HasText -eq 0) { continue }
        $paragraphs = $shape.TextFrame.TextRange.Paragraphs
        if ($paragraphs.Count -lt 3) { continue }
        $firstCodes = @($paragraphs.Item(1).Range.Fields | ForEach-Object { [string]$_.Code.Text }) -join ' '
        $secondCodes = @($paragraphs.Item(2).Range.Fields | ForEach-Object { [string]$_.Code.Text }) -join ' '
        $thirdCodes = @($paragraphs.Item(3).Range.Fields | ForEach-Object { [string]$_.Code.Text }) -join ' '
        if ($firstCodes -notmatch '(?i)MERGEFIELD\s+"?Member_1\b' -or
            $secondCodes -notmatch '(?i)MERGEFIELD\s+"?Member_2\b' -or
            $thirdCodes -notmatch '(?i)MERGEFIELD\s+"?Certificate_Number_Billing_Street\b') { continue }
        $insert = $paragraphs.Item(1).Range.Duplicate
        $insert.SetRange($insert.End - 1, $insert.End - 1)
        $conditionalPrefix = [string][char]11
        [void]$Document.Fields.Add($insert, -1, "MERGEFIELD Member_2 \b `"$conditionalPrefix`"", $false)
        [void]$paragraphs.Item(2).Range.Delete()
        $restructured += 1
      } catch {
        throw "Unable to restructure the conditional Member 2 line in the billing template: $($_.Exception.Message)"
      }
    }
  }
  return [pscustomobject]@{ duplicatesRemoved = $removed; addressBlocksRestructured = $restructured }
}

function Merge-TemplateRangeToPdf($Word, [string]$TemplatePath, [string]$WorkbookPath, [string]$SheetName, [string]$OutputPath, [int]$FirstRecord, [int]$LastRecord) {
  $template = $null
  $merged = $null
  try {
    $template = $Word.Documents.Open($TemplatePath, $false, $true)
    $memberFieldNormalization = Normalize-TemplateMemberFields $template
    if ($memberFieldNormalization.duplicatesRemoved -gt 0 -or $memberFieldNormalization.addressBlocksRestructured -gt 0) {
      Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "member-fields-normalized:$([IO.Path]::GetFileName($OutputPath)):$($memberFieldNormalization.duplicatesRemoved):$($memberFieldNormalization.addressBlocksRestructured)"
    }
    $template.MailMerge.MainDocumentType = 0
    $sql = "SELECT * FROM [$SheetName`$]"
    $template.MailMerge.OpenDataSource($WorkbookPath, 0, $false, $true, $true, $false, '', '', $false, '', '', '', $sql, '', $false, 0)
    $template.MailMerge.DataSource.FirstRecord = $FirstRecord
    $template.MailMerge.DataSource.LastRecord = $LastRecord
    $template.MailMerge.Destination = 0
    $template.MailMerge.SuppressBlankLines = $true
    $template.MailMerge.Execute($false)
    $merged = $Word.ActiveDocument
    $merged.Fields.Update() | Out-Null
    foreach ($story in $merged.StoryRanges) { try { $story.Fields.Update() | Out-Null } catch {} }
    $removedMemberLines = Remove-BlankSecondMemberParagraphs $merged
    if ($removedMemberLines -gt 0) {
      Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "blank-member-lines-removed:$([IO.Path]::GetFileName($OutputPath)):${removedMemberLines}"
    }
    $merged.ExportAsFixedFormat($OutputPath, 17)
    return Get-PdfPageCount $OutputPath
  } finally {
    if ($null -ne $merged) { $merged.Close(0); Release-ComObject $merged }
    if ($null -ne $template) { $template.Close(0); Release-ComObject $template }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
}

function Merge-TemplateToPdf($Word, [string]$TemplatePath, [string]$WorkbookPath, [string]$SheetName, [string]$OutputPath, [int]$ExpectedRecords) {
  if ($ExpectedRecords -eq 0) {
    $empty = $Word.Documents.Add()
    try {
      $empty.Range().Text = 'No records were returned for this billing group.'
      $empty.ExportAsFixedFormat($OutputPath, 17)
      return Get-PdfPageCount $OutputPath
    } finally {
      $empty.Close(0)
      Release-ComObject $empty
    }
  }
  $chunkSize = 100
  if ($ExpectedRecords -le $chunkSize) {
    return Merge-TemplateRangeToPdf $Word $TemplatePath $WorkbookPath $SheetName $OutputPath 1 $ExpectedRecords
  }
  $chunkPaths = [System.Collections.Generic.List[string]]::new()
  $totalPages = 0
  try {
    for ($first = 1; $first -le $ExpectedRecords; $first += $chunkSize) {
      $last = [Math]::Min($first + $chunkSize - 1, $ExpectedRecords)
      $chunkPath = "$OutputPath.range-$first-$last.pdf"
      $pages = Merge-TemplateRangeToPdf $Word $TemplatePath $WorkbookPath $SheetName $chunkPath $first $last
      $totalPages += $pages
      $chunkPaths.Add($chunkPath)
      Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "mail-merge-range:$([IO.Path]::GetFileName($OutputPath)):${first}-${last}:${pages}"
    }
    $mergeScript = Join-Path $root 'scripts\merge-pdfs.js'
    $mergeOutput = & node $mergeScript $OutputPath @($chunkPaths) 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
      throw "Unable to merge native mail-merge ranges for $([IO.Path]::GetFileName($OutputPath)): $mergeOutput"
    }
    return $totalPages
  } finally {
    foreach ($chunkPath in $chunkPaths) { Remove-Item -LiteralPath $chunkPath -Force -ErrorAction SilentlyContinue }
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
  $chunkSize = 50
  if ($Rows.Count -gt $chunkSize) {
    $chunkPaths = [System.Collections.Generic.List[string]]::new()
    try {
      for ($start = 0; $start -lt $Rows.Count; $start += $chunkSize) {
        $finish = [Math]::Min($start + $chunkSize - 1, $Rows.Count - 1)
        $chunkRows = @($Rows[$start..$finish])
        $chunkPath = "$OutputPath.chunk-$([int]($start / $chunkSize) + 1).pdf"
        [void](Render-TemplateStack $Word $TemplatePath $chunkRows $chunkPath)
        $chunkPaths.Add($chunkPath)
        Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "chunk:$([IO.Path]::GetFileName($OutputPath)):$($finish + 1)/$($Rows.Count)"
      }
      $mergeScript = Join-Path $root 'scripts\merge-pdfs.js'
      $mergeOutput = & node $mergeScript $OutputPath @($chunkPaths) 2>&1
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
        throw "Unable to merge PDF chunks for $([IO.Path]::GetFileName($OutputPath)): $mergeOutput"
      }
      Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "merged:$([IO.Path]::GetFileName($OutputPath)):$($Rows.Count)"
      return $Rows.Count
    } finally {
      foreach ($chunkPath in $chunkPaths) { Remove-Item -LiteralPath $chunkPath -Force -ErrorAction SilentlyContinue }
    }
  }
  $source = $null
  $result = $null
  $tempSourcePath = $null
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
      $tempSourcePath = Join-Path ([IO.Path]::GetTempPath()) "hpa-billing-$PID-$([guid]::NewGuid().ToString('N')).docx"
      $source.SaveAs2($tempSourcePath, 16)
      $source.Saved = $true
      $source.Close(0)
      try { Release-ComObject $source } catch {}
      $source = $null
      $insert = $result.Range($result.Content.End - 1, $result.Content.End - 1)
      $insert.InsertBreak(7)
      $insert = $result.Range($result.Content.End - 1, $result.Content.End - 1)
      $insert.InsertFile($tempSourcePath)
      foreach ($field in $insert.Fields) { try { $field.Unlink() | Out-Null } catch {} }
      Remove-Item -LiteralPath $tempSourcePath -Force -ErrorAction SilentlyContinue
      $tempSourcePath = $null
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
    if ($null -ne $result) {
      try { $result.Saved = $true } catch {}
      try { $result.Close(0) } catch {}
      try { Release-ComObject $result } catch {}
    }
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "closing-source:$([IO.Path]::GetFileName($OutputPath))"
    if ($null -ne $source) {
      try { $source.Saved = $true } catch {}
      try { $source.Close(0) } catch {}
      try { Release-ComObject $source } catch {}
    }
    if ($tempSourcePath) { Remove-Item -LiteralPath $tempSourcePath -Force -ErrorAction SilentlyContinue }
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "closed:$([IO.Path]::GetFileName($OutputPath))"
  }
}

function Repeat-GeneralNotice($Word, [string]$TemplatePath, [string]$OutputPath, [int]$Count, $Replacements) {
  $document = $null
  $singlePath = "$OutputPath.single.pdf"
  try {
    if ($Count -eq 0) {
      $document = $Word.Documents.Add()
      $document.Range().Text = 'No Bill 3 important notices were required.'
      $document.ExportAsFixedFormat($OutputPath, 17)
      return 0
    } else {
      $document = $Word.Documents.Open($TemplatePath, $false, $false)
      Replace-TemplateText $document $Replacements
    }
    $document.ExportAsFixedFormat($singlePath, 17)
    $pageCount = Get-PdfPageCount $singlePath
    if ($pageCount -ne 1) {
      throw "Bill 3 important notice template must render as one PDF page; rendered $pageCount pages."
    }
    $document.Saved = $true
    $document.Close(0)
    Release-ComObject $document
    $document = $null
    if ($Count -eq 1) {
      Move-Item -LiteralPath $singlePath -Destination $OutputPath -Force
    } else {
      $mergeScript = Join-Path $root 'scripts\merge-pdfs.js'
      $inputs = @(for ($index = 0; $index -lt $Count; $index++) { $singlePath })
      $mergeOutput = & node $mergeScript $OutputPath @inputs 2>&1
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
        throw "Unable to assemble Bill 3 important notices: $mergeOutput"
      }
    }
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "notice-repeat:$([IO.Path]::GetFileName($OutputPath)):${Count}"
    return $Count
  } finally {
    if ($null -ne $document) {
      try { $document.Saved = $true } catch {}
      try { $document.Close(0) } catch {}
      try { Release-ComObject $document } catch {}
    }
    Remove-Item -LiteralPath $singlePath -Force -ErrorAction SilentlyContinue
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
$billingFileDateStamp = Get-BillingFileDateStamp $payload.run
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
    @{ Key='bill1'; Sheet='Bill 1'; Template='Bill1.docx'; Output="${billingFileDateStamp}_Bill1.pdf" },
    @{ Key='bill2'; Sheet='Bill 2'; Template='Bill2.docx'; Output="${billingFileDateStamp}_Bill2.pdf" },
    @{ Key='bill3'; Sheet='Bill 3'; Template='Bill3.docx'; Output="${billingFileDateStamp}_Bill3.pdf" },
    @{ Key='bill4'; Sheet='Bill 4'; Template='Bill4.docx'; Output="${billingFileDateStamp}_Bill4.pdf" }
  )
  foreach ($group in $groups) {
    $rows = @(Get-GroupRows $payload.datasets.($group.Key))
    $pdfPath = Join-Path $outputDir $group.Output
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "mail-merge-start:$($group.Output):$($rows.Count)"
    $pageCounts[$group.Key] = Merge-TemplateToPdf $word (Join-Path $root "bills\$($group.Template)") $spreadsheetPath $group.Sheet $pdfPath $rows.Count
    Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "mail-merge-complete:$($group.Output):$($pageCounts[$group.Key])"
    $artifacts.Add([pscustomobject]@{ fileName = $group.Output; kind = 'invoice'; recordCount = $rows.Count })
  }

  try { $word.Quit() } catch {}
  try { Release-ComObject $word } catch {}
  $word = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value 'word-restarted-for-notices'

  $bill3Rows = @(Get-GroupRows $payload.datasets.bill3)
  $bill3NoticeName = "${billingFileDateStamp}_Bill3_Letter.pdf"
  $bill3NoticeMonth = ([DateTime]::ParseExact([string]$payload.run.dates.bill3FirstOverdueMonth, 'MMMM, yyyy', [Globalization.CultureInfo]::InvariantCulture)).ToString('MMMM yyyy')
  $bill3NoticeReplacements = @{ 'September 2026' = $bill3NoticeMonth; 'November 14, 2026' = [string]$payload.run.dates.bill3LapseDeadlineDisplay }
  $pageCounts.bill3Notices = Repeat-GeneralNotice $word (Join-Path $root 'bills\Bill3 Important Notice - edit date.docx') (Join-Path $outputDir $bill3NoticeName) $bill3Rows.Count $bill3NoticeReplacements
  $artifacts.Add([pscustomobject]@{ fileName = $bill3NoticeName; kind = 'notice'; recordCount = $bill3Rows.Count })

  $bill4Rows = @(Get-GroupRows $payload.datasets.bill4)
  $bill4NoticeName = "${billingFileDateStamp}_Bill4_Letter.pdf"
  Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "mail-merge-start:${bill4NoticeName}:$($bill4Rows.Count)"
  $pageCounts.bill4Notices = Merge-TemplateToPdf $word (Join-Path $root 'bills\Bill4 Important Notice.docx') $spreadsheetPath 'Bill 4' (Join-Path $outputDir $bill4NoticeName) $bill4Rows.Count
  Add-Content -LiteralPath (Join-Path $outputDir 'office-progress.log') -Value "mail-merge-complete:${bill4NoticeName}:$($pageCounts.bill4Notices)"
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
  if ($null -ne $word) { try { $word.Quit() } catch {}; try { Release-ComObject $word } catch {} }
  if ($null -ne $excel) { try { $excel.Quit() } catch {}; try { Release-ComObject $excel } catch {} }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
