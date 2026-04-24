param(
    [Parameter(Mandatory=$true)][string]$Action,
    [Parameter(Mandatory=$true)][int]$ProcessId
)
$code = @"
using System;
using System.Runtime.InteropServices;
public static class PSProcess {
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, int p);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
try {
    Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
} catch {}

$handle = [PSProcess]::OpenProcess(0x0800, $false, $ProcessId)
if ($handle -ne [IntPtr]::Zero) {
    if ($Action -eq 'pause') { [PSProcess]::NtSuspendProcess($handle) | Out-Null }
    elseif ($Action -eq 'resume') { [PSProcess]::NtResumeProcess($handle) | Out-Null }
    [PSProcess]::CloseHandle($handle) | Out-Null
    exit 0
} else {
    exit 1
}
