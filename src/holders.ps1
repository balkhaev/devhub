# Every process with its parent, start time, executable and current folder, and the processes
# that keep the asked files open. The request is base64 of UTF-8 JSON { files: string[] } in
# DEVHUB_HOLDERS_REQUEST; the answer is one line of UTF-8 JSON. Read by src/holders.ts.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DevHubHolders
{
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RmUniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RmProcessInfo
    {
        public RmUniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int kind, ref ProcessBasicInformation info, int size, out int returned);

    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
    static extern int NtQueryWow64Peb(IntPtr process, int kind, ref IntPtr peb, int size, out int returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint session, int flags, StringBuilder key);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint session);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint session, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, string[] services);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] RmProcessInfo[] apps, ref uint reasons);

    const int QueryInformation = 0x0400;
    const int VmRead = 0x0010;
    const int MoreData = 234;

    static byte[] Read(IntPtr process, IntPtr address, int size)
    {
        if (address == IntPtr.Zero || size <= 0) { return null; }
        byte[] buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, new IntPtr(size), out read) || read.ToInt64() != size) { return null; }
        return buffer;
    }

    // The folder a process works in: RTL_USER_PROCESS_PARAMETERS.CurrentDirectory in its PEB.
    // A 32-bit process keeps its own PEB with 32-bit offsets.
    public static string CurrentDirectory(int pid)
    {
        if (IntPtr.Size != 8) { return null; }
        IntPtr process = OpenProcess(QueryInformation | VmRead, false, pid);
        if (process == IntPtr.Zero) { return null; }
        try
        {
            int returned;
            IntPtr peb32 = IntPtr.Zero;
            byte[] text;
            if (NtQueryWow64Peb(process, 26, ref peb32, IntPtr.Size, out returned) == 0 && peb32 != IntPtr.Zero)
            {
                byte[] pointer = Read(process, IntPtr.Add(peb32, 0x10), 4);
                if (pointer == null) { return null; }
                byte[] path = Read(process, new IntPtr(BitConverter.ToUInt32(pointer, 0) + 0x24), 8);
                if (path == null) { return null; }
                text = Read(process, new IntPtr(BitConverter.ToUInt32(path, 4)), BitConverter.ToUInt16(path, 0));
            }
            else
            {
                ProcessBasicInformation info = new ProcessBasicInformation();
                if (NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(info), out returned) != 0) { return null; }
                byte[] pointer = Read(process, IntPtr.Add(info.PebBaseAddress, 0x20), 8);
                if (pointer == null) { return null; }
                byte[] path = Read(process, new IntPtr(BitConverter.ToInt64(pointer, 0) + 0x38), 16);
                if (path == null) { return null; }
                text = Read(process, new IntPtr(BitConverter.ToInt64(path, 8)), BitConverter.ToUInt16(path, 0));
            }
            return text == null ? null : Encoding.Unicode.GetString(text);
        }
        catch { return null; }
        finally { CloseHandle(process); }
    }

    // Processes that keep any of the files open, as the Restart Manager names them.
    public static int[] FileUsers(string[] files)
    {
        List<int> found = new List<int>();
        if (files == null || files.Length == 0) { return found.ToArray(); }
        uint session;
        if (RmStartSession(out session, 0, new StringBuilder(Guid.NewGuid().ToString("N"))) != 0) { return found.ToArray(); }
        try
        {
            if (RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) { return found.ToArray(); }
            uint needed = 0, count = 0, reasons = 0;
            if (RmGetList(session, out needed, ref count, null, ref reasons) != MoreData || needed == 0) { return found.ToArray(); }
            RmProcessInfo[] apps = new RmProcessInfo[needed];
            count = needed;
            if (RmGetList(session, out needed, ref count, apps, ref reasons) != 0) { return found.ToArray(); }
            for (int index = 0; index < count; index++) { found.Add(apps[index].Process.ProcessId); }
        }
        finally { RmEndSession(session); }
        return found.ToArray();
    }
}
'@
$files = @()
if ($env:DEVHUB_HOLDERS_REQUEST) {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DEVHUB_HOLDERS_REQUEST))
    $files = @(($text | ConvertFrom-Json).files | Where-Object { $_ })
}
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
        pid = [int]$_.ProcessId
        parent = [int]$_.ParentProcessId
        name = [string]$_.Name
        started = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }
        exe = $_.ExecutablePath
        cwd = [DevHubHolders]::CurrentDirectory([int]$_.ProcessId)
    }
})
[pscustomobject]@{
    fileUsers = @([DevHubHolders]::FileUsers([string[]]$files))
    processes = $processes
} | ConvertTo-Json -Depth 4 -Compress
