# telemetry.ps1 — Native Windows metrics streamer
# Uses EXACT same counter as Task Manager: % Processor Utility
# This accounts for CPU frequency scaling (turbo boost / power throttling)
# Outputs one JSON line every ~500ms

$ProgressPreference = 'SilentlyContinue'

# Pre-fetch memory info once (total doesn't change)
$os = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize
$totalMemKB = $os.TotalVisibleMemorySize

# Detect if % Processor Utility is available (Windows 10 1709+)
$useUtility = $true
try {
    $test = (Get-Counter '\Processor Information(_Total)\% Processor Utility' -ErrorAction Stop).CounterSamples
}
catch {
    $useUtility = $false
}

while ($true) {
    try {
        # ── Build counter list ──
        # Use % Processor Utility (same as Task Manager) when available,
        # fall back to % Processor Time on older Windows
        $cpuCounter = if ($useUtility) {
            '\Processor Information(_Total)\% Processor Utility'
        }
        else {
            '\Processor(_Total)\% Processor Time'
        }

        $counters = @(
            $cpuCounter,
            '\PhysicalDisk(_Total)\% Idle Time',
            '\PhysicalDisk(_Total)\Disk Read Bytes/sec',
            '\PhysicalDisk(_Total)\Disk Write Bytes/sec',
            '\Memory\Available KBytes'
        )
        $samples = (Get-Counter -Counter $counters -ErrorAction SilentlyContinue).CounterSamples

        # ── Parse counter values ──
        $cpuValue = 0.0
        $availMemKB = 0.0
        $diskIdleTime = 100.0
        $diskReadBytes = 0.0
        $diskWriteBytes = 0.0

        if ($null -ne $samples) {
            foreach ($s in $samples) {
                if ($null -eq $s -or $null -eq $s.CookedValue) { continue }
                $path = $s.Path.ToLower()
                if ($path -like '*processor utility*' -or $path -like '*processor time*') {
                    # Cap at 100 (Utility counter can exceed 100 during turbo boost)
                    $cpuValue = [math]::Round([math]::Min(100.0, [math]::Max(0.0, [double]$s.CookedValue)), 1)
                }
                elseif ($path -like '*idle time*') {
                    $diskIdleTime = [double]$s.CookedValue
                }
                elseif ($path -like '*read bytes*') {
                    $diskReadBytes = [double]$s.CookedValue
                }
                elseif ($path -like '*write bytes*') {
                    $diskWriteBytes = [double]$s.CookedValue
                }
                elseif ($path -like '*available kbytes*') {
                    $availMemKB = [double]$s.CookedValue
                }
            }
        }

        # ── Memory from performance counter (fast, no WMI lag) ──
        $totalMem = [double]$totalMemKB * 1024.0
        $freeMem = $availMemKB * 1024.0
        $usedMem = $totalMem - $freeMem

        # ── Per-Core CPU via Processor Information (frequency-aware) ──
        $perCoreList = @()
        try {
            $coreCounterName = if ($useUtility) {
                '\Processor Information(*)\% Processor Utility'
            }
            else {
                '\Processor(*)\% Processor Time'
            }
            $coreSamples = (Get-Counter $coreCounterName -ErrorAction SilentlyContinue).CounterSamples
            if ($null -ne $coreSamples) {
                foreach ($cs in $coreSamples) {
                    if ($null -eq $cs -or $null -eq $cs.CookedValue) { continue }
                    if ($cs.InstanceName -notlike '*total*') {
                        # Extract core number from instance name
                        $coreNumStr = $cs.InstanceName
                        if ($coreNumStr -like '*,*') {
                            $coreNumStr = ($coreNumStr -split ',')[1]
                        }
                        if ([int]::TryParse($coreNumStr, [ref]$null)) {
                            $load = [math]::Round([math]::Min(100.0, [math]::Max(0.0, [double]$cs.CookedValue)), 1)
                            $perCoreList += @{ core = [int]$coreNumStr; load = $load }
                        }
                    }
                }
            }
        }
        catch { }

        # ── Disk Active Time ──
        $diskActive = 100.0 - $diskIdleTime
        if ($diskActive -lt 0) { $diskActive = 0.0 }
        if ($diskActive -gt 100) { $diskActive = 100.0 }
        $diskActive = [math]::Round($diskActive, 1)

        $data = @{
            cpu = $cpuValue
            disk_active = $diskActive
            disk_read = $diskReadBytes
            disk_write = $diskWriteBytes
            mem_total = $totalMem
            mem_used = $usedMem
            mem_free = $freeMem
            per_core = $perCoreList
        }
        
        $json = $data | ConvertTo-Json -Compress -Depth 5
        
        $stdout = [Console]::OpenStandardOutput()
        $writer = New-Object System.IO.StreamWriter($stdout, [Text.Encoding]::UTF8)
        $writer.WriteLine($json)
        $writer.Flush()
    }
    catch {
        # ignore
    }
    Start-Sleep -Milliseconds 500
}
