# GPU Scheduler bridge - resident counter sampler (Windows PowerShell 5.1)
# Protocol (line based, UTF-8, one JSON per line):
#   stdout line 1                          : {"type":"hello", ok, psPid, displayPaths, dxgiAdapters, counters, initError, version}
#   stdin  "tick"  -> stdout one sample    : {"v":1,"ts":...,"adapters":[...],"processes":[...],"engines":[...],"procs":[...],"ms":...}
#   stdin  "q"     -> exit
# stdin EOF (parent died / pipe closed) -> exit.  No timers: the parent drives the cadence.
# NOTE: this file is copied to <dataDir>\ps\ at runtime with a UTF-8 BOM (PS 5.1 needs the BOM).
param([switch]$Once)
$ErrorActionPreference = 'Stop'
$ScriptVersion = '1.0.0'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class GpuSampler
{
    const uint PDH_FMT_DOUBLE = 0x00000200;
    const uint PDH_FMT_NOCAP100 = 0x00008000;
    const int PDH_MORE_DATA = unchecked((int)0x800007D2);

    [StructLayout(LayoutKind.Sequential)]
    struct PDH_FMT_COUNTERVALUE { public uint CStatus; public double doubleValue; }

    [StructLayout(LayoutKind.Sequential)]
    struct PDH_FMT_COUNTERVALUE_ITEM { public IntPtr szName; public PDH_FMT_COUNTERVALUE FmtValue; }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhOpenQueryW(string src, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhAddEnglishCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhAddCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")]
    static extern int PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")]
    static extern int PdhCloseQuery(IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhGetFormattedCounterArrayW(IntPtr counter, uint fmt, ref uint bufSize, out uint itemCount, IntPtr buffer);

    // ---------- display config ----------
    [StructLayout(LayoutKind.Sequential)]
    struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)]
    struct RATIONAL { public uint Numerator; public uint Denominator; }
    [StructLayout(LayoutKind.Sequential)]
    struct PATH_SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)]
    struct PATH_TARGET_INFO {
        public LUID adapterId; public uint id; public uint modeInfoIdx;
        public uint outputTechnology; public uint rotation; public uint scaling;
        public RATIONAL refreshRate; public uint scanLineOrdering;
        public int targetAvailable; public uint statusFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PATH_INFO { public PATH_SOURCE_INFO sourceInfo; public PATH_TARGET_INFO targetInfo; public uint flags; }
    [StructLayout(LayoutKind.Sequential)]
    struct MODE_INFO { public uint infoType; public uint id; public LUID adapterId; public ulong p0; public ulong p1; public ulong p2; public ulong p3; public ulong p4; public ulong p5; }
    [StructLayout(LayoutKind.Sequential)]
    struct DEVICE_INFO_HEADER { public uint type; public uint size; public LUID adapterId; public uint id; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ADAPTER_NAME { public DEVICE_INFO_HEADER header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string adapterDevicePath; }

    [DllImport("user32.dll")]
    static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPath, out uint numMode);
    [DllImport("user32.dll")]
    static extern int QueryDisplayConfig(uint flags, ref uint numPath, [Out] PATH_INFO[] paths, ref uint numMode, [Out] MODE_INFO[] modes, IntPtr topologyId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int DisplayConfigGetDeviceInfo(ref ADAPTER_NAME packet);

    // ---------- DXGI ----------
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DXGI_ADAPTER_DESC1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId; public uint DeviceId; public uint SubSysId; public uint Revision;
        public UIntPtr DedicatedVideoMemory; public UIntPtr DedicatedSystemMemory; public UIntPtr SharedSystemMemory;
        public LUID AdapterLuid; public uint Flags;
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int EnumAdapters1Del(IntPtr self, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetDesc1Del(IntPtr self, out DXGI_ADAPTER_DESC1 desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate uint ReleaseDel(IntPtr self);
    [DllImport("dxgi.dll")]
    static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);

    public static string AdaptersJson()
    {
        var sb = new StringBuilder();
        sb.Append('[');
        bool first = true;
        IntPtr factory = IntPtr.Zero;
        try
        {
            Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); // IDXGIFactory1
            if (CreateDXGIFactory1(ref iid, out factory) == 0 && factory != IntPtr.Zero)
            {
                IntPtr vt = Marshal.ReadIntPtr(factory);
                var enumFn = (EnumAdapters1Del)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, 12 * IntPtr.Size), typeof(EnumAdapters1Del));
                var releaseFactory = (ReleaseDel)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, 2 * IntPtr.Size), typeof(ReleaseDel));
                for (uint i = 0; i < 16; i++)
                {
                    IntPtr ad = IntPtr.Zero;
                    if (enumFn(factory, i, out ad) != 0 || ad == IntPtr.Zero) break;
                    try
                    {
                        IntPtr avt = Marshal.ReadIntPtr(ad);
                        var getDesc = (GetDesc1Del)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(avt, 10 * IntPtr.Size), typeof(GetDesc1Del));
                        DXGI_ADAPTER_DESC1 d;
                        if (getDesc(ad, out d) != 0) continue;
                        string luid = LuidString(d.AdapterLuid.LowPart, (uint)d.AdapterLuid.HighPart);
                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append("{\"luid\":").Append(J(luid));
                        sb.Append(",\"name\":").Append(J(d.Description));
                        sb.Append(",\"vendorId\":").Append(d.VendorId);
                        sb.Append(",\"deviceId\":").Append(d.DeviceId);
                        sb.Append(",\"dedicatedVideoBytes\":").Append(d.DedicatedVideoMemory.ToUInt64());
                        sb.Append(",\"dedicatedSystemBytes\":").Append(d.DedicatedSystemMemory.ToUInt64());
                        sb.Append(",\"sharedSystemBytes\":").Append(d.SharedSystemMemory.ToUInt64());
                        sb.Append(",\"flags\":").Append(d.Flags);
                        sb.Append(",\"source\":\"dxgi\"}");
                    }
                    finally
                    {
                        try
                        {
                            IntPtr avt2 = Marshal.ReadIntPtr(ad);
                            var rel = (ReleaseDel)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(avt2, 2 * IntPtr.Size), typeof(ReleaseDel));
                            if (rel != null) rel(ad);
                        }
                        catch { }
                    }
                }
                releaseFactory(factory);
            }
        }
        catch { }
        sb.Append(']');
        return sb.ToString();
    }

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    static IntPtr _query = IntPtr.Zero;
    static IntPtr[] _counters = new IntPtr[0];
    static string[] _names = new string[0];
    static string[] _paths = new string[0];
    public static string InitError = "";
    public static string[] LoadedCounters = new string[0];

    public static readonly string[] AllPaths = new string[] {
      @"\GPU Process Memory(*)\Dedicated Usage",
      @"\GPU Process Memory(*)\Shared Usage",
      @"\GPU Process Memory(*)\Non Local Usage",
      @"\GPU Process Memory(*)\Local Usage",
      @"\GPU Process Memory(*)\Total Committed",
      @"\GPU Adapter Memory(*)\Dedicated Usage",
      @"\GPU Adapter Memory(*)\Shared Usage",
      @"\GPU Adapter Memory(*)\Total Committed",
      @"\GPU Local Adapter Memory(*)\Local Usage",
      @"\GPU Non Local Adapter Memory(*)\Non Local Usage",
      @"\GPU Engine(*)\Utilization Percentage"
    };
    public static readonly string[] AllNames = new string[] {
      "proc.Dedicated","proc.Shared","proc.NonLocal","proc.Local","proc.Committed",
      "adapter.Dedicated","adapter.Shared","adapter.Committed",
      "adapterLocal.Local","adapterNonLocal.NonLocal","engine.Util"
    };

    public static bool Init()
    {
        var errs = new List<string>();
        try
        {
            if (PdhOpenQueryW(null, IntPtr.Zero, out _query) != 0 || _query == IntPtr.Zero)
            {
                InitError = "PdhOpenQuery failed";
                return false;
            }
            var cs = new List<IntPtr>();
            var ns = new List<string>();
            var ps = new List<string>();
            for (int i = 0; i < AllPaths.Length; i++)
            {
                IntPtr h = IntPtr.Zero;
                int r = PdhAddEnglishCounterW(_query, AllPaths[i], IntPtr.Zero, out h);
                if (r != 0)
                {
                    h = IntPtr.Zero;
                    r = PdhAddCounterW(_query, AllPaths[i], IntPtr.Zero, out h);
                }
                if (r == 0 && h != IntPtr.Zero) { cs.Add(h); ns.Add(AllNames[i]); ps.Add(AllPaths[i]); }
                else errs.Add(AllNames[i] + ":" + r.ToString());
            }
            _counters = cs.ToArray(); _names = ns.ToArray(); _paths = ps.ToArray();
            LoadedCounters = ps.ToArray();
            PdhCollectQueryData(_query);
            System.Threading.Thread.Sleep(60);
            PdhCollectQueryData(_query);
            if (_counters.Length == 0) { InitError = "no counters"; return false; }
            InitError = string.Join(",", errs.ToArray());
            return true;
        }
        catch (Exception ex) { InitError = ex.Message; return false; }
    }

    static string[] CollectRaw(IntPtr counter)
    {
        uint size = 0, count = 0;
        int r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ref size, out count, IntPtr.Zero);
        if (r != PDH_MORE_DATA && r != 0) return new string[0];
        if (size == 0 || count == 0) return new string[0];
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try
        {
            r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ref size, out count, buf);
            if (r != 0) return new string[0];
            var res = new string[count];
            int itemSize = Marshal.SizeOf(typeof(PDH_FMT_COUNTERVALUE_ITEM));
            for (int i = 0; i < count; i++)
            {
                IntPtr p = new IntPtr(buf.ToInt64() + (long)i * itemSize);
                PDH_FMT_COUNTERVALUE_ITEM item = (PDH_FMT_COUNTERVALUE_ITEM)Marshal.PtrToStructure(p, typeof(PDH_FMT_COUNTERVALUE_ITEM));
                string nm = Marshal.PtrToStringUni(item.szName);
                res[i] = nm + "\u0001" + item.FmtValue.doubleValue.ToString("R", CultureInfo.InvariantCulture);
            }
            return res;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static string LuidString(uint lo, uint hi)
    {
        return "0x" + hi.ToString("x8") + "_0x" + lo.ToString("x8");
    }

    static bool SplitInstance(string inst, out int pid, out string luid, out string rest)
    {
        pid = -1; luid = null; rest = null;
        if (inst == null || inst.Length < 12) return false;
        if (!inst.StartsWith("pid_", StringComparison.OrdinalIgnoreCase)) return false;
        int i = 4;
        int j = inst.IndexOf("_luid_", i, StringComparison.OrdinalIgnoreCase);
        if (j < 0) return false;
        if (!int.TryParse(inst.Substring(i, j - i), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) return false;
        string tail = inst.Substring(j + 6);
        int k = tail.IndexOf("_phys_", StringComparison.OrdinalIgnoreCase);
        if (k < 0) return false;
        luid = tail.Substring(0, k).ToLowerInvariant();
        rest = tail.Substring(k + 5);
        return true;
    }

    static HashSet<uint> WindowPids()
    {
        var set = new HashSet<uint>();
        try
        {
            EnumWindows(delegate (IntPtr h, IntPtr l) {
                try
                {
                    if (!IsWindowVisible(h)) return true;
                    uint pid; GetWindowThreadProcessId(h, out pid);
                    if (pid != 0) set.Add(pid);
                }
                catch { }
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return set;
    }

    static string J(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder(s.Length + 8);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    static void PutMem(Dictionary<string, Dictionary<string, double[]>> d, string luid, int pid, int slot, double bytes)
    {
        Dictionary<string, double[]> m;
        if (!d.TryGetValue(luid, out m)) { m = new Dictionary<string, double[]>(); d[luid] = m; }
        string k = pid.ToString(CultureInfo.InvariantCulture);
        double[] arr;
        if (!m.TryGetValue(k, out arr)) { arr = new double[5]; m[k] = arr; }
        arr[slot] += bytes;
    }

    static readonly string[] MemSlots = new string[] { "proc.Dedicated", "proc.Shared", "proc.NonLocal", "proc.Local", "proc.Committed" };
    static readonly string[] AdapterSlots = new string[] { "adapter.Dedicated", "adapter.Shared", "adapter.Committed", "adapterLocal.Local", "adapterNonLocal.NonLocal" };

    public static string Sample()
    {
        var sw = Stopwatch.StartNew();
        if (_query == IntPtr.Zero) return "{\"error\":\"not initialized\"}";
        int rc = PdhCollectQueryData(_query);
        var errs = new List<string>();
        if (rc != 0) errs.Add("collect:" + rc);

        var procMem = new Dictionary<string, Dictionary<string, double[]>>();
        var adapterMem = new Dictionary<string, long[]>();
        var engines = new Dictionary<string, double[]>(); // key pid|luid|type -> sum util
        var engineTypes = new Dictionary<string, List<string>>();
        var raw = new Dictionary<string, string[]>();
        for (int i = 0; i < _counters.Length; i++) raw[_names[i]] = CollectRaw(_counters[i]);

        for (int i = 0; i < _counters.Length; i++)
        {
            string name = _names[i];
            int slot = Array.IndexOf(MemSlots, name);
            int aslot = Array.IndexOf(AdapterSlots, name);
            string[] items = raw[name];
            foreach (string it in items)
            {
                int sep = it.IndexOf('\u0001');
                if (sep <= 0) continue;
                string inst = it.Substring(0, sep);
                double v;
                if (!double.TryParse(it.Substring(sep + 1), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) continue;
                if (double.IsNaN(v) || double.IsInfinity(v) || v < 0) continue;

                if (aslot >= 0)
                {
                    // luid_0x00000000_0x0001548b_phys_0[_part_0]
                    if (!inst.StartsWith("luid_", StringComparison.OrdinalIgnoreCase)) continue;
                    string tail = inst.Substring(5);
                    int k = tail.IndexOf("_phys_", StringComparison.OrdinalIgnoreCase);
                    if (k < 0) continue;
                    string luid = tail.Substring(0, k).ToLowerInvariant();
                    long[] arr;
                    if (!adapterMem.TryGetValue(luid, out arr)) { arr = new long[5]; adapterMem[luid] = arr; }
                    arr[aslot] += (long)Math.Round(v);
                }
                else if (name.StartsWith("proc."))
                {
                    int pid; string luid, rest;
                    if (!SplitInstance(inst, out pid, out luid, out rest)) continue;
                    PutMem(procMem, luid, pid, slot, v);
                }
                else if (name == "engine.Util")
                {
                    int pid; string luid, rest;
                    if (!SplitInstance(inst, out pid, out luid, out rest)) continue;
                    // rest = "0_eng_0_engtype_3D" (after "_phys_")
                    int e = rest.IndexOf("engtype_", StringComparison.OrdinalIgnoreCase);
                    if (e < 0) continue;
                    string etype = rest.Substring(e + 8);
                    if (etype.Length == 0) etype = "Other";
                    string key = pid.ToString(CultureInfo.InvariantCulture) + "|" + luid + "|" + etype;
                    double[] acc;
                    if (!engines.TryGetValue(key, out acc)) { acc = new double[1]; engines[key] = acc; }
                    acc[0] += v;
                    List<string> list;
                    if (!engineTypes.TryGetValue(luid, out list)) { list = new List<string>(); engineTypes[luid] = list; }
                    if (!list.Contains(etype)) list.Add(etype);
                }
            }
        }

        var winPids = WindowPids();
        var gpuPids = new HashSet<uint>();
        foreach (var kv in procMem) foreach (var p in kv.Value.Keys) gpuPids.Add(uint.Parse(p, CultureInfo.InvariantCulture));
        foreach (var key in engines.Keys) { int bar = key.IndexOf('|'); gpuPids.Add(uint.Parse(key.Substring(0, bar), CultureInfo.InvariantCulture)); }

        var sb = new StringBuilder(16384);
        sb.Append("{\"v\":1,\"ts\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

        sb.Append(",\"adapters\":[");
        bool first = true;
        foreach (var kv in adapterMem)
        {
            if (!first) sb.Append(',');
            first = false;
            long[] a = kv.Value;
            sb.Append("{\"luid\":").Append(J(kv.Key));
            sb.Append(",\"dedBytes\":").Append(a[0]);
            sb.Append(",\"sharedBytes\":").Append(a[1]);
            sb.Append(",\"committedBytes\":").Append(a[2]);
            sb.Append(",\"localBytes\":").Append(a[3]);
            sb.Append(",\"nonLocalBytes\":").Append(a[4]);
            sb.Append('}');
        }
        sb.Append(']');

        sb.Append(",\"processes\":[");
        first = true;
        foreach (var kv in procMem)
        {
            foreach (var pk in kv.Value)
            {
                double[] m = pk.Value;
                long sum5 = 0;
                for (int s = 0; s < 5; s++) sum5 += (long)Math.Round(m[s]);
                if (sum5 == 0) continue; // idle placeholder row: nothing to attribute
                if (!first) sb.Append(',');
                first = false;
                sb.Append('[').Append(pk.Key).Append(',').Append(J(kv.Key));
                for (int s = 0; s < 5; s++) sb.Append(',').Append((long)Math.Round(m[s]));
                sb.Append(']');
            }
        }
        sb.Append(']');

        sb.Append(",\"engines\":[");
        first = true;
        foreach (var kv in engines)
        {
            if (kv.Value[0] < 0.05) continue; // ignore noise rows so the payload stays small
            if (!first) sb.Append(',');
            first = false;
            string[] parts = kv.Key.Split('|');
            sb.Append('[').Append(parts[0]).Append(',').Append(J(parts[1])).Append(',').Append(J(parts[2]))
              .Append(',').Append(Math.Round(kv.Value[0], 2).ToString("R", CultureInfo.InvariantCulture)).Append(']');
        }
        sb.Append(']');

        // process info for gpu pids + windowed pids
        var cache = _descCache;
        sb.Append(",\"procs\":[");
        first = true;
        Process[] procs;
        try { procs = Process.GetProcesses(); } catch { procs = new Process[0]; }
        foreach (Process p in procs)
        {
            uint pid;
            try { pid = (uint)p.Id; } catch { continue; }
            bool hasWin = winPids.Contains(pid);
            if (!hasWin && !gpuPids.Contains(pid)) continue;
            string path = "";
            try { path = p.MainModule.FileName; } catch { }
            string name = "";
            try { name = p.ProcessName; } catch { }
            string desc = "";
            if (path.Length > 0)
            {
                if (cache.ContainsKey(path)) desc = cache[path];
                else
                {
                    try
                    {
                        var fvi = FileVersionInfo.GetVersionInfo(path);
                        desc = fvi.FileDescription;
                        if (string.IsNullOrEmpty(desc)) desc = fvi.ProductName;
                    }
                    catch { }
                    if (desc == null) desc = "";
                    cache[path] = desc;
                }
            }
            if (!first) sb.Append(',');
            first = false;
            sb.Append('[').Append(pid).Append(',').Append(J(path)).Append(',').Append(J(name)).Append(',').Append(J(desc)).Append(',').Append(hasWin ? "1" : "0").Append(']');
        }
        sb.Append(']');

        if (errs.Count > 0)
        {
            sb.Append(",\"err\":[");
            for (int i = 0; i < errs.Count; i++) { if (i > 0) sb.Append(','); sb.Append(J(errs[i])); }
            sb.Append(']');
        }
        sw.Stop();
        sb.Append(",\"ms\":").Append(Math.Round(sw.Elapsed.TotalMilliseconds, 2).ToString("R", CultureInfo.InvariantCulture));
        sb.Append('}');
        return sb.ToString();
    }

    static Dictionary<string, string> _descCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public static string AdapterPathsJson()
    {
        var sb = new StringBuilder();
        sb.Append('[');
        bool first = true;
        try
        {
            uint nPath = 0, nMode = 0;
            int r = GetDisplayConfigBufferSizes(2 /*QDC_ALL_PATHS*/, out nPath, out nMode);
            if (r == 0 && nPath > 0)
            {
                var paths = new PATH_INFO[nPath];
                var modes = new MODE_INFO[nMode];
                r = QueryDisplayConfig(2, ref nPath, paths, ref nMode, modes, IntPtr.Zero);
                if (r == 0)
                {
                    var seen = new HashSet<string>();
                    for (int i = 0; i < nPath; i++)
                    {
                        LUID id = paths[i].sourceInfo.adapterId;
                        string luid = LuidString(id.LowPart, (uint)id.HighPart);
                        if (seen.Contains(luid)) continue;
                        var an = new ADAPTER_NAME();
                        an.header.type = 4; // GET_ADAPTER_NAME
                        an.header.size = (uint)Marshal.SizeOf(typeof(ADAPTER_NAME));
                        an.header.adapterId = id;
                        an.header.id = 0;
                        int ar = DisplayConfigGetDeviceInfo(ref an);
                        string devPath = ar == 0 ? an.adapterDevicePath : "";
                        seen.Add(luid);
                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append("{\"luid\":").Append(J(luid)).Append(",\"devicePath\":").Append(J(devPath)).Append('}');
                    }
                }
            }
        }
        catch { }
        sb.Append(']');
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp | Out-Null

$ok = [GpuSampler]::Init()
$helloObj = [ordered]@{
  type = 'hello'
  version = $ScriptVersion
  ok = [bool]$ok
  psPid = $PID
  displayPathsJson = [string][GpuSampler]::AdapterPathsJson()
  dxgiAdaptersJson = [string][GpuSampler]::AdaptersJson()
  counters = [string[]][GpuSampler]::LoadedCounters
  initError = [string][GpuSampler]::InitError
}
$helloLine = $helloObj | ConvertTo-Json -Compress -Depth 6
Write-Output $helloLine

if (-not $ok) { exit 1 }

if ($Once) {
  Write-Output ([GpuSampler]::Sample())
  exit 0
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'q') { break }
  if ($line -eq 'tick') {
    try { Write-Output ([GpuSampler]::Sample()) } catch { Write-Output ('{"v":1,"err":["' + ($_.Exception.Message -replace '"','\"') + '"]}') }
  }
}