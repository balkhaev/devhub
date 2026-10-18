param(
    [Parameter(Mandatory=$true)][string]$Marker,
    [Parameter(Mandatory=$true)][string]$Batch,
    [Parameter(Mandatory=$true)][string]$Intent,
    [Parameter(Mandatory=$true)][string]$Receipt,
    [Parameter(Mandatory=$true)][string]$Approval
)

# The desktop owns CMD. This short-lived child only identifies that CMD and waits
# for DevHub to persist ownership before permitting the service command to run.
$ErrorActionPreference = 'Stop'
try {
    $wanted = Get-Content -LiteralPath $Intent -Raw | ConvertFrom-Json
    if ($wanted.marker -ne $Marker -or $wanted.state -ne 'pending') { exit 125 }
    $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $launcher = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.ParentProcessId)"
    if (-not $launcher -or $launcher.Name -ine 'cmd.exe') { exit 125 }
    $value = [ordered]@{
        marker = $Marker
        batch = $Batch
        pid = [int]$launcher.ProcessId
        parent = [int]$launcher.ParentProcessId
        created = $launcher.CreationDate.ToUniversalTime().Ticks.ToString()
        command = [string]$launcher.CommandLine
    }
    $temporary = "$Receipt.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Receipt
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 20000) {
        $wanted = Get-Content -LiteralPath $Intent -Raw | ConvertFrom-Json
        if ($wanted.marker -ne $Marker -or $wanted.state -eq 'cancelled') { exit 125 }
        if ($wanted.state -eq 'approved' -and (Test-Path -LiteralPath $Approval)) {
            if ([IO.File]::ReadAllText($Approval) -eq $Marker) { exit 0 }
        }
        Start-Sleep -Milliseconds 50
    }
    exit 125
} catch {
    # No receipt or approval means no service, including a delayed ShellExecute.
    exit 125
}
