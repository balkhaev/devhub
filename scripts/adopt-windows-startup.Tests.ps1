# Offline Pester tests: every task mutation is mocked, and the registry mocks prove it is never written.
. (Join-Path $PSScriptRoot 'adopt-windows-startup.ps1')

function New-StartupFixtureTask([string]$Script, [string]$CodeRoot = 'F:\code') {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    return [pscustomobject]@{
        Actions = @([pscustomobject]@{
            Execute = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
            Arguments = '-NoProfile -WindowStyle Minimized -EncodedCommand ' + $encoded
            WorkingDirectory = (Join-Path $CodeRoot 'predict-paper')
        })
    }
}

function New-StartupManagedTask([string]$Arguments) {
    return [pscustomobject]@{
        Actions = @([pscustomobject]@{
            Execute = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
            Arguments = $Arguments
            WorkingDirectory = 'F:\code\devhub'
        })
    }
}

# A backup as the earlier two-autostart migration wrote it: the Inference Run value beside the task.
function New-StartupSchema1Backup([string]$Directory, [string]$NewTaskArguments, [bool]$TaskChanged = $true, [int]$Schema = 1, [string]$RegistryName = 'Inference') {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    [ordered]@{
        Schema = $Schema; RegistryName = $RegistryName
        Registry = [pscustomobject]@{ Exists = $true; Value = 'F:\code\inference\.venv\Scripts\pythonw.exe -m inference.tray'; Kind = 'String' }
        RegistryChanged = $true; NewRegistryValue = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -File "F:\code\devhub\.state\startup\inference.ps1"'
        TaskName = 'predict-paper-runtime'; TaskPath = '\'; TaskChanged = $TaskChanged
        NewTaskArguments = $NewTaskArguments
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Directory 'backup.json') -Encoding UTF8
    @(
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>original fixture action</Arguments><WorkingDirectory>D:\fixture</WorkingDirectory></Exec></Actions>',
        '</Task>'
    ) | Set-Content -LiteralPath (Join-Path $Directory 'predict-paper-runtime.xml') -Encoding Unicode
}

Describe 'Apply backups and recovery' {
    BeforeEach {
        $script:Apply = $true
        $script:Restore = $null
        $script:devhubStartupRoot = Join-Path $TestDrive ([Guid]::NewGuid().ToString('N') + '\devhub')
        New-Item -ItemType Directory -Path (Join-Path $script:devhubStartupRoot 'src') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:devhubStartupRoot 'src\cli.ts') -Value '// fixture'
        Mock Get-ScheduledTask {
            $codeDirectory = Split-Path -Parent $script:devhubStartupRoot
            New-StartupFixtureTask (Get-DevHubPredictLegacyScript $codeDirectory) $codeDirectory
        }
        Mock Get-Command { [pscustomobject]@{ Source = 'C:\fixture\bun.exe' } } -ParameterFilter { $Name -eq 'bun' }
        Mock Get-DevHubStartupServices { @([pscustomobject]@{key='inference/queue';command='.venv/Scripts/python.exe -m inference.cli serve'}, [pscustomobject]@{key='predict/runtime';command='.venv/Scripts/python.exe -m predict.runtime'}) }
        Mock Export-ScheduledTask { '<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>original fixture action</Arguments><WorkingDirectory>D:\fixture</WorkingDirectory></Exec></Actions></Task>' }
        Mock Set-ItemProperty {}
        Mock New-ItemProperty {}
        Mock Set-ScheduledTask {}
        Mock Write-Warning {}
    }

    It 'exports the original task and changes only its launch action' {
        $result = Invoke-DevHubStartupMigration
        $result.Mode | Should Be 'applied'
        (Test-Path -LiteralPath (Join-Path $result.Backup 'predict-paper-runtime.xml')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $result.Backup 'Inference.reg')) | Should Be $false
        $backup = Get-Content -LiteralPath (Join-Path $result.Backup 'backup.json') -Raw | ConvertFrom-Json
        $backup.Schema | Should Be 2
        $backup.TaskName | Should Be 'predict-paper-runtime'
        @($backup.PSObject.Properties.Name -match 'Registry').Count | Should Be 0
        (Get-Content -LiteralPath (Join-Path $script:devhubStartupRoot '.state\startup\predict-paper.ps1') -Raw) | Should Match "'predict/runtime'"
        (Test-Path -LiteralPath (Join-Path $script:devhubStartupRoot '.state\startup\inference.ps1')) | Should Be $false
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 1 -Exactly -ParameterFilter { $TaskName -eq 'predict-paper-runtime' -and $TaskPath -eq '\' }
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
    }

    It 'refuses an unknown Predict service before backing up or changing the task' {
        Mock Get-DevHubStartupServices { @([pscustomobject]@{key='inference/queue';command='.venv/Scripts/python.exe -m inference.cli serve'}) }
        { Invoke-DevHubStartupMigration } | Should Throw 'Unknown DevHub service predict/runtime'
        (Test-Path -LiteralPath (Join-Path $script:devhubStartupRoot '.state')) | Should Be $false
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }

    It 'restores the task from its own backup' {
        $result = Invoke-DevHubStartupMigration
        $backup = Get-Content -LiteralPath (Join-Path $result.Backup 'backup.json') -Raw | ConvertFrom-Json
        $script:managedArguments = $backup.NewTaskArguments
        Mock Get-ScheduledTask { New-StartupManagedTask $script:managedArguments }
        $restored = Restore-DevHubStartup -Directory $result.Backup -Commit
        $restored.Mode | Should Be 'restored'
        $restored.TaskRestored | Should Be $true
        $restored.InferenceRunValue | Should Be 'not in this backup'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 2 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 1 -Exactly -ParameterFilter { $Action[0].Arguments -eq 'original fixture action' }
        Assert-MockCalled Write-Warning -Scope It -Times 0 -Exactly
    }

    It 'does not overwrite a newer task action during restore' {
        $result = Invoke-DevHubStartupMigration
        Mock Get-ScheduledTask { New-StartupManagedTask '-File newer.ps1' }
        { Restore-DevHubStartup -Directory $result.Backup -Commit } | Should Throw 'Predict startup changed after migration'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 1 -Exactly
    }
}

Describe 'Restore from a schema-1 backup' {
    BeforeEach {
        $script:Apply = $false
        $script:Restore = $null
        $script:backupDirectory = Join-Path $TestDrive ([Guid]::NewGuid().ToString('N'))
        $script:managedArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "F:\code\devhub\.state\startup\predict-paper.ps1"'
        Mock Get-ScheduledTask { New-StartupManagedTask $script:managedArguments }
        Mock Set-ItemProperty {}
        Mock New-ItemProperty {}
        Mock Set-ScheduledTask {}
        Mock Write-Warning {}
    }

    It 'restores the Predict task and never writes the Inference Run value back' {
        New-StartupSchema1Backup $script:backupDirectory $script:managedArguments
        $script:Restore = $script:backupDirectory
        $script:Apply = $true
        $result = Invoke-DevHubStartupMigration
        $result.Mode | Should Be 'restored'
        $result.TaskRestored | Should Be $true
        $result.InferenceRunValue | Should Be 'not restored'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 1 -Exactly -ParameterFilter {
            $TaskName -eq 'predict-paper-runtime' -and $Action[0].Execute -eq 'powershell.exe' -and
            $Action[0].Arguments -eq 'original fixture action' -and $Action[0].WorkingDirectory -eq 'D:\fixture'
        }
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Write-Warning -Scope It -Times 1 -Exactly -ParameterFilter { $Message -match 'Inference Run value .* is not restored' -and $Message -match 'inference/queue' }
    }

    It 'says so in a dry-run and changes nothing' {
        New-StartupSchema1Backup $script:backupDirectory $script:managedArguments
        $script:Restore = $script:backupDirectory
        $result = Invoke-DevHubStartupMigration
        $result.Mode | Should Be 'restore-dry-run'
        $result.TaskChanged | Should Be $true
        $result.InferenceRunValue | Should Be 'not restored'
        Assert-MockCalled Write-Warning -Scope It -Times 1 -Exactly -ParameterFilter { $Message -match 'is not restored' }
        Assert-MockCalled Get-ScheduledTask -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
    }

    It 'leaves the task alone when the backup changed only the Inference Run value' {
        New-StartupSchema1Backup $script:backupDirectory $script:managedArguments $false
        $result = Restore-DevHubStartup -Directory $script:backupDirectory -Commit
        $result.TaskRestored | Should Be $false
        $result.InferenceRunValue | Should Be 'not restored'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
    }

    It 'still refuses to overwrite a newer task action' {
        New-StartupSchema1Backup $script:backupDirectory '-File "F:\code\devhub\.state\startup\predict-paper.ps1"'
        { Restore-DevHubStartup -Directory $script:backupDirectory -Commit } | Should Throw 'Predict startup changed after migration'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }

    It 'rejects a manifest that is neither backup schema' {
        New-StartupSchema1Backup $script:backupDirectory $script:managedArguments $true 3
        { Restore-DevHubStartup -Directory $script:backupDirectory -Commit } | Should Throw 'not a supported DevHub startup backup'
        New-StartupSchema1Backup $script:backupDirectory $script:managedArguments $true 1 'Other'
        { Restore-DevHubStartup -Directory $script:backupDirectory -Commit } | Should Throw 'not a supported DevHub startup backup'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }
}

Describe 'Known Windows startup classification' {
    It 'recognizes the exact paper runtime supervisor' {
        $task = New-StartupFixtureTask (Get-DevHubPredictLegacyScript 'F:\code')
        (Test-DevHubPredictStartup $task 'F:\code' 'F:\code\devhub') | Should Be 'legacy'
    }

    It 'rejects a changed encoded script and another working directory' {
        $task = New-StartupFixtureTask ((Get-DevHubPredictLegacyScript 'F:\code') + "`nWrite-Host 'other action'")
        (Test-DevHubPredictStartup $task 'F:\code' 'F:\code\devhub') | Should Be 'unrecognized'
        $task = New-StartupFixtureTask (Get-DevHubPredictLegacyScript 'F:\code')
        $task.Actions[0].WorkingDirectory = 'D:\elsewhere'
        (Test-DevHubPredictStartup $task 'F:\code' 'F:\code\devhub') | Should Be 'unrecognized'
    }

    It 'recognizes the task already routed through its wrapper' {
        $task = New-StartupManagedTask '-NoProfile -File "F:\code\devhub\.state\startup\predict-paper.ps1"'
        (Test-DevHubPredictStartup $task 'F:\code' 'F:\code\devhub') | Should Be 'managed'
    }

    It 'quotes paths literally and rejects executable service fragments' {
        $wrapper = Get-DevHubStartupWrapper "C:\a'b\bun.exe" "D:\space root\devhub" 'predict/runtime'
        $wrapper | Should Match "a''b"
        $wrapper | Should Match "'D:\\space root\\devhub\\src\\cli\.ts' start 'predict/runtime'"
        { Get-DevHubStartupWrapper 'bun.exe' 'F:\code\devhub' 'predict/runtime;other' } | Should Throw
    }

    It 'starts every service by its key, with no project special case' {
        $wrapper = Get-DevHubStartupWrapper 'bun.exe' 'F:\code\devhub' 'inference/queue'
        $wrapper | Should Match "start 'inference/queue'"
        $wrapper | Should Not Match '\-\-project'
    }
}

Describe 'Startup migration write boundaries' {
    BeforeEach {
        $script:Apply = $false
        $script:Restore = $null
        $script:devhubStartupRoot = 'F:\code\devhub'
        Mock Get-ScheduledTask { New-StartupFixtureTask (Get-DevHubPredictLegacyScript 'F:\code') }
        Mock Set-ItemProperty {}
        Mock New-ItemProperty {}
        Mock Set-ScheduledTask {}
        Mock Get-DevHubStartupServices { throw 'Dry-run must not invoke Bun or the hub.' }
    }

    It 'dry-run plans only the Predict task and neither changes autostart nor starts the hub' {
        $plan = Invoke-DevHubStartupMigration
        $plan.Mode | Should Be 'dry-run'
        $plan.Predict.Status | Should Be 'legacy'
        (@($plan.PSObject.Properties.Name) -contains 'Inference') | Should Be $false
        $plan.RunningProcessesChanged | Should Be $false
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
        Assert-MockCalled Get-DevHubStartupServices -Scope It -Times 0 -Exactly
    }

    It 'plans a hidden PowerShell launch action for the task' {
        $arguments = (Invoke-DevHubStartupMigration).Predict.NewArguments
        $arguments | Should Match '\-WindowStyle Hidden'
        $arguments | Should Match '\-NonInteractive'
        $arguments | Should Match '\-File "F:\\code\\devhub\\\.state\\startup\\predict-paper\.ps1"'
    }

    It 'refuses an unclassified startup before making changes' {
        $script:Apply = $true
        Mock Get-ScheduledTask { New-StartupManagedTask '-File other.ps1' }
        { Invoke-DevHubStartupMigration } | Should Throw 'no longer matches the classified legacy startup'
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }

    It 'changes nothing when the task already runs through DevHub' {
        $script:Apply = $true
        Mock Get-ScheduledTask { New-StartupManagedTask '-NoProfile -File "F:\code\devhub\.state\startup\predict-paper.ps1"' }
        $plan = Invoke-DevHubStartupMigration
        $plan.Mode | Should Be 'apply'
        $plan.Predict.Status | Should Be 'managed'
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
        Assert-MockCalled Get-DevHubStartupServices -Scope It -Times 0 -Exactly
    }

    It 'refuses a missing CLI before changing the task' {
        $script:Apply = $true
        Mock Test-Path { $false } -ParameterFilter { $LiteralPath -like '*src\cli.ts' }
        { Invoke-DevHubStartupMigration } | Should Throw 'DevHub CLI is missing'
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }
}
