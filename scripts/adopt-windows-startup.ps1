<#
.SYNOPSIS
Routes the two known local development autostarts through DevHub.
.DESCRIPTION
Without -Apply this only prints a plan. -Apply backs up the Inference registry
value and predict-paper-runtime task XML before changing their launch actions.
It does not stop or start any task, tray, server or worker. Production tasks and
the Montage Blender Bridge shortcut are outside this migration.

The queue contract must preserve the Inference tray and its paired executors,
or -InferenceTrayWorkersPreserved must be supplied after that integration has
been verified separately. The legacy tray has no client-only switch.

Restore: .\scripts\adopt-windows-startup.ps1 -Restore <backup-directory> -Apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$Restore,
    [string]$InferenceService = 'inference/queue',
    [string]$PredictService = 'predict/runtime',
    [switch]$InferenceTrayWorkersPreserved
)

$ErrorActionPreference = 'Stop'
$devhubStartupRoot = Split-Path -Parent $PSScriptRoot
$devhubRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$devhubPredictTaskName = 'predict-paper-runtime'

function ConvertTo-DevHubLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-DevHubStartupRegistry {
    $key = Get-Item -LiteralPath $devhubRunKey -ErrorAction SilentlyContinue
    if ($null -eq $key -or $key.GetValueNames() -notcontains 'Inference') {
        return [pscustomobject]@{ Exists = $false; Value = $null; Kind = 'String' }
    }
    return [pscustomobject]@{
        Exists = $true
        Value = $key.GetValue('Inference', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        Kind = [string]$key.GetValueKind('Inference')
    }
}

function Test-DevHubInferenceStartup([string]$Value, [string]$Root) {
    if ($Value -match '(?i)^\s*"?[^"\r\n]*pythonw?\.exe"?\s+-m\s+inference\.tray(?:\s+--(?:data-dir|ffmpeg)\s+(?:"[^"\r\n]+"|[^\s";|&]+))*\s*$') {
        return 'legacy'
    }
    $wrapper = Join-Path $Root '.state\startup\inference.ps1'
    if ($Value.Contains($wrapper) -and $Value -match '(?i)powershell\.exe') {
        return 'managed'
    }
    return 'unrecognized'
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

function Get-DevHubStartupCommand([string]$PowerShell, [string]$Wrapper) {
    if ($PowerShell.Contains('"') -or $Wrapper.Contains('"')) { throw 'Startup paths cannot contain double quotes.' }
    return '"' + $PowerShell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Wrapper + '"'
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
    if ($backup.Schema -ne 1 -or $backup.RegistryName -ne 'Inference' -or
        $backup.TaskName -ne $devhubPredictTaskName -or $backup.TaskPath -ne '\') {
        throw 'This is not a supported DevHub startup backup.'
    }
    if (-not $Commit) {
        [pscustomobject]@{ Mode = 'restore-dry-run'; Backup = $directoryPath; Registry = 'Inference'; Task = $backup.TaskName }
        return
    }
    # Only change resources whose current launch action still belongs to this migration.
    # A running instance is unaffected by restoring a future launch action.
    $currentRegistry = Get-DevHubStartupRegistry
    if ($backup.RegistryChanged) {
        if (-not $currentRegistry.Exists -or $currentRegistry.Value -ne $backup.NewRegistryValue) {
            throw 'Inference startup changed after migration; refusing to overwrite the newer value.'
        }
    }
    $currentTask = Get-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($backup.TaskChanged -and ($null -eq $currentTask -or
        @($currentTask.Actions).Count -ne 1 -or
        $currentTask.Actions[0].Arguments -ne $backup.NewTaskArguments)) {
        throw 'Predict startup changed after migration; refusing to overwrite the newer action.'
    }
    if ($backup.TaskChanged) {
        $taskXml = Get-Content -LiteralPath (Join-Path $directoryPath 'predict-paper-runtime.xml') -Raw
        [xml]$originalTask = $taskXml
        $originalAction = $originalTask.Task.Actions.Exec
        $action = New-ScheduledTaskAction -Execute $originalAction.Command -Argument $originalAction.Arguments -WorkingDirectory $originalAction.WorkingDirectory
        Set-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -Action $action | Out-Null
    }
    if ($backup.RegistryChanged) {
        New-ItemProperty -LiteralPath $devhubRunKey -Name 'Inference' -Value $backup.Registry.Value -PropertyType $backup.Registry.Kind -Force | Out-Null
    }
    [pscustomobject]@{ Mode = 'restored'; Backup = $directoryPath; RunningProcessesChanged = $false }
}

function Invoke-DevHubStartupMigration {
    if ($Restore) { Restore-DevHubStartup -Directory $Restore -Commit:$Apply; return }
    $root = [IO.Path]::GetFullPath($devhubStartupRoot)
    $codeRoot = Split-Path -Parent $root
    $powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $inferenceWrapper = Join-Path $root '.state\startup\inference.ps1'
    $predictWrapper = Join-Path $root '.state\startup\predict-paper.ps1'
    $registry = Get-DevHubStartupRegistry
    $registryStatus = 'absent'
    if ($registry.Exists) { $registryStatus = Test-DevHubInferenceStartup -Value $registry.Value -Root $root }
    $task = Get-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -ErrorAction SilentlyContinue
    $taskStatus = 'absent'
    if ($null -ne $task) { $taskStatus = Test-DevHubPredictStartup -Task $task -CodeRoot $codeRoot -Root $root }
    $newRegistryValue = Get-DevHubStartupCommand -PowerShell $powerShell -Wrapper $inferenceWrapper
    $newTaskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $predictWrapper + '"'
    $plan = [pscustomobject]@{
        Mode = $(if ($Apply) { 'apply' } else { 'dry-run' })
        Inference = [pscustomobject]@{ Status = $registryStatus; Service = $InferenceService; NewCommand = $newRegistryValue; PreservesTrayAndPairedWorkersRequired = $true }
        Predict = [pscustomobject]@{ Status = $taskStatus; Service = $PredictService; NewArguments = $newTaskArguments; Task = $devhubPredictTaskName }
        BackupRoot = (Join-Path $root '.state\startup-backup')
        RunningProcessesChanged = $false
        ProductionWorkersChanged = $false
    }
    if (-not $Apply) { $plan; return }
    if ($registryStatus -eq 'unrecognized' -or $taskStatus -eq 'unrecognized') {
        throw 'A launch action no longer matches the classified legacy startup. Review it before migration.'
    }
    if ($registryStatus -ne 'legacy' -and $taskStatus -ne 'legacy') { $plan; return }
    $cli = Join-Path $root 'src\cli.ts'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'DevHub CLI is missing; no startup changes made.' }
    $bun = (Get-Command bun -ErrorAction Stop).Source
    if (-not $bun) { $bun = (Get-Command bun -ErrorAction Stop).Path }
    $services = Get-DevHubStartupServices -Bun $bun -Root $root
    if ($registryStatus -eq 'legacy') {
        $queueService = @($services | Where-Object { $_.key -eq $InferenceService })
        if ($queueService.Count -ne 1) { throw "Unknown DevHub service $InferenceService; no startup changes made." }
        if (-not $InferenceTrayWorkersPreserved -and $queueService[0].command -notmatch 'inference\.tray') {
            throw 'The queue contract does not preserve the Inference tray and paired workers yet; no startup changes made.'
        }
        $dataArgument = [regex]::Match($registry.Value, '--data-dir\s+(?:"([^"]+)"|([^\s]+))')
        if ($dataArgument.Success) {
            $previousDataDirectory = $dataArgument.Groups[1].Value
            if (-not $previousDataDirectory) { $previousDataDirectory = $dataArgument.Groups[2].Value }
            $defaultDataDirectory = Join-Path $env:LOCALAPPDATA 'MediaPipes'
            if ([IO.Path]::GetFullPath($previousDataDirectory) -ne [IO.Path]::GetFullPath($defaultDataDirectory) -and
                -not $queueService[0].command.Replace('/', '\').Contains($previousDataDirectory.Replace('/', '\'))) {
                throw 'The Inference command does not preserve the existing custom --data-dir; no startup changes made.'
            }
        }
    }
    if ($taskStatus -eq 'legacy' -and @($services | Where-Object { $_.key -eq $PredictService }).Count -ne 1) {
        throw "Unknown DevHub service $PredictService; no startup changes made."
    }
    $backupRoot = Join-Path $root '.state\startup-backup'
    $backupDirectory = Join-Path $backupRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $backup = [ordered]@{
        Schema = 1; RegistryName = 'Inference'; Registry = $registry
        RegistryChanged = ($registryStatus -eq 'legacy'); NewRegistryValue = $newRegistryValue
        TaskName = $devhubPredictTaskName; TaskPath = '\'; TaskChanged = ($taskStatus -eq 'legacy')
        NewTaskArguments = $newTaskArguments
    }
    if ($taskStatus -eq 'legacy') {
        Export-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' | Set-Content -LiteralPath (Join-Path $backupDirectory 'predict-paper-runtime.xml') -Encoding Unicode
    }
    if ($registryStatus -eq 'legacy') {
        if ($registry.Kind -ne 'String') { throw 'Inference startup is not a REG_SZ value; no startup changes made.' }
        $escapedValue = $registry.Value.Replace('\', '\\').Replace('"', '\"')
        @('Windows Registry Editor Version 5.00', '', '[HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run]', ('"Inference"="' + $escapedValue + '"'), '') | Set-Content -LiteralPath (Join-Path $backupDirectory 'Inference.reg') -Encoding Unicode
    }
    $backup | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupDirectory 'backup.json') -Encoding UTF8
    $wrapperDirectory = Join-Path $root '.state\startup'
    New-Item -ItemType Directory -Path $wrapperDirectory -Force | Out-Null
    if ($registryStatus -eq 'legacy') {
        Get-DevHubStartupWrapper -Bun $bun -Root $root -Service $InferenceService | Set-Content -LiteralPath $inferenceWrapper -Encoding UTF8
    }
    if ($taskStatus -eq 'legacy') {
        Get-DevHubStartupWrapper -Bun $bun -Root $root -Service $PredictService | Set-Content -LiteralPath $predictWrapper -Encoding UTF8
    }
    $registryApplied = $false
    try {
        if ($registryStatus -eq 'legacy') {
            Set-ItemProperty -LiteralPath $devhubRunKey -Name 'Inference' -Value $newRegistryValue
            $registryApplied = $true
        }
        if ($taskStatus -eq 'legacy') {
            $action = New-ScheduledTaskAction -Execute $powerShell -Argument $newTaskArguments -WorkingDirectory $root
            Set-ScheduledTask -TaskName $devhubPredictTaskName -TaskPath '\' -Action $action | Out-Null
        }
    } catch {
        if ($registryApplied) {
            Set-ItemProperty -LiteralPath $devhubRunKey -Name 'Inference' -Value $registry.Value
        }
        throw
    }
    [pscustomobject]@{ Mode = 'applied'; Backup = $backupDirectory; RunningProcessesChanged = $false; ProductionWorkersChanged = $false }
}

# Dot-sourcing loads the pure classifiers and wrapper builder for offline tests.
if ($MyInvocation.InvocationName -ne '.') { Invoke-DevHubStartupMigration }
