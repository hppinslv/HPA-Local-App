param(
  [Parameter(Mandatory = $true)][string]$PayloadBase64,
  [string]$Style = 'combined',
  [Parameter(Mandatory = $true)][string]$TemplatePath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
  $template = $excel.Workbooks.Open($TemplatePath, $false, $true)
  if ($Style -eq 'combined-pdf') {
    $book = $excel.Workbooks.Add()
    $sheet = $book.Worksheets.Item(1)
    $sheet.Name = 'Combined IRA'
    $sheet.Cells.Font.Name = 'Arial'; $sheet.Cells.Font.Size = 10; $sheet.Cells.Font.Color = 0
    $sheet.Columns.Item(1).ColumnWidth = 29; $sheet.Columns.Item(2).ColumnWidth = 16; $sheet.Columns.Item(3).ColumnWidth = 18; $sheet.Columns.Item(4).ColumnWidth = 16
    $template.Worksheets.Item('February 2025').Shapes.Item(1).Copy(); $sheet.Paste()
    $currency = '$#,##0.00;[Red]($#,##0.00)'; $dash = [char]0x2013
    $people = @(@{key='araceli';name='Araceli Gandara '+$dash+' 2236-4498'},@{key='melanie';name='Melanie Gardas '+$dash+' 2344-9181'})
    function PdfNumber($cell,[double]$value){$cell.Formula='='+$value.ToString([Globalization.CultureInfo]::InvariantCulture);$cell.NumberFormat=$currency}
    function PdfBorders($range){foreach($cell in $range.Cells){foreach($edge in 7..10){$cell.Borders($edge).LineStyle=1;$cell.Borders($edge).Weight=2;$cell.Borders($edge).Color=0}}}
    $i=0
    foreach($month in $payload.months){$base=1+(8*$i);foreach($r in $base..($base+7)){$sheet.Rows.Item($r).RowHeight=15};$sheet.Cells.Item($base,2).Value2='Employee - EMPL';$sheet.Cells.Item($base,3).Value2='Employer - SMPRC';$sheet.Cells.Item($base,4).Value2='Amount Due';$sheet.Cells.Item($base+1,1).Value2="$($month.label) Totals";$sheet.Cells.Item($base+1,1).Font.Bold=$true;$subtotal=0.0;foreach($person in $people){$row=$base+2+[array]::IndexOf($people,$person);$item=$month.people.($person.key);$sheet.Cells.Item($row,1).Value2=$person.name;PdfNumber $sheet.Cells.Item($row,2) ([double]$item.employee);PdfNumber $sheet.Cells.Item($row,3) ([double]$item.employer);PdfNumber $sheet.Cells.Item($row,4) ([double]$item.due);$subtotal+=[double]$item.due};PdfNumber $sheet.Cells.Item($base+5,4) $subtotal;$sheet.Cells.Item($base+5,4).Font.Bold=$true;PdfBorders $sheet.Range("B$base:D$base");PdfBorders $sheet.Range("A$($base+2):D$($base+3)");PdfBorders $sheet.Range("D$($base+5):D$($base+5)");$i++}
    $grand=2+(8*$i);foreach($r in $grand..($grand+7)){$sheet.Rows.Item($r).RowHeight=15};$sheet.Cells.Item($grand,1).Value2='Grand total';$sheet.Cells.Item($grand,1).Font.Bold=$true;$sheet.Cells.Item($grand+1,2).Value2='Employee - EMPL';$sheet.Cells.Item($grand+1,3).Value2='Employer - SMPRC';$sheet.Cells.Item($grand+1,4).Value2='Amount Due';$sheet.Cells.Item($grand+2,1).Value2='Grand total';$sheet.Cells.Item($grand+2,1).Font.Bold=$true;$allDue=0.0;foreach($person in $people){$row=$grand+3+[array]::IndexOf($people,$person);$employee=0.0;$employer=0.0;$due=0.0;foreach($month in $payload.months){$item=$month.people.($person.key);$employee+=[double]$item.employee;$employer+=[double]$item.employer;$due+=[double]$item.due};$sheet.Cells.Item($row,1).Value2=$person.name;PdfNumber $sheet.Cells.Item($row,2) $employee;PdfNumber $sheet.Cells.Item($row,3) $employer;PdfNumber $sheet.Cells.Item($row,4) $due;$sheet.Range("A$row:D$row").Font.Bold=$true;$allDue+=$due};PdfNumber $sheet.Cells.Item($grand+6,4) $allDue;$sheet.Range("A$grand:D$($grand+6)").Font.Bold=$true;PdfBorders $sheet.Range("A$grand:D$($grand+6)")
    $sheet.Cells.Item($grand+6,4).Font.Bold=$true;PdfBorders $sheet.Range("B$($grand+1):D$($grand+1)");PdfBorders $sheet.Range("A$($grand+3):D$($grand+4)");PdfBorders $sheet.Range("D$($grand+6):D$($grand+6)");$shape=$sheet.Shapes.Item(1);$shape.Top=$sheet.Cells.Item($grand+10,3).Top;$shape.Left=$sheet.Cells.Item($grand+10,3).Left;$sheet.PageSetup.PrintArea='$A$1:$D$'+($grand+13);$sheet.PageSetup.Zoom=$false;$sheet.PageSetup.FitToPagesWide=1;$sheet.PageSetup.FitToPagesTall=1;[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath));$book.ExportAsFixedFormat(0,$OutputPath);$book.Close($false);$template.Close($false);return
  }
  # The historical summary sheets supply the exact HPA layouts.
  $baseSheet = if ($Style -eq 'monthly') { 'Sheet4' } else { 'Sheet6' }
  $template.Worksheets.Item($baseSheet).Copy()
  $book = $excel.ActiveWorkbook
  $sheet = $book.ActiveSheet
  # Copy the signature image from the signed historical sheet.
  $template.Worksheets.Item('February 2025').Shapes.Item(1).Copy()
  $sheet.Paste()
  $sheet.Name = 'Combined IRA'
  $sheet.Cells.ClearContents()
  $sheet.Cells.FormatConditions.Delete()
  $sheet.Columns.Item(1).ColumnWidth = 28
  $sheet.Columns.Item(2).ColumnWidth = 16
  $sheet.Columns.Item(3).ColumnWidth = 18
  $sheet.Columns.Item(4).ColumnWidth = 16

  if ($Style -eq 'monthly') {
    $month = $payload.months[0]
    $dash = [char]0x2013
    $employeeHeading = 'Employee ' + $dash + ' EMPL'
    $employerHeading = 'Employer ' + $dash + ' SMPRC'
    $people = @(
      @{ key = 'araceli'; name = 'Araceli Gandara ' + $dash + ' 2236-4498' },
      @{ key = 'melanie'; name = 'Melanie Gardas ' + $dash + ' 2344-9181' }
    )
    $currencyFormat = '$#,##0.00;[Red]($#,##0.00)'
    function PutNumber($cell, [double]$number) { $cell.Formula = '=' + $number.ToString([Globalization.CultureInfo]::InvariantCulture) }
    $template.Worksheets.Item('Sheet4').Range('A1:D5').Copy()
    $sheet.Range('A1:D5').PasteSpecial(-4122)
    $template.Worksheets.Item('Sheet4').Range('A24:D27').Copy()
    $sheet.Range('A8:D11').PasteSpecial(-4122)
    $sheet.Cells.Item(1, 1).NumberFormat = '@'; $sheet.Cells.Item(1, 1).Value2 = $month.label
    $sheet.Cells.Item(2, 2).Value2 = $employeeHeading; $sheet.Cells.Item(2, 3).Value2 = $employerHeading; $sheet.Cells.Item(2, 4).Value2 = 'Amount Due'
    $employeeTotal = 0.0; $employerTotal = 0.0; $dueTotal = 0.0
    foreach ($person in $people) {
      $row = 3 + [array]::IndexOf($people, $person); $item = $month.people.($person.key)
      $employee = [double]$item.employee; $employer = [double]$item.employer; $due = [double]$item.due
      $sheet.Cells.Item($row, 1).Value2 = $person.name
      PutNumber $sheet.Cells.Item($row, 2) $employee; PutNumber $sheet.Cells.Item($row, 3) $employer; PutNumber $sheet.Cells.Item($row, 4) $due
      $sheet.Range("B$row:D$row").NumberFormat = $currencyFormat
      $employeeTotal += $employee; $employerTotal += $employer; $dueTotal += $due
    }
    $sheet.Cells.Item(5, 1).Value2 = "$(($month.label -split ' ')[0]) Subtotal"; PutNumber $sheet.Cells.Item(5, 4) $dueTotal; $sheet.Cells.Item(5, 4).NumberFormat = $currencyFormat; $sheet.Range('A5:D5').Font.Bold = $true
    $sheet.Cells.Item(8, 1).Value2 = 'Totals'; $sheet.Cells.Item(8, 1).Font.Bold = $true
    foreach ($person in $people) {
      $row = 9 + [array]::IndexOf($people, $person); $item = $month.people.($person.key)
      $sheet.Cells.Item($row, 1).Value2 = $person.name
      PutNumber $sheet.Cells.Item($row, 2) ([double]$item.employee); PutNumber $sheet.Cells.Item($row, 3) ([double]$item.employer); PutNumber $sheet.Cells.Item($row, 4) ([double]$item.due)
      $sheet.Range("A$row:D$row").Font.Bold = $true; $sheet.Range("B$row:D$row").NumberFormat = $currencyFormat
    }
    $sheet.Cells.Item(11, 1).Value2 = 'Grand total'; PutNumber $sheet.Cells.Item(11, 4) $dueTotal; $sheet.Range('A11:D11').Font.Bold = $true; $sheet.Cells.Item(11, 4).NumberFormat = $currencyFormat
    if ($sheet.Shapes.Count -gt 0) { $shape = $sheet.Shapes.Item(1); $shape.Top = $sheet.Cells.Item(13, 3).Top; $shape.Left = $sheet.Cells.Item(13, 3).Left }
    $sheet.PageSetup.PrintArea = '$A$1:$D$16'; $sheet.PageSetup.Orientation = 1; $sheet.PageSetup.Zoom = $false; $sheet.PageSetup.FitToPagesWide = 1; $sheet.PageSetup.FitToPagesTall = 1
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)); $book.SaveAs($OutputPath, 51); $book.Close($false); $template.Close($false); return
  }

  $currencyFormat = '$#,##0.00;[Red]($#,##0.00)'
  function Set-CellNumber($cell, [double]$number) { $cell.Formula = '=' + $number.ToString([Globalization.CultureInfo]::InvariantCulture) }
  function Format-CombinedBlock($range) { $range.Font.Color = 0; $range.Interior.ColorIndex = -4142 }
  $dash = [char]0x2013
  $employeeHeading = 'Employee ' + $dash + ' EMPL'
  $employerHeading = 'Employer ' + $dash + ' SMPRC'
  $nameRows = @(
    @{ key = 'araceli'; name = 'Araceli Gandara – 2236-4498' },
    @{ key = 'melanie'; name = 'Melanie Gardas – 2344-9181' }
  )
  $nameRows = @(
    @{ key = 'araceli'; name = 'Araceli Gandara ' + $dash + ' 2236-4498' },
    @{ key = 'melanie'; name = 'Melanie Gardas ' + $dash + ' 2344-9181' }
  )
  $monthTotals = @()
  $index = 0
  foreach ($month in $payload.months) {
    $base = 1 + (8 * $index)
    # Reuse the original payroll-block formatting from the signed workbook.
    $template.Worksheets.Item('Sheet6').Range('A1:D6').Copy()
    $sheet.Range("A$base:D$($base + 5)").PasteSpecial(-4122)
    $sheet.Cells.Item($base, 2).Value2 = 'Employee – EMPL'
    $sheet.Cells.Item($base, 3).Value2 = 'Employer – SMPRC'
    $sheet.Cells.Item($base, 4).Value2 = 'Amount Due'
    $sheet.Cells.Item($base, 2).Value2 = $employeeHeading
    $sheet.Cells.Item($base, 3).Value2 = $employerHeading
    $sheet.Cells.Item($base + 1, 1).Value2 = "$($month.label) Totals"
    $sheet.Cells.Item($base + 1, 1).Font.Bold = $true

    $employeeTotal = 0.0; $employerTotal = 0.0; $dueTotal = 0.0
    foreach ($person in $nameRows) {
      $item = $month.people.($person.key)
      $row = $base + 2 + [array]::IndexOf($nameRows, $person)
      $employee = [double]$item.employee
      $employer = [double]$item.employer
      $due = [double]$item.due
      $sheet.Cells.Item($row, 1).Value2 = $person.name
      Set-CellNumber $sheet.Cells.Item($row, 2) $employee
      Set-CellNumber $sheet.Cells.Item($row, 3) $employer
      Set-CellNumber $sheet.Cells.Item($row, 4) $due
      $sheet.Range("B$row:D$row").NumberFormat = $currencyFormat
      $employeeTotal += $employee; $employerTotal += $employer; $dueTotal += $due
    }
    $subtotalRow = $base + 5
    Set-CellNumber $sheet.Cells.Item($subtotalRow, 4) $dueTotal
    $sheet.Cells.Item($subtotalRow, 4).NumberFormat = $currencyFormat
    Format-CombinedBlock $sheet.Range("A$base:D$subtotalRow")
    foreach ($rowNumber in $base..($base + 7)) { $sheet.Rows.Item($rowNumber).RowHeight = 15 }
    $sheet.Range("A$base:D$subtotalRow").Font.Bold = $false
    $sheet.Cells.Item($base + 1, 1).Font.Bold = $true
    $sheet.Cells.Item($subtotalRow, 4).Font.Bold = $true
    $monthTotals += @{ employee = $employeeTotal; employer = $employerTotal; due = $dueTotal }
    $index++
  }

  $grand = 2 + (8 * $index)
  $template.Worksheets.Item('Sheet6').Range('A26:D32').Copy()
  $sheet.Range("A$grand:D$($grand + 6)").PasteSpecial(-4122)
  $sheet.Range("A$grand:D$($grand + 6)").Interior.ColorIndex = -4142
  $sheet.Cells.Item($grand, 1).Value2 = 'Grand total'
  $sheet.Cells.Item($grand, 1).Font.Bold = $true
  $sheet.Cells.Item($grand + 1, 2).Value2 = 'Employee – EMPL'
  $sheet.Cells.Item($grand + 1, 3).Value2 = 'Employer – SMPRC'
  $sheet.Cells.Item($grand + 1, 4).Value2 = 'Amount Due'
  $sheet.Cells.Item($grand + 1, 2).Value2 = $employeeHeading
  $sheet.Cells.Item($grand + 1, 3).Value2 = $employerHeading
  $sheet.Cells.Item($grand + 2, 1).Value2 = 'Grand total'
  $sheet.Cells.Item($grand + 2, 1).Font.Bold = $true
  $allEmployee = 0.0; $allEmployer = 0.0; $allDue = 0.0
  foreach ($person in $nameRows) {
    $row = $grand + 3 + [array]::IndexOf($nameRows, $person)
    $employee = 0.0; $employer = 0.0; $due = 0.0
    foreach ($month in $payload.months) { $item = $month.people.($person.key); $employee += [double]$item.employee; $employer += [double]$item.employer; $due += [double]$item.due }
    $sheet.Cells.Item($row, 1).Value2 = $person.name
    Set-CellNumber $sheet.Cells.Item($row, 2) $employee
    Set-CellNumber $sheet.Cells.Item($row, 3) $employer
    Set-CellNumber $sheet.Cells.Item($row, 4) $due
    $sheet.Range("B$row:D$row").NumberFormat = $currencyFormat
    $allEmployee += $employee; $allEmployer += $employer; $allDue += $due
  }
  Set-CellNumber $sheet.Cells.Item($grand + 6, 4) $allDue
  $sheet.Cells.Item($grand + 6, 4).NumberFormat = $currencyFormat
  Format-CombinedBlock $sheet.Range("A$grand:D$($grand + 6)")
  foreach ($rowNumber in $grand..($grand + 7)) { $sheet.Rows.Item($rowNumber).RowHeight = 15 }
  $sheet.Range("A$grand:D$($grand + 6)").Font.Bold = $true

  if ($sheet.Shapes.Count -gt 0) {
    $signatureRow = $grand + 10
    $shape = $sheet.Shapes.Item(1)
    $shape.Top = $sheet.Cells.Item($signatureRow, 3).Top
    $shape.Left = $sheet.Cells.Item($signatureRow, 3).Left
  }
  $sheet.PageSetup.PrintArea = '$A$1:$D$' + ($grand + 12)
  $sheet.PageSetup.Orientation = 1
  $sheet.PageSetup.Zoom = $false
  $sheet.PageSetup.FitToPagesWide = 1
  $sheet.PageSetup.FitToPagesTall = 1
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath))
  $book.SaveAs($OutputPath, 51)
  $book.Close($false)
  $template.Close($false)
} finally {
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
