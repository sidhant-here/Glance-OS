# telemetry.ps1 — Uses Get-Counter (PDH API) for accurate CPU matching Task Manager
$ProgressPreference = 'SilentlyContinue'
$totalMemKB = (Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize).TotalVisibleMemorySize
$logicalCores = (Get-CimInstance Win32_Processor).NumberOfLogicalProcessors

$stdout = [Console]::OpenStandardOutput()
$writer = New-Object System.IO.StreamWriter($stdout, (New-Object System.Text.UTF8Encoding $false))

# Build counter paths — single Get-Counter call fetches everything
$counterPaths = @(
    '\Processor Information(_Total)\% Processor Utility'
    '\Memory\Available KBytes'
    '\PhysicalDisk(_Total)\% Idle Time'
    '\PhysicalDisk(_Total)\Disk Read Bytes/sec'
    '\PhysicalDisk(_Total)\Disk Write Bytes/sec'
)
for ($i = 0; $i -lt $logicalCores; $i++) {
    $counterPaths += "\Processor Information(0,$i)\% Processor Utility"
}

# Stream samples every 1 second using PDH API (same engine as Task Manager)
Get-Counter -Counter $counterPaths -SampleInterval 1 -Continuous | ForEach-Object {
    try {
        $samples = $_.CounterSamples

        # CPU total (cap at 100 — turbo boost can push Utility above 100)
        $cpuRaw = ($samples | Where-Object { $_.Path -like '*_total*processor utility*' }).CookedValue
        $cpuVal = [math]::Round([math]::Min(100.0, [math]::Max(0.0, $cpuRaw)), 1)

        # Memory
        $availKB  = ($samples | Where-Object { $_.Path -like '*available kbytes*' }).CookedValue
        $totalMem = [double]$totalMemKB * 1024.0
        $freeMem  = $availKB * 1024.0
        $usedMem  = $totalMem - $freeMem

        # Disk
        $diskIdleVal = ($samples | Where-Object { $_.Path -like '*idle time*' }).CookedValue
        $diskActive  = [math]::Round([math]::Min(100.0, [math]::Max(0.0, 100.0 - $diskIdleVal)), 1)
        $diskRd      = ($samples | Where-Object { $_.Path -like '*read bytes*' }).CookedValue
        $diskWr      = ($samples | Where-Object { $_.Path -like '*write bytes*' }).CookedValue

        # Per-core CPU
        $perCoreList = @()
        for ($i = 0; $i -lt $logicalCores; $i++) {
            $coreRaw = ($samples | Where-Object { $_.InstanceName -eq "0,$i" }).CookedValue
            $coreVal = [math]::Round([math]::Min(100.0, [math]::Max(0.0, $coreRaw)), 1)
            $perCoreList += @{ core = $i; load = $coreVal }
        }

        $data = @{
            cpu         = $cpuVal
            disk_active = $diskActive
            disk_read   = $diskRd
            disk_write  = $diskWr
            mem_total   = $totalMem
            mem_used    = $usedMem
            mem_free    = $freeMem
            per_core    = $perCoreList
        }

        $writer.WriteLine(($data | ConvertTo-Json -Compress -Depth 5))
        $writer.Flush()
    } catch { }
}
