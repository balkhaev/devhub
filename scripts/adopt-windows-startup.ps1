<#
.SYNOPSIS
Routes the legacy Predict Paper autostart through DevHub.
.DESCRIPTION
Without -Apply this only prints a plan. -Apply backs up the
predict-paper-runtime task XML before changing its launch action. It does not
stop or start any task, server or worker. Production tasks and the Montage
Blender Bridge shortcut are outside this migration.

The Inference queue has no Windows autostart of its own: inference/queue and
inference/executors are ordinary DevHub services marked autostart and start
with the hub. The HKCU Run value "Inference" launched the tray module
inference.tray, removed on 2026-10-12; this script no longer reads or writes it.

Restore: .\scripts\adopt-windows-startup.ps1 -Restore <backup-directory> -Apply
A schema-1 backup also holds that Run value. Restore brings back only the
Predict task from it and reports that the Run value was not restored.
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$Restore,
    [string]$PredictService = 'predict/runtime'
)

$ErrorActionPreference = 'Stop'
$devhubStartupRoot = Split-Path -Parent $PSScriptRoot
$devhubPredictTaskName = 'predict-paper-runtime'

function ConvertTo-DevHubLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-DevHubPredictLegacyScript([string]$CodeRoot) {
    $predictDirectory = Join-Path $CodeRoot 'predict-paper'
    $python = Join-Path $CodeRoot 'predict\.venv\Scripts\python.exe'
    return @(
        '$Host.UI.RawUI.WindowTitle = ''predict paper runtime - close this window to stop''',
        ('Set-Location ' + (ConvertTo-DevHubLiteral $predictDirectory)),
        'New-Item -ItemType Directory -Force artifacts | Out-Null',
        'while ($true) {',
        ('  & ' + (ConvertTo-DevHubLiteral $python) + ' -m predict.local up 2>&1 | Tee-Object -FilePath artifacts\local-up.log -Append'),
        '  Write-Host ''runtime exited; restarting in 30 s (close this window to stop)''',
        '  Start-Sleep -Seconds 30',
        '}'
    ) -join "`n"
}

function Test-DevHubPredictStartup($Task, [string]$CodeRoot, [string]$Root) {
    if (@($Task.Actions).Count -ne 1) { return 'unrecognized' }
    $action = $Task.Actions[0]
    if ($action.Execute -notmatch '(?i)powershell\.exe$') { return 'unrecognized' }
    $wrapper = Join-Path $Root '.state\startup\predict-paper.ps1'
    if ($action.Arguments.Contains($wrapper)) { return 'managed' }
    if ($action.Arguments -notmatch '(?i)-EncodedCommand\s+(\S+)') { return 'unrecognized' }
    try {
        $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
        $expected = [IO.Path]::GetFullPath((Join-Path $CodeRoot 'predict-paper')).TrimEnd('\', '/')
        $actual = [IO.Path]::GetFullPath($action.WorkingDirectory).TrimEnd('\', '/')
        if ($actual -ne $expected) { return 'unrecognized' }
        $knownScript = Get-DevHubPredictLegacyScript -CodeRoot $CodeRoot
        if ($decoded.Replace("`r`n", "`n").Trim() -ne $knownScript.Trim()) { return 'unrecognized' }
    } catch { return 'unrecognized' }
    return 'legacy'
}

function Get-DevHubStartupWrapper([string]$Bun, [string]$Root, [string]$Service) {
    if ($Service -notmatch '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$') {
        throw "Invalid DevHub service key: $Service"
    }
    $cli = Join-Path $Root 'src\cli.ts'
    return @(
        "`$ErrorActionPreference = 'Stop'",
        ('& ' + (ConvertTo-DevHubLiteral $Bun) + ' ' + (ConvertTo-DevHubLiteral $cli) + ' start ' + (ConvertTo-DevHubLiteral $Service)),
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ''
    ) -join "`r`n"
}

function Get-DevHubStartupServices([string]$Bun, [string]$Root) {
    # Catalogue validation is read-only and does not auto-start the hub.
    # File arguments avoid Windows PowerShell 5's native inline-source quoting rules.
    $output = & $Bun (Join-Path $Root 'src\cli.ts') list --json
    if ($LASTEXITCODE -ne 0) { throw 'The DevHub catalogue could not be validated.' }
    $catalogue = $output | ConvertFrom-Json
    return @($catalogue.projects | ForEach-Object {
        $projectId = $_.id
        $_.services | ForEach-Object { [pscustomobject]@{ key = "$projectId/$($_.id)"; command = $_.command; needs = $_.needs } }
    })
}

function Restore-DevHubStartup([string]$Directory, [switch]$Commit) {
    $directoryPath = [IO.Path]::GetFullPath($Directory)
    $manifestPath = Join-Path $directoryPath 'backup.json'
    $backup = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    # Schema 1 also recorded the HKCU Run value "Inference"; schema 2 holds the task only.
    $recordsInference = $backup.Schema -eq 1 -and $backup.RegistryName -eq 'Inference'
    if (($backup.Schema -ne 2 -and -not $recordsInference) -or
        $backup.TaskName -ne $devhubPredictTaskName -or $backup.TaskPath -ne '\') {
        throw 'This is not a supported DevHub startup backup.'
    }
    # That Run value launched inference.tray, which no longer exists: it is never written back.
    $inferenceRunValue = 'not in this backup'
    if ($recordsInference -and $backup.RegistryChanged) {
        $inferenceRunValue = 'not restored'
        Write-Warning ('The Inference Run value saved in this backup is not restored: it launched inference.tray, ' +
            'which was removed. The Inference queue starts with the hub as the autostart service inference/queue.')
    }
    $restoresTask = [bool]$backup.TaskChanged
    if (-not $Commit) {
        [pscustomobject]@{ Mode = 'restore-dry-run'; Backup = $directoryPath; Task = $backup.TaskName; TaskChanged = $restoresTask; InferenceRunValue = $inferenceRunValue }
        return
    }
    if ($restoresTask) {
        # Only change the task while its current launch action still belongs to this migration.
        # A running instance is unaffected by restoring a future launch action.
        $currentTask = Get-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -ErrorAction SilentlyContinue
        if ($null -eq $currentTask -or @($currentTask.Actions).Count -ne 1 -or
            $currentTask.Actions[0].Arguments -ne $backup.NewTaskArguments) {
            throw 'Predict startup changed after migration; refusing to overwrite the newer action.'
        }
        $taskXml = Get-Content -LiteralPath (Join-Path $directoryPath 'predict-paper-runtime.xml') -Raw
        [xml]$originalTask = $taskXml
        $originalAction = $originalTask.Task.Actions.Exec
        $action = New-ScheduledTaskAction -Execute $originalAction.Command -Argument $originalAction.Arguments -WorkingDirectory $originalAction.WorkingDirectory
        Set-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -Action $action | Out-Null
    }
    [pscustomobject]@{ Mode = 'restored'; Backup = $directoryPath; Task = $backup.TaskName; TaskRestored = $restoresTask; InferenceRunValue = $inferenceRunValue; RunningProcessesChanged = $false }
}

function Invoke-DevHubStartupMigration {
    if ($Restore) { Restore-DevHubStartup -Directory $Restore -Commit:$Apply; return }
    $root = [IO.Path]::GetFullPath($devhubStartupRoot)
    $codeRoot = Split-Path -Parent $root
    $powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $predictWrapper = Join-Path $root '.state\startup\predict-paper.ps1'
    $task = Get-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -ErrorAction SilentlyContinue
    $taskStatus = 'absent'
    if ($null -ne $task) { $taskStatus = Test-DevHubPredictStartup -Task $task -CodeRoot $codeRoot -Root $root }
    $newTaskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $predictWrapper + '"'
    $plan = [pscustomobject]@{
        Mode = $(if ($Apply) { 'apply' } else { 'dry-run' })
        Predict = [pscustomobject]@{ Status = $taskStatus; Service = $PredictService; NewArguments = $newTaskArguments; Task = $devhubPredictTaskName }
        BackupRoot = (Join-Path $root '.state\startup-backup')
        RunningProcessesChanged = $false
        ProductionWorkersChanged = $false
    }
    if (-not $Apply) { $plan; return }
    if ($taskStatus -eq 'unrecognized') {
        throw 'The launch action no longer matches the classified legacy startup. Review it before migration.'
    }
    if ($taskStatus -ne 'legacy') { $plan; return }
    $cli = Join-Path $root 'src\cli.ts'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'DevHub CLI is missing; no startup changes made.' }
    $bun = (Get-Command bun -ErrorAction Stop).Source
    if (-not $bun) { $bun = (Get-Command bun -ErrorAction Stop).Path }
    $services = Get-DevHubStartupServices -Bun $bun -Root $root
    if (@($services | Where-Object { $_.key -eq $PredictService }).Count -ne 1) {
        throw "Unknown DevHub service $PredictService; no startup changes made."
    }
    $backupRoot = Join-Path $root '.state\startup-backup'
    $backupDirectory = Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $backup = [ordered]@{
        Schema = 2; TaskName = $devhubPredictTaskName; TaskPath = '\'; TaskChanged = $true
        NewTaskArguments = $newTaskArguments
    }
    Export-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' | Set-Content -LiteralPath (Join-Path $backupDirectory 'predict-paper-runtime.xml') -Encoding Unicode
    $backup | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupDirectory 'backup.json') -Encoding UTF8
    $wrapperDirectory = Join-Path $root '.state\startup'
    New-Item -ItemType Directory -Path $wrapperDirectory -Force | Out-Null
    Get-DevHubStartupWrapper -Bun $bun -Root $root -Service $PredictService | Set-Content -LiteralPath $predictWrapper -Encoding UTF8
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $newTaskArguments -WorkingDirectory $root
    Set-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -Action $action | Out-Null
    [pscustomobject]@{ Mode = 'applied'; Backup = $backupDirectory; RunningProcessesChanged = $false; ProductionWorkersChanged = $false }
}

# Dot-sourcing loads the pure classifiers and wrapper builder for offline tests.
if ($MyInvocation.InvocationName -ne '.') { Invoke-DevHubStartupMigration }
