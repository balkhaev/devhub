# Offline Pester tests: every registry/task mutation is mocked.
. (Join-Path $PSScriptRoot 'adopt-windows-startup.ps1')

function New-StartupFixtureTask([string]$Script, [string]$CodeRoot = 'D:\code') {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    return [pscustomobject]@{
        Actions = @([pscustomobject]@{
            Execute = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
            Arguments = '-NoProfile -WindowStyle Minimized -EncodedCommand ' + $encoded
            WorkingDirectory = (Join-Path $CodeRoot 'predict-paper')
        })
    }
}

Describe 'Apply backups and recovery' {
    BeforeEach {
        $script:Apply = $true
        $script:Restore = $null
        $script:InferenceTrayWorkersPreserved = $false
        $script:devhubStartupRoot = Join-Path $TestDrive ([Guid]::NewGuid().ToString('N') + '\devhub')
        New-Item -ItemType Directory -Path (Join-Path $script:devhubStartupRoot 'src') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:devhubStartupRoot 'src\cli.ts') -Value '// fixture'
        Mock Get-DevHubStartupRegistry { [pscustomobject]@{ Exists = $true; Value = 'D:\code\inference\.venv\Scripts\pythonw.exe -m inference.tray'; Kind = 'String' } }
        Mock Get-ScheduledTask {
            $codeDirectory = Split-Path -Parent $script:devhubStartupRoot
            New-StartupFixtureTask (Get-DevHubPredictLegacyScript $codeDirectory) $codeDirectory
        }
        Mock Get-Command { [pscustomobject]@{ Source = 'C:\fixture\bun.exe' } } -ParameterFilter { $Name -eq 'bun' }
        Mock Get-DevHubStartupServices { @([pscustomobject]@{key='inference/queue';command='.venv/Scripts/python.exe -m inference.tray'}, [pscustomobject]@{key='predict/runtime';command='.venv/Scripts/python.exe -m predict.runtime'}) }
        Mock Export-ScheduledTask { '<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>original fixture action</Arguments><WorkingDirectory>D:\fixture</WorkingDirectory></Exec></Actions></Task>' }
        Mock Set-ItemProperty {}
        Mock New-ItemProperty {}
        Mock Set-ScheduledTask {}
    }

    It 'exports both originals and changes only the two allowed launch actions' {
        $result = Invoke-DevHubStartupMigration
        $result.Mode | Should Be 'applied'
        (Test-Path -LiteralPath (Join-Path $result.Backup 'Inference.reg')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $result.Backup 'predict-paper-runtime.xml')) | Should Be $true
        $backup = Get-Content -LiteralPath (Join-Path $result.Backup 'backup.json') -Raw | ConvertFrom-Json
        $backup.Registry.Value | Should Match 'inference\.tray'
        (Get-Content -LiteralPath (Join-Path $script:devhubStartupRoot '.state\startup\inference.ps1') -Raw) | Should Match '\-\-project.*inference.*\-\-script dev'
        (Get-Content -LiteralPath (Join-Path $script:devhubStartupRoot '.state\startup\predict-paper.ps1') -Raw) | Should Match "'predict/runtime'"
        Assert-MockCalled Set-ItemProperty -Scope It -Times 1 -Exactly -ParameterFilter { $Name -eq 'Inference' }
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 1 -Exactly -ParameterFilter { $TaskName -eq 'predict-paper-runtime' -and $TaskPath -eq '\' }
    }

    It 'refuses a queue command that would drop the paired tray workers' {
        Mock Get-DevHubStartupServices { @([pscustomobject]@{key='inference/queue';command='uv run inference serve'}, [pscustomobject]@{key='predict/runtime';command='python -m predict.runtime'}) }
        { Invoke-DevHubStartupMigration } | Should Throw
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }

    It 'restores the registry when updating the task fails' {
        Mock Set-ScheduledTask { throw 'fixture scheduler failure' }
        { Invoke-DevHubStartupMigration } | Should Throw
        Assert-MockCalled Set-ItemProperty -Scope It -Times 2 -Exactly
        Assert-MockCalled Set-ItemProperty -Scope It -Times 1 -Exactly -ParameterFilter { $Value -eq 'D:\code\inference\.venv\Scripts\pythonw.exe -m inference.tray' }
    }

    It 'does not overwrite a newer registry value during restore' {
        $result = Invoke-DevHubStartupMigration
        Mock Get-DevHubStartupRegistry { [pscustomobject]@{ Exists=$true; Value='newer.exe'; Kind='String' } }
        { Restore-DevHubStartup -Directory $result.Backup -Commit } | Should Throw
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 1 -Exactly
    }
}

Describe 'Known Windows startup classification' {
    It 'recognizes the queue tray and rejects chained commands' {
        $known = 'D:\code\inference\.venv\Scripts\pythonw.exe -m inference.tray --data-dir C:\Users\fixture\AppData\Local\MediaPipes'
        (Test-DevHubInferenceStartup $known 'D:\code\devhub') | Should Be 'legacy'
        (Test-DevHubInferenceStartup ($known + ' & other.exe') 'D:\code\devhub') | Should Be 'unrecognized'
    }

    It 'recognizes the exact paper runtime supervisor' {
        $task = New-StartupFixtureTask (Get-DevHubPredictLegacyScript 'D:\code')
        (Test-DevHubPredictStartup $task 'D:\code' 'D:\code\devhub') | Should Be 'legacy'
    }

    It 'rejects a changed encoded script and another working directory' {
        $task = New-StartupFixtureTask ((Get-DevHubPredictLegacyScript 'D:\code') + "`nWrite-Host 'other action'")
        (Test-DevHubPredictStartup $task 'D:\code' 'D:\code\devhub') | Should Be 'unrecognized'
        $task = New-StartupFixtureTask (Get-DevHubPredictLegacyScript 'D:\code')
        $task.Actions[0].WorkingDirectory = 'D:\elsewhere'
        (Test-DevHubPredictStartup $task 'D:\code' 'D:\code\devhub') | Should Be 'unrecognized'
    }

    It 'quotes paths literally and rejects executable service fragments' {
        $wrapper = Get-DevHubStartupWrapper "C:\a'b\bun.exe" "D:\space root\devhub" 'inference/queue'
        $wrapper | Should Match "a''b"
        $wrapper | Should Match "\-\-project 'D:\\space root\\inference' \-\-script dev"
        $wrapper | Should Not Match "start 'inference/queue'"
        { Get-DevHubStartupWrapper 'bun.exe' 'D:\code\devhub' 'inference/queue;other' } | Should Throw
    }

    It 'starts the complete Inference default group from its canonical project' {
        $wrapper = Get-DevHubStartupWrapper 'bun.exe' 'D:\code\devhub' 'inference/queue'
        $wrapper | Should Match "start \-\-project 'D:\\code\\inference' \-\-script dev"
        $wrapper | Should Not Match '\-\-accept'
        $wrapper | Should Not Match 'inference\.tray'
    }

    It 'preserves service routing for other startup targets' {
        $wrapper = Get-DevHubStartupWrapper 'bun.exe' 'D:\code\devhub' 'predict/runtime'
        $wrapper | Should Match "start 'predict/runtime'"
        $wrapper | Should Not Match '\-\-project'
    }

    It 'uses a hidden PowerShell launch action' {
        $command = Get-DevHubStartupCommand 'C:\Windows\powershell.exe' 'D:\space root\inference.ps1'
        $command | Should Match '\-WindowStyle Hidden'
        $command | Should Match '\-NonInteractive'
        $command | Should Match '\-File "D:\\space root\\inference.ps1"'
    }
}

Describe 'Startup migration write boundaries' {
    BeforeEach {
        $script:Apply = $false
        $script:Restore = $null
        $script:InferenceTrayWorkersPreserved = $false
        $script:devhubStartupRoot = 'D:\code\devhub'
        Mock Get-DevHubStartupRegistry { [pscustomobject]@{ Exists = $true; Value = 'D:\code\inference\.venv\Scripts\pythonw.exe -m inference.tray'; Kind = 'String' } }
        Mock Get-ScheduledTask { New-StartupFixtureTask (Get-DevHubPredictLegacyScript 'D:\code') }
        Mock Set-ItemProperty {}
        Mock New-ItemProperty {}
        Mock Set-ScheduledTask {}
        Mock Get-DevHubStartupServices { throw 'Dry-run must not invoke Bun or the hub.' }
    }

    It 'dry-run neither changes autostart nor starts the hub' {
        $plan = Invoke-DevHubStartupMigration
        $plan.Mode | Should Be 'dry-run'
        $plan.Inference.Status | Should Be 'legacy'
        $plan.Predict.Status | Should Be 'legacy'
        $plan.RunningProcessesChanged | Should Be $false
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled New-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
        Assert-MockCalled Get-DevHubStartupServices -Scope It -Times 0 -Exactly
    }

    It 'refuses an unclassified startup before making changes' {
        $script:Apply = $true
        Mock Get-DevHubStartupRegistry { [pscustomobject]@{ Exists = $true; Value = 'other.exe'; Kind = 'String' } }
        { Invoke-DevHubStartupMigration } | Should Throw
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }

    It 'refuses a missing CLI before changing the registry or task' {
        $script:Apply = $true
        Mock Test-Path { $false } -ParameterFilter { $LiteralPath -like '*src\cli.ts' }
        { Invoke-DevHubStartupMigration } | Should Throw
        Assert-MockCalled Set-ItemProperty -Scope It -Times 0 -Exactly
        Assert-MockCalled Set-ScheduledTask -Scope It -Times 0 -Exactly
    }
}

