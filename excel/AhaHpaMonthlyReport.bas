Attribute VB_Name = "AhaHpaMonthlyReport"
Option Explicit

Private Const XL_CALCULATION_DONE As Long = 0
Private Const XL_TYPE_PDF As Long = 0
Private Const XL_CONNECTOR_PROG_ID As String = "TaralexLLC.SalesforceEnabler"

Public Sub RunMonthlyReport()
    RunMonthlyReportInternal False
End Sub

Public Sub RunMonthlyReportAndExportPdf()
    RunMonthlyReportInternal True
End Sub

Private Sub RunMonthlyReportInternal(ByVal exportPdf As Boolean)
    Dim sourceWorkbook As Workbook
    Dim finalReportSheet As Worksheet
    Dim outputWorkbookPath As String
    Dim outputPdfPath As String
    Dim reportMonthLabel As String

    On Error GoTo CleanFail

    Application.ScreenUpdating = False
    Application.EnableEvents = False
    Application.DisplayAlerts = False
    Application.StatusBar = "Running monthly report..."

    Set sourceWorkbook = ThisWorkbook

    reportMonthLabel = Format(DateAdd("m", -1, Date), "MMMM yyyy")
    outputWorkbookPath = sourceWorkbook.Path & "\AHA HPA Transaction Summary - " & reportMonthLabel & ".xlsm"
    outputPdfPath = sourceWorkbook.Path & "\AHA HPA Transaction Summary - " & reportMonthLabel & ".pdf"

    If Len(Dir$(outputWorkbookPath)) > 0 Then
        Err.Raise vbObjectError + 101, "RunMonthlyReport", "Output workbook already exists: " & outputWorkbookPath
    End If

    If exportPdf And Len(Dir$(outputPdfPath)) > 0 Then
        Err.Raise vbObjectError + 102, "RunMonthlyReport", "Output PDF already exists: " & outputPdfPath
    End If

    Application.StatusBar = "Refreshing Salesforce data from XL Connector..."
    RefreshSalesforceData sourceWorkbook
    WaitForWorkbookIdle sourceWorkbook, 900

    Application.StatusBar = "Recalculating workbook..."
    Application.CalculateFullRebuild
    WaitForWorkbookIdle sourceWorkbook, 900

    Application.StatusBar = "Validating required tabs..."
    AssertRequiredSheets sourceWorkbook

    Set finalReportSheet = sourceWorkbook.Worksheets("Final Report")

    Application.StatusBar = "Checking Final Report for formula errors..."
    AssertFinalReportHasNoFormulaErrors finalReportSheet

    Application.StatusBar = "Saving dated workbook copy..."
    sourceWorkbook.SaveCopyAs outputWorkbookPath

    If exportPdf Then
        Application.StatusBar = "Exporting Final Report PDF..."
        finalReportSheet.ExportAsFixedFormat Type:=XL_TYPE_PDF, Filename:=outputPdfPath
    End If

    Application.StatusBar = False
    Application.DisplayAlerts = True
    Application.EnableEvents = True
    Application.ScreenUpdating = True

    MsgBox "Monthly report complete." & vbCrLf & outputWorkbookPath, vbInformation, "Run Monthly Report"
    Exit Sub

CleanFail:
    Application.StatusBar = False
    Application.DisplayAlerts = True
    Application.EnableEvents = True
    Application.ScreenUpdating = True

    MsgBox "Monthly report failed: " & Err.Description, vbCritical, "Run Monthly Report"
End Sub

Private Sub RefreshSalesforceData(ByVal targetWorkbook As Workbook)
    Dim connectorAddIn As COMAddIn
    Dim connectorObject As Object

    On Error Resume Next
    Set connectorAddIn = Application.COMAddIns.Item(XL_CONNECTOR_PROG_ID)
    On Error GoTo ConnectorFallback

    If connectorAddIn Is Nothing Then
        GoTo ConnectorFallback
    End If

    If connectorAddIn.Connect = False Then
        connectorAddIn.Connect = True
    End If

    Set connectorObject = connectorAddIn.Object

    If connectorObject Is Nothing Then
        GoTo ConnectorFallback
    End If

    connectorObject.Refresh
    Exit Sub

ConnectorFallback:
    Err.Clear
    targetWorkbook.RefreshAll
End Sub

Private Sub WaitForWorkbookIdle(ByVal targetWorkbook As Workbook, ByVal timeoutSeconds As Long)
    Dim startTime As Single
    Dim isRefreshing As Boolean
    Dim sheet As Worksheet
    Dim queryTable As QueryTable

    startTime = Timer

    Do
        On Error Resume Next
        Application.CalculateUntilAsyncQueriesDone
        On Error GoTo 0

        isRefreshing = False

        For Each sheet In targetWorkbook.Worksheets
            For Each queryTable In sheet.QueryTables
                If queryTable.Refreshing Then
                    isRefreshing = True
                    Exit For
                End If
            Next queryTable

            If isRefreshing Then
                Exit For
            End If
        Next sheet

        If Not isRefreshing And Application.CalculationState = XL_CALCULATION_DONE Then
            Exit Do
        End If

        DoEvents

        If Timer - startTime > timeoutSeconds Then
            Err.Raise vbObjectError + 103, "RunMonthlyReport", "Timed out waiting for workbook refresh/calculation to finish."
        End If
    Loop
End Sub

Private Sub AssertRequiredSheets(ByVal targetWorkbook As Workbook)
    Dim requiredSheets As Variant
    Dim index As Long
    Dim missingSheets As Collection
    Dim message As String

    requiredSheets = Array( _
        "Totals - Billing - Credits ...", _
        "Billing Credits", _
        "Billing & Direct Debit - Re...", _
        "B & DD Refund", _
        "Billing - Bounced Checks", _
        "B BC", _
        "Direct Debit (UMB Bank) - Credi", _
        "DD C", _
        "Direct Debit (UMB Bank) Returne", _
        "DD Returned Items", _
        "Credit Cards (UMB) - Credits", _
        "CC C", _
        "Credit Cards (UMB) - Refunds", _
        "CC R", _
        "Direct Debit (M&T Bank) - R...", _
        "DD RR", _
        "Final Report" _
    )

    Set missingSheets = New Collection

    On Error Resume Next

    For index = LBound(requiredSheets) To UBound(requiredSheets)
        If targetWorkbook.Worksheets(CStr(requiredSheets(index))) Is Nothing Then
            missingSheets.Add CStr(requiredSheets(index))
        End If
        Err.Clear
    Next index

    On Error GoTo 0

    If missingSheets.Count > 0 Then
        For index = 1 To missingSheets.Count
            If Len(message) > 0 Then
                message = message & ", "
            End If
            message = message & missingSheets(index)
        Next index

        Err.Raise vbObjectError + 104, "RunMonthlyReport", "Missing required sheets: " & message
    End If
End Sub

Private Sub AssertFinalReportHasNoFormulaErrors(ByVal finalReportSheet As Worksheet)
    Dim usedRange As Range
    Dim cell As Range
    Dim sampleErrors As String
    Dim errorCount As Long

    Set usedRange = finalReportSheet.UsedRange

    For Each cell In usedRange.Cells
        If cell.HasFormula Then
            If Left$(cell.Text, 1) = "#" Then
                errorCount = errorCount + 1

                If errorCount <= 10 Then
                    If Len(sampleErrors) > 0 Then
                        sampleErrors = sampleErrors & ", "
                    End If
                    sampleErrors = sampleErrors & cell.Address(False, False) & "=" & cell.Text
                End If
            End If
        End If
    Next cell

    If errorCount > 0 Then
        Err.Raise vbObjectError + 105, "RunMonthlyReport", "Final Report contains formula errors: " & sampleErrors
    End If
End Sub
