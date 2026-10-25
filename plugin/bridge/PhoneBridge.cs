// PhoneBridge -- long-lived phone backend for the Eagle "Phone Photo Sync" plugin.
//
// Talks to iPhones, Android phones and cameras through Windows Portable Devices
// (WPD / MTP), the same channel File Explorer uses for "This PC > <phone>".
//
// WHY A LONG-LIVED PROCESS: the old backend started a fresh PowerShell and
// recompiled the WPD interop for every single call (1-3 s each), opened and
// closed an MTP session per call, and recovered from a stuck device only by
// killing the process -- which leaks the MTP session and wedges the phone until
// it is replugged. This process starts once, keeps one session open, schedules
// work by priority, and recovers from a stall with IPortableDevice::Cancel
// instead of a kill.
//
// PROTOCOL: one JSON object per line on stdin (requests) and stdout (events).
//   request : {"id":7,"op":"list","device":"<wpd id>", ...}
//   events  : {"id":7,"type":"items"|"item"|"progress", ...}
//             {"id":7,"type":"done","ok":true, ...}  /  {"id":7,"type":"done","ok":false,"code":"...","error":"..."}
//   global  : {"type":"ready"|"stall"|"unstall"|"fatal", ...}
// Diagnostics go to stderr. All user-facing wording lives in the plugin's JS;
// this side only reports stable error codes.
//
// BUILD: C# 5 / .NET Framework 4.x on purpose -- csc.exe ships with every
// Windows 10/11, so no SDK is needed, and PowerShell 5.1 can compile the very
// same file with Add-Type when the exe is blocked. Keep this file ASCII-only:
// PowerShell reads source with the system ANSI codepage.

using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Drawing;
using System.Drawing.Imaging;
using ComTypes = System.Runtime.InteropServices.ComTypes;

namespace PhoneBridge
{
    public static class Program
    {
        [MTAThread]
        public static int Main(string[] args) { return Host.Run(args); }
    }

    // A failure with a stable code the UI can translate.
    public class BridgeError : Exception
    {
        public readonly string Code;
        public BridgeError(string code, string message) : base(message) { Code = code; }
    }

    // ======================================================================
    // Host: stdin/stdout plumbing, request dispatch, lifecycle.
    // ======================================================================
    public static class Host
    {
        public const string Version = "2.0.0";

        static readonly object OutLock = new object();
        static TextWriter _out, _err;
        internal static JavaScriptSerializer Json;
        internal static Scheduler Sched;
        static int _shuttingDown;
        static string _mode = "exe";

        // Entry point for both the exe and the PowerShell fallback. Everything
        // runs on a fresh MTA thread: PowerShell hosts us on an STA, and the WPD
        // bulk-property callback would deadlock there (it is marshalled back to
        // the STA thread that is blocked waiting for it).
        public static int Run(string[] args)
        {
            int rc = 0;
            var t = new Thread(delegate () { rc = RunMta(args ?? new string[0]); }, 4 * 1024 * 1024);
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
            t.Join();
            return rc;
        }

        static int RunMta(string[] args)
        {
            var enc = new UTF8Encoding(false);
            var o = new StreamWriter(Console.OpenStandardOutput(), enc); o.AutoFlush = true; o.NewLine = "\n"; _out = o;
            var e = new StreamWriter(Console.OpenStandardError(), enc); e.AutoFlush = true; e.NewLine = "\n"; _err = e;
            var input = new StreamReader(Console.OpenStandardInput(), enc);
            Json = new JavaScriptSerializer();
            Json.MaxJsonLength = int.MaxValue;
            Json.RecursionLimit = 64;

            int parentPid = 0;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--parent" && i + 1 < args.Length) int.TryParse(args[i + 1], out parentPid);
                if (args[i] == "--ps") _mode = "ps";
            }
            if (parentPid > 0) StartParentWatch(parentPid);

            Sched = new Scheduler();
            Sched.Start();

            var ready = new Dictionary<string, object>();
            ready["type"] = "ready";
            ready["version"] = Version;
            ready["mode"] = _mode;
            ready["pid"] = Process.GetCurrentProcess().Id;
            ready["clr"] = Environment.Version.ToString();
            ready["os"] = OsVersion();
            ready["x64"] = Environment.Is64BitProcess;
            Send(ready);
            Log("bridge " + Version + " ready (" + _mode + ", clr " + Environment.Version + ", " + (Environment.Is64BitProcess ? "x64" : "x86") + ")");

            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                try { Dispatch(line); }
                catch (Exception ex) { Log("dispatch failed: " + ex.Message); }
                if (_shuttingDown != 0) break;
            }
            // stdin closed: the plugin window is gone (or asked us to quit).
            Shutdown("stdin closed");
            return 0;
        }

        // Environment.OSVersion lies (6.2) without an app manifest; the registry doesn't.
        internal static string OsVersion()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    string build = Convert.ToString(k.GetValue("CurrentBuildNumber"));
                    object ubr = k.GetValue("UBR");
                    string disp = Convert.ToString(k.GetValue("DisplayVersion"));
                    return "Windows build " + build + (ubr != null ? "." + ubr : "") + (string.IsNullOrEmpty(disp) ? "" : " (" + disp + ")");
                }
            }
            catch { return Environment.OSVersion.VersionString; }
        }

        static void Dispatch(string line)
        {
            var req = Json.Deserialize<Dictionary<string, object>>(line);
            long id = req.ContainsKey("id") ? Convert.ToInt64(req["id"]) : 0;
            string op = req.ContainsKey("op") ? Convert.ToString(req["op"]) : "";
            switch (op)
            {
                case "ping":
                    { var r = new Dictionary<string, object>(); r["pong"] = true; Done(id, r); break; }
                case "devices":
                    Devices.ListAsync(id, Arg.Bool(req, "usb", true));
                    break;
                case "cancel":
                    Sched.Cancel(Arg.Long(req, "target", 0));
                    break;
                case "quit":
                    Shutdown("quit requested");
                    break;
                case "list": case "thumbs": case "preview": case "copy": case "delete":
                case "storage": case "diag": case "release": case "bench":
                    Sched.Enqueue(new Job(id, op, req));
                    break;
                default:
                    Fail(id, "BAD_OP", "unknown op: " + op);
                    break;
            }
        }

        // ---- output -------------------------------------------------------
        internal static void Send(Dictionary<string, object> msg)
        {
            string s;
            try { s = Json.Serialize(msg); }
            catch (Exception ex) { Log("serialize failed: " + ex.Message); return; }
            lock (OutLock) { try { _out.WriteLine(s); } catch { } }
        }
        internal static void Event(long id, string type, Dictionary<string, object> body)
        {
            if (body == null) body = new Dictionary<string, object>();
            body["id"] = id; body["type"] = type;
            Send(body);
        }
        internal static void Done(long id, Dictionary<string, object> result)
        {
            if (result == null) result = new Dictionary<string, object>();
            result["id"] = id; result["type"] = "done"; result["ok"] = true;
            Send(result);
        }
        internal static void Fail(long id, string code, string error)
        {
            var r = new Dictionary<string, object>();
            r["id"] = id; r["type"] = "done"; r["ok"] = false; r["code"] = code; r["error"] = error ?? code;
            Send(r);
        }
        internal static void Log(string msg)
        {
            lock (OutLock) { try { _err.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg); } catch { } }
        }

        // ---- lifecycle ----------------------------------------------------
        // A plugin window that dies without telling us (crash, Eagle killed)
        // must not leave us holding the phone's only MTP session. stdin EOF
        // covers most of it; the parent watch covers a parent that is gone but
        // whose pipe handle leaked into some other process.
        static void StartParentWatch(int pid)
        {
            var t = new Thread(delegate ()
            {
                while (_shuttingDown == 0)
                {
                    Thread.Sleep(2000);
                    bool alive;
                    try { var p = Process.GetProcessById(pid); alive = !p.HasExited; }
                    catch { alive = false; }
                    if (!alive) { Shutdown("parent " + pid + " exited"); return; }
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        internal static void Shutdown(string why)
        {
            if (Interlocked.Exchange(ref _shuttingDown, 1) != 0) return;
            Log("shutting down: " + why);
            try { if (Sched != null) Sched.Stop(4000); } catch { }
            Log("bye");
            Environment.Exit(0);   // also ends a worker stuck inside a driver call
        }
    }

    // Small typed accessors over the deserialized request.
    static class Arg
    {
        public static string Str(Dictionary<string, object> d, string k, string def)
        { object v; return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : def; }
        public static long Long(Dictionary<string, object> d, string k, long def)
        { object v; if (d != null && d.TryGetValue(k, out v) && v != null) { try { return Convert.ToInt64(v); } catch { } } return def; }
        public static bool Bool(Dictionary<string, object> d, string k, bool def)
        { object v; if (d != null && d.TryGetValue(k, out v) && v is bool) return (bool)v; return def; }
        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        { object v; return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
        public static List<Dictionary<string, object>> List(Dictionary<string, object> d, string k)
        {
            var res = new List<Dictionary<string, object>>();
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return res;
            var arr = v as System.Collections.IEnumerable;
            if (arr == null) return res;
            foreach (var x in arr) { var o = x as Dictionary<string, object>; if (o != null) res.Add(o); }
            return res;
        }
    }

    // ======================================================================
    // WPD COM interop. Vtable layouts verified against the Windows SDK headers
    // (PortableDeviceApi.h / PortableDevice.h); every slot up to the last one
    // used must be declared in order or calls land on the wrong method.
    // ======================================================================
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    // A real PROPVARIANT is 24 bytes on x64 (16 on x86). Declaring it smaller
    // lets GetAt(out ...) write past the struct and corrupt the stack.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

    [ComImport, Guid("A1567595-4C2F-4574-A6FA-ECEF917B9A40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceManager
    {
        void GetDevices([In, Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr, SizeParamIndex = 1)] string[] ids, [In, Out] ref uint count);
        void RefreshDeviceList();
        void GetDeviceFriendlyName([MarshalAs(UnmanagedType.LPWStr)] string id, [In, Out] StringBuilder name, [In, Out] ref uint pcch);
        void GetDeviceDescription([MarshalAs(UnmanagedType.LPWStr)] string id, [In, Out] StringBuilder desc, [In, Out] ref uint pcch);
        void GetDeviceManufacturer([MarshalAs(UnmanagedType.LPWStr)] string id, [In, Out] StringBuilder mfr, [In, Out] ref uint pcch);
    }
    // Close() ends the MTP session -- mandatory, MTP allows ONE per device.
    // Cancel() aborts a call another thread is blocked in; it is how the
    // watchdog unsticks a device without killing the process.
    [ComImport, Guid("625E2DF8-6392-4CF0-9AD1-3CFA5F17775C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevice
    {
        void Open([MarshalAs(UnmanagedType.LPWStr)] string id, IPortableDeviceValues clientInfo);
        void SendCommand(int flags, IntPtr pParams, out IntPtr ppResults);
        void Content(out IPortableDeviceContent ppContent);
        void Capabilities(out IntPtr ppCapabilities);
        void Cancel();
        void Close();
    }
    [ComImport, Guid("6A96ED84-7C73-4480-9938-BF5AF477D426"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceContent
    {
        void EnumObjects(uint flags, [MarshalAs(UnmanagedType.LPWStr)] string parent, IPortableDeviceValues filter, out IEnumPortableDeviceObjectIDs ppEnum);
        void Properties(out IPortableDeviceProperties ppProperties);
        void Transfer(out IPortableDeviceResources ppResources);
        void CreateObjectWithPropertiesOnly(IntPtr a, IntPtr b);
        void CreateObjectWithPropertiesAndData(IntPtr a, IntPtr b, IntPtr c, IntPtr d);
        void Delete(uint dwOptions, IPortableDevicePropVariantCollection pObjectIDs, out IPortableDevicePropVariantCollection ppResults);
    }
    // IID ends ...A44AFEA83EB3 (an earlier ...9DC19 was wrong and silently broke delete).
    [ComImport, Guid("89B2E422-4F1B-4316-BCEF-A44AFEA83EB3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevicePropVariantCollection
    {
        void GetCount(ref uint pcElems);
        void GetAt(uint index, out PROPVARIANT pValue);
        void Add(ref PROPVARIANT pValue);
    }
    [ComImport, Guid("FD8878AC-D841-4D17-891C-E6829CDB6934"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceResources
    {
        void GetSupportedResources([MarshalAs(UnmanagedType.LPWStr)] string objId, out IPortableDeviceKeyCollection ppKeys);
        void GetResourceAttributes([MarshalAs(UnmanagedType.LPWStr)] string objId, ref PROPERTYKEY key, out IPortableDeviceValues ppAttrs);
        void GetStream([MarshalAs(UnmanagedType.LPWStr)] string objId, ref PROPERTYKEY key, uint dwStgAccess, ref uint pOptimalBufferSize, out ComTypes.IStream ppStream);
    }
    [ComImport, Guid("10ECE955-CF41-4728-BFA0-41EEDF1BBF19"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumPortableDeviceObjectIDs
    {
        [PreserveSig] int Next(uint cObjects, [In, Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr, SizeParamIndex = 0)] string[] pObjIDs, ref uint pcFetched);
    }
    [ComImport, Guid("7F6D695C-03DF-4439-A809-59266BEEE3A6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceProperties
    {
        void GetSupportedProperties([MarshalAs(UnmanagedType.LPWStr)] string objId, out IPortableDeviceKeyCollection ppKeys);
        void GetPropertyAttributes([MarshalAs(UnmanagedType.LPWStr)] string objId, ref PROPERTYKEY key, out IPortableDeviceValues ppAttrs);
        void GetValues([MarshalAs(UnmanagedType.LPWStr)] string objId, IPortableDeviceKeyCollection pKeys, out IPortableDeviceValues ppValues);
    }
    // Bulk property reads = MTP GetObjectPropList: one transaction per folder
    // instead of one per object (Android's in-box MTP driver is ~20 ms/object).
    [ComImport, Guid("6E3F2D79-4E07-48C4-8208-D8C2E5AF4A99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceValuesCollection
    {
        void GetCount(ref uint pcElems);
        void GetAt(uint index, out IPortableDeviceValues ppValues);
    }
    [ComImport, Guid("9DEACB80-11E8-40E3-A9F3-F557986A7845"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevicePropertiesBulkCallback
    {
        void OnStart(ref Guid pContext);
        void OnProgress(ref Guid pContext, IPortableDeviceValuesCollection pResults);
        void OnEnd(ref Guid pContext, int hrStatus);
    }
    [ComImport, Guid("482B05C0-4056-44ED-9E0F-5E23B009DA93"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevicePropertiesBulk
    {
        void QueueGetValuesByObjectList(IPortableDevicePropVariantCollection pObjectIDs, IPortableDeviceKeyCollection pKeys, IPortableDevicePropertiesBulkCallback pCallback, out Guid pContext);
        void QueueGetValuesByObjectFormat(ref Guid fmt, [MarshalAs(UnmanagedType.LPWStr)] string parent, uint depth, IPortableDeviceKeyCollection pKeys, IPortableDevicePropertiesBulkCallback pCallback, out Guid pContext);
        void QueueSetValuesByObjectList(IntPtr pObjectValues, IPortableDevicePropertiesBulkCallback pCallback, out Guid pContext);
        void Start(ref Guid pContext);
        void Cancel(ref Guid pContext);
    }
    [ComImport, Guid("DADA2357-E0AD-492E-98DB-DD61C53BA353"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceKeyCollection
    {
        void GetCount(ref uint pcElems);
        void GetAt(uint index, out PROPERTYKEY pKey);
        void Add(ref PROPERTYKEY Key);
    }
    [ComImport, Guid("6848F6F2-3155-4F86-B6F5-263EEEAB3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceValues
    {
        void GetCount(ref uint pcelt);
        void GetAt(uint index, ref PROPERTYKEY pKey, IntPtr pValue);
        void SetValue(ref PROPERTYKEY key, IntPtr pValue);
        void GetValue(ref PROPERTYKEY key, IntPtr pValue);
        void SetStringValue(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.LPWStr)] string Value);
        void GetStringValue(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.LPWStr)] out string pValue);
        void SetUnsignedIntegerValue(ref PROPERTYKEY key, uint Value);
        void GetUnsignedIntegerValue(ref PROPERTYKEY key, out uint pValue);
        void SetSignedIntegerValue(ref PROPERTYKEY key, int Value);
        void GetSignedIntegerValue(ref PROPERTYKEY key, out int pValue);
        void SetUnsignedLargeIntegerValue(ref PROPERTYKEY key, ulong Value);
        void GetUnsignedLargeIntegerValue(ref PROPERTYKEY key, out ulong pValue);
        void SetSignedLargeIntegerValue(ref PROPERTYKEY key, long Value);
        void GetSignedLargeIntegerValue(ref PROPERTYKEY key, out long pValue);
        void SetFloatValue(ref PROPERTYKEY key, float Value);
        void GetFloatValue(ref PROPERTYKEY key, out float pValue);
        void SetErrorValue(ref PROPERTYKEY key, int Value);
        void GetErrorValue(ref PROPERTYKEY key, out int pValue);
        void SetKeyValue(ref PROPERTYKEY key, ref PROPERTYKEY Value);
        void GetKeyValue(ref PROPERTYKEY key, out PROPERTYKEY pValue);
        void SetBoolValue(ref PROPERTYKEY key, int Value);
        void GetBoolValue(ref PROPERTYKEY key, out int pValue);
        void SetIUnknownValue(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.IUnknown)] object Value);
        void GetIUnknownValue(ref PROPERTYKEY key, [MarshalAs(UnmanagedType.IUnknown)] out object ppValue);
        void SetGuidValue(ref PROPERTYKEY key, ref Guid Value);
        void GetGuidValue(ref PROPERTYKEY key, out Guid pValue);
    }

    static class W
    {
        public static readonly Guid CLSID_DeviceManager = new Guid("0AF10CEC-2ECD-4B92-9581-34F6AE0637F3");
        public static readonly Guid CLSID_DeviceFTM = new Guid("F7C0039A-4762-488A-B4B3-760EF9A1BA9B");
        public static readonly Guid CLSID_Values = new Guid("0C15D503-D017-47CE-9016-7B3F978721CC");
        public static readonly Guid CLSID_KeyCollection = new Guid("DE2D022D-2480-43BE-97F0-D1FA2CF98F4F");
        public static readonly Guid CLSID_PropVariantCollection = new Guid("08A99E2F-6D6D-4B80-AF5A-BAF2BCBE4CB9");

        public static readonly Guid RES_DEFAULT = new Guid("E81E79BE-34F0-41BF-B53F-F1A06AE87842");
        public static readonly Guid RES_THUMBNAIL = new Guid("C7C407BA-98FA-46B5-9960-23FEC124CFDE");
        public static readonly Guid CT_FOLDER = new Guid("27E2E392-A111-48E0-AB0C-E17705A05F85");
        public static readonly Guid CT_FUNCTIONAL = new Guid("99ED0160-17FF-4C44-9D98-1D7A6F941921");

        static readonly Guid OBJ = new Guid("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C");
        static readonly Guid STORAGE = new Guid("01A3057A-74D6-4E80-BEA7-DC4C212CE50A");
        static readonly Guid DEVICE = new Guid("26D4979A-E643-4626-9E2B-736DC0C92FDC");
        static readonly Guid CLIENT = new Guid("204D9F0C-2292-4080-9F42-40664E70F859");
        static PROPERTYKEY K(Guid g, uint pid) { PROPERTYKEY k; k.fmtid = g; k.pid = pid; return k; }

        // Keys are fields (not readonly) because COM wants them by ref.
        public static PROPERTYKEY OBJECT_ID = K(OBJ, 2);
        public static PROPERTYKEY OBJECT_NAME = K(OBJ, 4);
        public static PROPERTYKEY OBJECT_CONTENT_TYPE = K(OBJ, 7);
        public static PROPERTYKEY OBJECT_SIZE = K(OBJ, 11);
        public static PROPERTYKEY OBJECT_ORIGINAL_FILE_NAME = K(OBJ, 12);
        public static PROPERTYKEY OBJECT_DATE_CREATED = K(OBJ, 18);
        public static PROPERTYKEY OBJECT_DATE_MODIFIED = K(OBJ, 19);
        public static PROPERTYKEY STORAGE_CAPACITY = K(STORAGE, 4);
        public static PROPERTYKEY STORAGE_FREE = K(STORAGE, 5);
        public static PROPERTYKEY STORAGE_DESCRIPTION = K(STORAGE, 7);
        public static PROPERTYKEY DEVICE_FIRMWARE = K(DEVICE, 3);
        public static PROPERTYKEY DEVICE_PROTOCOL = K(DEVICE, 6);
        public static PROPERTYKEY DEVICE_MODEL = K(DEVICE, 8);
        public static PROPERTYKEY CLIENT_NAME = K(CLIENT, 2);

        public static object Create(Guid clsid) { return Activator.CreateInstance(Type.GetTypeFromCLSID(clsid, true)); }

        // FinalRelease, not Release: a lingering reference on per-object value
        // bags makes the device stall progressively (measured ~200x slower after
        // a few thousand objects).
        public static void Rel(object o) { if (o != null) { try { Marshal.FinalReleaseComObject(o); } catch { } } }

        public static IPortableDeviceKeyCollection Keys(params PROPERTYKEY[] keys)
        {
            var c = (IPortableDeviceKeyCollection)Create(CLSID_KeyCollection);
            for (int i = 0; i < keys.Length; i++) { var k = keys[i]; c.Add(ref k); }
            return c;
        }

        public static string Str(IPortableDeviceValues v, PROPERTYKEY k)
        { string s = null; try { v.GetStringValue(ref k, out s); } catch { } return s; }
        public static ulong ULong(IPortableDeviceValues v, PROPERTYKEY k, ulong def)
        { ulong x; try { v.GetUnsignedLargeIntegerValue(ref k, out x); return x; } catch { return def; } }
        public static Guid GuidV(IPortableDeviceValues v, PROPERTYKEY k)
        { Guid g = Guid.Empty; try { v.GetGuidValue(ref k, out g); } catch { } return g; }

        [DllImport("ole32.dll")] static extern int PropVariantClear(IntPtr pvar);

        // Dates arrive as VT_DATE on most drivers and as a string on a few, so
        // read the raw PROPVARIANT instead of trusting GetStringValue's format.
        public static DateTime? Date(IPortableDeviceValues v, PROPERTYKEY k)
        {
            IntPtr pv = Marshal.AllocCoTaskMem(24);
            try
            {
                for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
                try { v.GetValue(ref k, pv); } catch { return null; }
                ushort vt = (ushort)Marshal.ReadInt16(pv, 0);
                DateTime? res = null;
                if (vt == 7) // VT_DATE
                {
                    double d = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(pv, 8));
                    try { if (d > 1) res = DateTime.FromOADate(d); } catch { }
                }
                else if (vt == 31) // VT_LPWSTR, e.g. "2025/06/12:14:30:00"
                {
                    string s = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pv, 8));
                    res = ParseLooseDate(s);
                }
                PropVariantClear(pv);
                if (res.HasValue && (res.Value.Year < 1990 || res.Value.Year > 2100)) res = null;
                return res;
            }
            finally { Marshal.FreeCoTaskMem(pv); }
        }
        public static DateTime? ParseLooseDate(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            var m = System.Text.RegularExpressions.Regex.Match(s, @"(\d{4})\D(\d{1,2})\D(\d{1,2})(?:\D+(\d{1,2})\D(\d{1,2})(?:\D(\d{1,2}))?)?");
            if (!m.Success) return null;
            try
            {
                return new DateTime(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value),
                    m.Groups[4].Success ? int.Parse(m.Groups[4].Value) : 0,
                    m.Groups[5].Success ? int.Parse(m.Groups[5].Value) : 0,
                    m.Groups[6].Success ? int.Parse(m.Groups[6].Value) : 0);
            }
            catch { return null; }
        }

        public static IPortableDeviceValues ClientInfo()
        {
            var v = (IPortableDeviceValues)Create(CLSID_Values);
            var k = CLIENT_NAME; v.SetStringValue(ref k, "EaglePhoneSync");
            return v;
        }

        public static string SbGet(Action<StringBuilder> call)
        {
            try { var sb = new StringBuilder(512); call(sb); return sb.ToString(); } catch { return ""; }
        }
    }

    // ======================================================================
    // Error classification. Device-level codes invalidate the session; item
    // codes (NOT_FOUND, LOCAL_IO...) only fail that one file.
    // ======================================================================
    static class Err
    {
        public static string Code(Exception ex)
        {
            var be = ex as BridgeError;
            if (be != null) return be.Code;
            if (ex is IOException || ex is UnauthorizedAccessException)
            {
                uint h = (uint)ex.HResult;
                if (h == 0x80070070 || h == 0x80070027) return "DISK_FULL";
                return "LOCAL_IO";
            }
            uint hr = (uint)ex.HResult;
            switch (hr)
            {
                case 0x80070005: return "ACCESS_DENIED";       // locked iPhone / not trusted
                case 0x800700AA: case 0x802A0001: return "DEVICE_BUSY";
                case 0x800704C7: case 0x800703E3: return "CANCELLED";
                case 0x80070079: case 0x802A0006: case 0x800705B4: return "TIMEOUT";
                case 0x8007048F: case 0x80070015: case 0x800706BA: case 0x800706BE:
                case 0x80070037: case 0x8007001F: case 0x802A0002: case 0x80070016:
                    return "DISCONNECTED";
                case 0x80070490: case 0x80070002: case 0x80070003: return "NOT_FOUND";
                case 0x80070070: case 0x80070027: return "DISK_FULL";
            }
            return "DEVICE_ERROR";
        }
        public static bool IsDeviceLevel(string code)
        {
            return code == "ACCESS_DENIED" || code == "DEVICE_BUSY" || code == "TIMEOUT" ||
                   code == "DISCONNECTED" || code == "DEVICE_ERROR" || code == "NO_DEVICE" || code == "DEVICE_RESET";
        }
        public static string Hex(Exception ex) { return "0x" + ((uint)ex.HResult).ToString("X8"); }
        public static string Describe(Exception ex)
        {
            if (ex is BridgeError) return ex.Message;
            return ex.GetType().Name + " " + Hex(ex) + ": " + ex.Message;
        }
    }

    // ======================================================================
    // Device discovery (no session needed -- safe while a session is open).
    // ======================================================================
    static class Devices
    {
        static readonly string[] PhoneHints = {
            "apple","iphone","ipad","ipod","android","phone","galaxy","samsung",
            "xiaomi","redmi","poco","huawei","honor","oppo","vivo","oneplus","pixel",
            "google","moto","nokia","xperia","realme","asus","zte","nubia","meizu",
            "lenovo","tecno","infinix","nothing","iqoo"
        };

        public static string Kind(string name, string mfr, string desc)
        {
            string s = ((name ?? "") + " " + (mfr ?? "") + " " + (desc ?? "")).ToLowerInvariant();
            if (s.Contains("apple") || s.Contains("iphone") || s.Contains("ipad") || s.Contains("ipod")) return "ios";
            foreach (var h in PhoneHints) if (s.IndexOf(h, StringComparison.Ordinal) >= 0) return "android";
            return "other";
        }

        public class Info { public string Id, Name, Desc, Mfr, Kind; }

        public static List<Info> Enumerate()
        {
            var res = new List<Info>();
            var mgr = (IPortableDeviceManager)W.Create(W.CLSID_DeviceManager);
            try
            {
                try { mgr.RefreshDeviceList(); } catch { }
                uint c = 0; mgr.GetDevices(null, ref c);
                if (c == 0) return res;
                var ids = new string[c]; mgr.GetDevices(ids, ref c);
                for (int i = 0; i < c; i++)
                {
                    string id = ids[i];
                    if (string.IsNullOrEmpty(id)) continue;
                    var inf = new Info();
                    inf.Id = id;
                    inf.Name = W.SbGet(delegate (StringBuilder s) { uint x = (uint)s.Capacity; mgr.GetDeviceFriendlyName(id, s, ref x); });
                    inf.Desc = W.SbGet(delegate (StringBuilder s) { uint x = (uint)s.Capacity; mgr.GetDeviceDescription(id, s, ref x); });
                    inf.Mfr = W.SbGet(delegate (StringBuilder s) { uint x = (uint)s.Capacity; mgr.GetDeviceManufacturer(id, s, ref x); });
                    if (string.IsNullOrEmpty(inf.Name)) inf.Name = !string.IsNullOrEmpty(inf.Desc) ? inf.Desc : "Portable Device";
                    inf.Kind = Kind(inf.Name, inf.Mfr, inf.Desc);
                    res.Add(inf);
                }
            }
            finally { W.Rel(mgr); }
            return res;
        }

        // The UI normally sends the exact WPD id; a friendly name is accepted
        // too (older callers), matched exactly first, then loosely.
        public static string Resolve(string key)
        {
            var all = Enumerate();
            if (all.Count == 0) return null;
            if (!string.IsNullOrEmpty(key))
            {
                foreach (var d in all) if (string.Equals(d.Id, key, StringComparison.OrdinalIgnoreCase)) return d.Id;
                foreach (var d in all) if (string.Equals(d.Name, key, StringComparison.OrdinalIgnoreCase)) return d.Id;
                return null;   // asked for a specific device that is not there
            }
            foreach (var d in all) if (d.Kind != "other") return d.Id;
            return all[0].Id;
        }

        // Concurrent "devices" requests share one enumeration.
        static readonly object Lk = new object();
        static List<long> _waiting;
        static bool _wantUsb;

        public static void ListAsync(long id, bool usb)
        {
            lock (Lk)
            {
                if (_waiting != null) { _waiting.Add(id); _wantUsb |= usb; return; }
                _waiting = new List<long>(); _waiting.Add(id); _wantUsb = usb;
            }
            var t = new Thread(delegate ()
            {
                Dictionary<string, object> result = null; string err = null, code = "DEVICE_ERROR";
                try
                {
                    var list = new List<object>();
                    bool anyPhone = false;
                    // Time-boxed: a wedged driver stack can block the device
                    // manager forever, and an unanswered "devices" would stop
                    // plug/unplug detection in the UI for good.
                    List<Info> found = null; Exception enumErr = null;
                    var et = new Thread(delegate () { try { found = Enumerate(); } catch (Exception ex) { enumErr = ex; } });
                    et.IsBackground = true;
                    et.SetApartmentState(ApartmentState.MTA);
                    et.Start();
                    if (!et.Join(8000)) { code = "TIMEOUT"; throw new BridgeError("TIMEOUT", "device enumeration hung"); }
                    if (enumErr != null) throw enumErr;
                    foreach (var d in found)
                    {
                        var o = new Dictionary<string, object>();
                        o["id"] = d.Id; o["name"] = d.Name; o["desc"] = d.Desc; o["mfr"] = d.Mfr; o["kind"] = d.Kind;
                        list.Add(o);
                        if (d.Kind != "other") anyPhone = true;
                    }
                    result = new Dictionary<string, object>();
                    result["devices"] = list;
                    bool wantUsb; lock (Lk) wantUsb = _wantUsb;
                    // Only worth the WMI query when no phone shows up: it tells
                    // "iPhone plugged in but not trusted / no driver" apart from
                    // "nothing plugged in at all".
                    if (!anyPhone && wantUsb) result["usb"] = Usb.Probe();
                }
                catch (Exception ex) { err = Err.Describe(ex); Host.Log("devices failed: " + err); }
                List<long> ids;
                lock (Lk) { ids = _waiting; _waiting = null; }
                foreach (var w in ids)
                {
                    if (result != null) Host.Done(w, new Dictionary<string, object>(result));
                    else Host.Fail(w, code, err);
                }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
        }
    }

    // USB-level hints via WMI, for when WPD shows no phone. Cached briefly and
    // time-boxed: WMI can hang on a broken system, and this must never block.
    static class Usb
    {
        static Dictionary<string, object> _cache;
        static DateTime _at;

        public static Dictionary<string, object> Probe()
        {
            if (_cache != null && (DateTime.UtcNow - _at).TotalSeconds < 8) return _cache;
            Dictionary<string, object> res = null;
            var t = new Thread(delegate () { try { res = Query(); } catch (Exception ex) { Host.Log("usb probe: " + ex.Message); } });
            t.IsBackground = true;
            t.Start();
            if (!t.Join(5000)) Host.Log("usb probe timed out");
            if (res == null) { res = new Dictionary<string, object>(); res["probed"] = false; }
            _cache = res; _at = DateTime.UtcNow;
            return res;
        }

        static Dictionary<string, object> Query()
        {
            var res = new Dictionary<string, object>();
            int apple = 0, appleProblem = 0;
            var names = new List<object>();
            using (var s = new System.Management.ManagementObjectSearcher(
                "SELECT Name, PNPDeviceID, ConfigManagerErrorCode FROM Win32_PnPEntity WHERE PNPDeviceID LIKE 'USB\\\\VID_05AC%'"))
            {
                foreach (System.Management.ManagementObject mo in s.Get())
                {
                    apple++;
                    int code = 0;
                    try { code = Convert.ToInt32(mo["ConfigManagerErrorCode"]); } catch { }
                    if (code != 0 && appleProblem == 0) appleProblem = code;
                    string n = Convert.ToString(mo["Name"]);
                    if (!string.IsNullOrEmpty(n) && names.Count < 6) names.Add(n);
                }
            }
            res["probed"] = true;
            res["apple"] = apple;
            res["appleProblem"] = appleProblem;   // 28 = driver not installed, 10 = cannot start, ...
            res["appleNames"] = names;
            return res;
        }
    }

    // ======================================================================
    // One open MTP session. Owned by the worker thread; only CancelPending()
    // may be called from elsewhere (the watchdog), and it is serialized
    // against the release in Close() so it never touches a freed wrapper.
    // ======================================================================
    class Session
    {
        public string DeviceId;
        public IPortableDevice Dev;
        public IPortableDeviceContent Content;
        public IPortableDeviceProperties Props;
        public IPortableDeviceResources Res;
        public IPortableDevicePropertiesBulk Bulk;   // same RCW as Props; never released on its own
        public bool BulkOk;
        public int BulkFails;
        public bool ThumbKeyResolved;
        public PROPERTYKEY ThumbKey;
        public int ThumbProbeMisses;
        public DateTime LastUsed = DateTime.UtcNow;
        public volatile bool Closed;
        readonly object _devLock = new object();

        public void Open(string deviceId)
        {
            DeviceId = deviceId;
            var dev = (IPortableDevice)W.Create(W.CLSID_DeviceFTM);
            lock (_devLock) Dev = dev;   // published before Open() so a hung Open can be cancelled
            var ci = W.ClientInfo();
            try { dev.Open(deviceId, ci); }
            catch { W.Rel(ci); lock (_devLock) { Dev = null; W.Rel(dev); } Closed = true; throw; }
            W.Rel(ci);
            try
            {
                dev.Content(out Content);
                Content.Properties(out Props);
                Content.Transfer(out Res);
            }
            catch { Close(); throw; }
            Bulk = Props as IPortableDevicePropertiesBulk;
            BulkOk = Bulk != null;
            ThumbKey.fmtid = W.RES_THUMBNAIL; ThumbKey.pid = 0;
            Host.Log("session open (bulk " + (BulkOk ? "yes" : "no") + ")");
        }

        public void CancelPending()
        {
            lock (_devLock)
            {
                if (Dev == null) return;
                try { Dev.Cancel(); Host.Log("device Cancel() issued"); } catch (Exception ex) { Host.Log("Cancel failed: " + ex.Message); }
            }
        }

        // Children before the device, and Close() before the release: the
        // session must end here, not whenever the process happens to exit.
        public void Close()
        {
            Closed = true;
            Bulk = null;
            W.Rel(Res); Res = null;
            W.Rel(Props); Props = null;
            W.Rel(Content); Content = null;
            var d = Dev;
            if (d != null)
            {
                try { d.Close(); } catch { }               // may block; not under the lock so Cancel() can still reach it
                lock (_devLock) { Dev = null; W.Rel(d); }
            }
            Host.Log("session closed");
        }
    }

    // ======================================================================
    // Jobs + scheduler. Every device job is an iterator: each MoveNext() does
    // one bounded step (one folder, one file, one thumbnail). Between steps the
    // scheduler re-picks the most urgent job, so opening a photo in the viewer
    // is served in the middle of a 5000-photo import instead of after it.
    //
    // Because another job may run between two steps, a job must never assume
    // the session it saw last time is still open: it re-validates with
    // Scheduler.Live() after every yield.
    // ======================================================================
    class Job
    {
        public readonly long Id;
        public readonly string Op;
        public readonly Dictionary<string, object> A;
        public int Pri;               // 0 interactive, 1 visible thumbnails, 2 background
        public long Turn;             // round-robin order within a priority
        public bool HandlesCancel;    // delete: on cancel, stop and still report what happened
        public bool Picked;           // the worker has taken it; Cancel() must not drop it anymore
        public Session Sess;          // the session this job last used
        public readonly Stopwatch Age = Stopwatch.StartNew();   // since enqueue
        public long StartedMs = -1;
        public IEnumerator<bool> It;
        public Dictionary<string, object> Result;
        public volatile bool Cancelled;
        public int StallLevel;        // 0 fine, 1 slow, 2 very slow; guarded by Scheduler._stallLk

        public Job(long id, string op, Dictionary<string, object> a)
        {
            Id = id; Op = op; A = a;
            switch (op)
            {
                case "preview": case "delete": case "storage": case "diag": Pri = 0; break;
                case "thumbs": Pri = 1; break;
                case "release": Pri = 3; break;
                default: Pri = 2; break;   // list, copy
            }
            string p = Arg.Str(a, "prio", null);
            if (p == "high") Pri = 0; else if (p == "normal") Pri = 1; else if (p == "low") Pri = 2;
            HandlesCancel = op == "delete";
        }

        public string Device { get { return Arg.Str(A, "device", ""); } }
        public void Check() { if (Cancelled) throw new BridgeError("CANCELLED", "cancelled"); }
    }

    class Scheduler
    {
        readonly List<Job> _q = new List<Job>();
        readonly object _lk = new object();
        readonly object _stallLk = new object();
        long _turn;
        volatile Job _cur;
        volatile Session _sess;
        volatile Session _opening;     // a session whose Open() is in progress (watchdog can cancel it)
        long _closingSince;            // ticks; 0 = not closing. Close() can hang on a wedged device.
        Thread _worker, _dog;
        volatile bool _stop;
        int _closeStall;               // 1 once a hanging Close() was reported
        long _beat = DateTime.UtcNow.Ticks;
        const int IdleCloseMs = 12000;

        public void Start()
        {
            _worker = new Thread(WorkerLoop, 16 * 1024 * 1024);
            _worker.SetApartmentState(ApartmentState.MTA);
            _worker.IsBackground = true;
            _worker.Start();
            _dog = new Thread(DogLoop);
            _dog.SetApartmentState(ApartmentState.MTA);
            _dog.IsBackground = true;
            _dog.Start();
        }

        public void Stop(int ms)
        {
            _stop = true;
            lock (_lk) Monitor.PulseAll(_lk);
            var j = _cur; if (j != null) j.Cancelled = true;
            if (!_worker.Join(ms / 2))
            {
                CancelActive();
                _worker.Join(ms / 2);
            }
        }

        void CancelActive()
        {
            var s = _sess ?? _opening;
            if (s != null) s.CancelPending();
        }

        public void Enqueue(Job j)
        {
            lock (_lk) { j.Turn = ++_turn; _q.Add(j); Monitor.PulseAll(_lk); }
        }

        public void Cancel(long id)
        {
            Job dropped = null;
            lock (_lk)
            {
                foreach (var j in _q)
                {
                    if (j.Id != id) continue;
                    j.Cancelled = true;
                    if (!j.Picked) dropped = j;   // never started: drop it now
                    break;
                }
                if (dropped != null) _q.Remove(dropped);
            }
            if (dropped != null) Host.Fail(dropped.Id, "CANCELLED", "cancelled");
        }

        // Called from every long-running loop: proves to the watchdog that the
        // device is still answering. Stall/unstall are sent under one lock so
        // the UI never sees them out of order.
        public void Beat()
        {
            Interlocked.Exchange(ref _beat, DateTime.UtcNow.Ticks);
            var j = _cur;
            if (j == null || j.StallLevel == 0) return;
            lock (_stallLk)
            {
                if (j.StallLevel == 0) return;
                j.StallLevel = 0;
                var m = new Dictionary<string, object>(); m["type"] = "unstall"; m["id"] = j.Id; m["op"] = j.Op;
                Host.Send(m);
            }
        }

        Job Pick()
        {
            Job best = null;
            foreach (var j in _q)
                if (best == null || j.Pri < best.Pri || (j.Pri == best.Pri && j.Turn < best.Turn)) best = j;
            return best;
        }

        void WorkerLoop()
        {
            try
            {
                while (!_stop)
                {
                    Job j;
                    lock (_lk)
                    {
                        j = Pick();
                        if (j == null) Monitor.Wait(_lk, 1000);
                        else { j.Turn = ++_turn; j.Picked = true; }
                    }
                    if (j == null)
                    {
                        var s = _sess;
                        if (s != null && (DateTime.UtcNow - s.LastUsed).TotalMilliseconds > IdleCloseMs) CloseSession();
                        continue;
                    }
                    RunStep(j);
                }
            }
            finally
            {
                lock (_lk)
                {
                    foreach (var j in _q) { try { if (j.It != null) j.It.Dispose(); } catch { } Host.Fail(j.Id, "CANCELLED", "bridge stopping"); }
                    _q.Clear();
                }
                CloseSession();
            }
        }

        void RunStep(Job j)
        {
            bool more = false; Exception fail = null;
            _cur = j;
            Beat();
            try
            {
                if (j.Cancelled && !j.HandlesCancel) j.Check();
                if (j.It == null)
                {
                    // Tell the UI the job is actually running now, so a queued
                    // task can say "waiting for the phone" instead of looking hung.
                    j.StartedMs = j.Age.ElapsedMilliseconds;
                    Host.Event(j.Id, "started", null);
                    if (j.Op != "thumbs" || j.StartedMs > 3000) Host.Log("job " + j.Id + " " + j.Op + " start (queued " + j.StartedMs + " ms)");
                    j.It = Jobs.Create(j, this).GetEnumerator();
                }
                more = j.It.MoveNext();
            }
            catch (Exception ex) { fail = ex; }
            finally { _cur = null; var s = _sess; if (s != null) s.LastUsed = DateTime.UtcNow; }

            if (more && fail == null) return;
            lock (_lk) _q.Remove(j);
            try { if (j.It != null) j.It.Dispose(); } catch { }

            long ran = j.Age.ElapsedMilliseconds - Math.Max(0, j.StartedMs);
            if (fail == null)
            {
                if (j.Op != "thumbs" || ran > 5000) Host.Log("job " + j.Id + " " + j.Op + " done in " + ran + " ms");
                Host.Done(j.Id, j.Result);
                return;
            }
            string code = Err.Code(fail);
            // An abort we did not ask for is the phone's MTP stack resetting
            // itself (seen right after recovering from a wedge). Retrying works.
            if (code == "CANCELLED" && !j.Cancelled) code = "DEVICE_RESET";
            Host.Log("job " + j.Id + " " + j.Op + " failed: " + code + " " + Err.Describe(fail));
            // Answer first: closing a wedged device can itself block.
            Host.Fail(j.Id, code, Err.Describe(fail));
            // Only close the session this job was actually using -- a job that
            // failed on an already-replaced session must not kill the new one.
            if ((Err.IsDeviceLevel(code) || code == "TIMEOUT") && j.Sess != null && j.Sess == _sess) CloseSession();
        }

        public Session EnsureSession(Job j)
        {
            string key = j.Device;
            var s = _sess;
            if (s != null && !s.Closed && (key == "" || string.Equals(s.DeviceId, key, StringComparison.OrdinalIgnoreCase))) { s.LastUsed = DateTime.UtcNow; j.Sess = s; return s; }
            string devId = Devices.Resolve(key);
            if (devId == null) throw new BridgeError("NO_DEVICE", "device not connected");
            if (s != null && !s.Closed && string.Equals(s.DeviceId, devId, StringComparison.OrdinalIgnoreCase)) { j.Sess = s; return s; }
            CloseSession();
            Exception last = null;
            // A session that just ended (ours, a previous helper's, Explorer's)
            // can take a few seconds to be released by the driver, so a refused
            // open is retried.
            for (int attempt = 0; attempt < 6; attempt++)
            {
                j.Check();
                Beat();
                var ns = new Session();
                _opening = ns;
                try { ns.Open(devId); _sess = ns; j.Sess = ns; return ns; }
                catch (Exception ex)
                {
                    last = ex;
                    string c = Err.Code(ex);
                    Host.Log("open attempt " + (attempt + 1) + " failed: " + Err.Describe(ex));
                    if (j.Cancelled || (c != "DEVICE_BUSY" && c != "DEVICE_ERROR" && c != "ACCESS_DENIED")) break;
                    Thread.Sleep(500 + attempt * 300);
                }
                finally { _opening = null; }
            }
            j.Check();
            throw last ?? new BridgeError("DEVICE_ERROR", "could not open device");
        }

        // Re-validate a job's session after a yield: if another job closed or
        // replaced it meanwhile, open (or adopt) the current one.
        public Session Live(Job j, Session s)
        {
            if (s != null && !s.Closed && s == _sess) { s.LastUsed = DateTime.UtcNow; return s; }
            return EnsureSession(j);
        }

        public void CloseSession()
        {
            var s = _sess; _sess = null;
            if (s == null) return;
            Interlocked.Exchange(ref _closingSince, DateTime.UtcNow.Ticks);
            try { s.Close(); } catch { }
            finally
            {
                Interlocked.Exchange(ref _closingSince, 0);
                if (Interlocked.Exchange(ref _closeStall, 0) != 0)
                {
                    var m = new Dictionary<string, object>(); m["type"] = "unstall"; m["id"] = 0; m["op"] = "close";
                    Host.Send(m);
                }
            }
        }

        // Stall handling. A device call that goes quiet is REPORTED, never
        // cancelled: on Android (Huawei, verified) an aborted MTP transaction
        // wedges the phone until it is replugged, whereas a slow call -- a cold
        // scan of a huge folder, a locked phone, another program using the
        // phone -- finishes on its own once the cause goes away. A truly dead
        // connection is ended by replugging, which also makes the blocked call
        // return. So the UI is told twice: "slow, keep it unlocked" at 8 s, and
        // "replug if nothing changes" at 45 s.
        void DogLoop()
        {
            while (!_stop)
            {
                Thread.Sleep(500);
                long closing = Interlocked.Read(ref _closingSince);
                if (closing != 0 && (DateTime.UtcNow.Ticks - closing) / TimeSpan.TicksPerMillisecond > 10000 && Interlocked.Exchange(ref _closeStall, 1) == 0)
                {
                    Host.Log("watchdog: closing the session is taking long");
                    var m = new Dictionary<string, object>(); m["type"] = "stall"; m["id"] = 0; m["op"] = "close"; m["level"] = 2;
                    Host.Send(m);
                }
                var j = _cur;
                if (j == null) continue;
                long idle = (DateTime.UtcNow.Ticks - Interlocked.Read(ref _beat)) / TimeSpan.TicksPerMillisecond;
                int level = idle > 45000 ? 2 : idle > 8000 ? 1 : 0;
                if (level == 0) continue;
                lock (_stallLk)
                {
                    if (_cur != j || j.StallLevel >= level) continue;
                    j.StallLevel = level;
                    Host.Log("watchdog: job " + j.Id + " (" + j.Op + ") silent for " + idle + " ms");
                    var m = new Dictionary<string, object>(); m["type"] = "stall"; m["id"] = j.Id; m["op"] = j.Op; m["ms"] = idle; m["level"] = level;
                    Host.Send(m);
                }
            }
        }
    }

    // ======================================================================
    // The device jobs.
    // ======================================================================
    static class Jobs
    {
        public static IEnumerable<bool> Create(Job j, Scheduler s)
        {
            switch (j.Op)
            {
                case "list": return List(j, s);
                case "thumbs": return Thumbs(j, s);
                case "preview": return Preview(j, s);
                case "copy": return Copy(j, s);
                case "delete": return Delete(j, s);
                case "storage": return StorageJob(j, s);
                case "diag": return Diag(j, s);
                case "release": return Release(j, s);
                case "bench": return Bench(j, s);
            }
            throw new BridgeError("BAD_OP", j.Op);
        }

        static IEnumerable<bool> Release(Job j, Scheduler s)
        {
            s.CloseSession();
            j.Result = new Dictionary<string, object>();
            yield break;
        }

        // ---- media filters ------------------------------------------------
        static readonly HashSet<string> ImageExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".heic",".heif",".hif",".jpg",".jpeg",".png",".gif",".dng",".tif",".tiff",".bmp",".webp",".avif",
            ".cr2",".cr3",".nef",".arw",".raf",".orf",".rw2"
        };
        static readonly HashSet<string> VideoExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".mov",".mp4",".m4v",".avi",".3gp",".mkv",".webm",".mts"
        };
        public static string Ext(string name)
        {
            if (string.IsNullOrEmpty(name)) return "";
            int d = name.LastIndexOf('.');
            return d < 0 ? "" : name.Substring(d).ToLowerInvariant();
        }
        public static bool IsVideoExt(string ext) { return VideoExt.Contains(ext); }
        // ".heic" from "HEIC"/"heic"; "" unless it is a plain short extension.
        static string SafeExt(string e)
        {
            e = (e ?? "").Trim().TrimStart('.').ToLowerInvariant();
            if (e.Length == 0 || e.Length > 5) return "";
            foreach (char c in e) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return "";
            return "." + e;
        }

        // Android exposes the WHOLE storage over MTP, mostly app caches, so at a
        // storage's top level we only enter real photo folders, and below that
        // we prune hidden/cache folders. iPhones keep their camera roll either
        // in DCIM or in date folders like "202506_a" right under the storage,
        // hence the 6-digit rule. Do not drop it or iPhones list nothing.
        static readonly HashSet<string> TopFolders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "dcim","pictures","picture","screenshots","screenshot","download","downloads","movies","movie",
            "video","videos","camera","photo","photos","images","image","100apple","100andro"
        };
        static readonly HashSet<string> SkipFolders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "android","tencent","cache","caches","thumbnails","log","logs","temp","tmp","netease","sina"
        };
        static bool AllowTop(string n)
        {
            if (string.IsNullOrEmpty(n)) return false;
            if (n.Length >= 6) { bool six = true; for (int i = 0; i < 6; i++) if (n[i] < '0' || n[i] > '9') { six = false; break; } if (six) return true; }
            return TopFolders.Contains(n);
        }
        static bool Skip(string n) { return string.IsNullOrEmpty(n) || n[0] == '.' || SkipFolders.Contains(n); }

        // ---- property reads -----------------------------------------------
        class ObjInfo { public string Name; public Guid Ct; }

        class BulkCallback : IPortableDevicePropertiesBulkCallback
        {
            public readonly Dictionary<string, ObjInfo> Map = new Dictionary<string, ObjInfo>();
            public readonly ManualResetEvent Done = new ManualResetEvent(false);
            public int Hr;
            public readonly Stopwatch Clock = Stopwatch.StartNew();
            public long FirstProgressMs = -1;
            public int Callbacks;
            public void OnStart(ref Guid ctx) { }
            public void OnProgress(ref Guid ctx, IPortableDeviceValuesCollection results)
            {
                Host.Sched.Beat();
                if (FirstProgressMs < 0) FirstProgressMs = Clock.ElapsedMilliseconds;
                Interlocked.Increment(ref Callbacks);
                try
                {
                    uint n = 0;
                    try { results.GetCount(ref n); } catch { return; }
                    for (uint i = 0; i < n; i++)
                    {
                        IPortableDeviceValues v = null;
                        try { results.GetAt(i, out v); } catch { continue; }
                        try
                        {
                            string oid = W.Str(v, W.OBJECT_ID);
                            if (string.IsNullOrEmpty(oid)) continue;
                            string nm = W.Str(v, W.OBJECT_ORIGINAL_FILE_NAME);
                            if (string.IsNullOrEmpty(nm)) nm = W.Str(v, W.OBJECT_NAME);
                            lock (Map) Map[oid] = new ObjInfo { Name = nm, Ct = W.GuidV(v, W.OBJECT_CONTENT_TYPE) };
                        }
                        finally { W.Rel(v); }
                    }
                }
                finally { W.Rel(results); }   // our RCW's reference only; the caller keeps its own
            }
            public void OnEnd(ref Guid ctx, int hr) { Hr = hr; Done.Set(); }
        }

        static Dictionary<string, ObjInfo> FetchBulk(Session s, Job j, IPortableDeviceKeyCollection keys, List<string> oids)
        { return FetchBulk(s, j, keys, oids, null); }

        static Dictionary<string, ObjInfo> FetchBulk(Session s, Job j, IPortableDeviceKeyCollection keys, List<string> oids, Dictionary<string, object> stats)
        {
            var coll = (IPortableDevicePropVariantCollection)W.Create(W.CLSID_PropVariantCollection);
            try
            {
                foreach (var oid in oids)
                {
                    var pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(oid);
                    try { coll.Add(ref pv); } finally { Marshal.FreeCoTaskMem(pv.p); }
                }
                var cb = new BulkCallback();
                if (stats != null) stats["cb"] = cb;
                Guid ctx;
                s.Bulk.QueueGetValuesByObjectList(coll, keys, cb, out ctx);
                s.Bulk.Start(ref ctx);
                // Wait in slices so a cancel/timeout can abort the bulk read.
                var sw = Stopwatch.StartNew();
                while (!cb.Done.WaitOne(500))
                {
                    if (j.Cancelled || sw.ElapsedMilliseconds > 180000) { try { s.Bulk.Cancel(ref ctx); } catch { } cb.Done.WaitOne(3000); j.Check(); return null; }
                }
                if (cb.Hr < 0 && cb.Map.Count == 0) return null;
                return cb.Map;
            }
            catch (BridgeError) { throw; }
            catch (Exception ex) { Host.Log("bulk read failed: " + Err.Describe(ex)); return null; }
            finally { W.Rel(coll); }
        }

        static Dictionary<string, ObjInfo> FetchProps(Session s, Job j, IPortableDeviceKeyCollection keys, List<string> oids, bool tryBulk)
        {
            var map = new Dictionary<string, ObjInfo>();
            if (oids.Count == 0) return map;
            // Bulk only pays off for a real folder. The device root holds a
            // storage or two, and storages may refuse a property list even when
            // the photo folders below serve it fine -- so don't judge on those,
            // and give up on bulk only after repeated failures.
            if (tryBulk && s.BulkOk && oids.Count >= 8)
            {
                var m = FetchBulk(s, j, keys, oids);
                if (m != null && m.Count > 0)
                {
                    foreach (var kv in m) map[kv.Key] = kv.Value;
                    if (map.Count >= oids.Count) return map;
                }
                else if (++s.BulkFails >= 2) { s.BulkOk = false; Host.Log("bulk reads unsupported here; per-object from now on"); }
            }
            int n = 0;
            foreach (var oid in oids)
            {
                if (map.ContainsKey(oid)) continue;
                if ((++n & 15) == 0) { j.Check(); Host.Sched.Beat(); }
                IPortableDeviceValues v = null;
                try { s.Props.GetValues(oid, keys, out v); }
                catch (Exception ex)
                {
                    // A locked or busy phone fails every object the same way;
                    // swallowing that would end the scan "successfully" but short.
                    string c = Err.Code(ex);
                    if (c == "DISCONNECTED" || c == "CANCELLED" || c == "TIMEOUT" || c == "ACCESS_DENIED" || c == "DEVICE_BUSY") throw;
                    continue;
                }
                try
                {
                    string nm = W.Str(v, W.OBJECT_ORIGINAL_FILE_NAME);
                    if (string.IsNullOrEmpty(nm)) nm = W.Str(v, W.OBJECT_NAME);
                    map[oid] = new ObjInfo { Name = nm, Ct = W.GuidV(v, W.OBJECT_CONTENT_TYPE) };
                }
                finally { W.Rel(v); }
            }
            return map;
        }

        static List<string> Children(Session s, Job j, string parent)
        {
            var oids = new List<string>();
            IEnumPortableDeviceObjectIDs e = null;
            s.Content.EnumObjects(0, parent, null, out e);
            try
            {
                var arr = new string[128];
                while (true)
                {
                    uint got = 0;
                    Array.Clear(arr, 0, arr.Length);   // no stale strings marshalled back in (each would leak)
                    int hr = e.Next((uint)arr.Length, arr, ref got);
                    for (uint i = 0; i < got; i++) oids.Add(arr[i]);
                    if (got == 0 || hr != 0) break;   // S_FALSE (1) = last batch
                    if ((oids.Count & 1023) == 0) { j.Check(); Host.Sched.Beat(); }
                }
            }
            finally { W.Rel(e); }
            return oids;
        }

        static List<object> ReadStorages(Session s, List<string> storageOids)
        {
            var list = new List<object>();
            var keys = W.Keys(W.OBJECT_NAME, W.STORAGE_DESCRIPTION, W.STORAGE_CAPACITY, W.STORAGE_FREE);
            try
            {
                foreach (var oid in storageOids)
                {
                    IPortableDeviceValues v = null;
                    try { s.Props.GetValues(oid, keys, out v); } catch { continue; }
                    try
                    {
                        var o = new Dictionary<string, object>();
                        string name = W.Str(v, W.STORAGE_DESCRIPTION);
                        if (string.IsNullOrEmpty(name)) name = W.Str(v, W.OBJECT_NAME);
                        o["name"] = name ?? "";
                        ulong cap = W.ULong(v, W.STORAGE_CAPACITY, 0), free = W.ULong(v, W.STORAGE_FREE, ulong.MaxValue);
                        if (cap > 0) o["capacity"] = (double)cap;
                        if (free != ulong.MaxValue) o["free"] = (double)free;
                        list.Add(o);
                    }
                    finally { W.Rel(v); }
                }
            }
            finally { W.Rel(keys); }
            return list;
        }

        // ---- list -----------------------------------------------------------
        // A folder is read in chunks, one chunk per step. A cold Android
        // DCIM/Camera holds thousands of photos and takes minutes to describe;
        // as a single step it froze everything queued behind the scan (a
        // delete sat at 0/1 until the whole folder was done).
        const int ListChunk = 200;
        class Frame { public string Oid, Prefix; public bool AtDevice; public List<string> Oids; public int Pos; public List<Frame> Subs; public List<string> StorageOids; }

        static IEnumerable<bool> List(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            int max = (int)Arg.Long(j.A, "max", 0);
            var sw = Stopwatch.StartNew();
            var keys = W.Keys(W.OBJECT_ID, W.OBJECT_ORIGINAL_FILE_NAME, W.OBJECT_NAME, W.OBJECT_CONTENT_TYPE);
            try
            {
                var stack = new Stack<Frame>();
                stack.Push(new Frame { Oid = "DEVICE", Prefix = "", AtDevice = true });
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var batch = new List<object>();
                var lastFlush = Stopwatch.StartNew();
                int media = 0, folders = 0, objects = 0;
                List<object> storages = null;

                while (stack.Count > 0)
                {
                    j.Check();
                    var f = stack.Peek();
                    List<string> chunk;
                    Dictionary<string, ObjInfo> info;
                    try
                    {
                        if (f.Oids == null)
                        {
                            folders++;
                            f.Oids = Children(s, j, f.Oid);
                            f.Subs = new List<Frame>(); f.StorageOids = new List<string>();
                            // Insurance against COM wrappers piling up between
                            // GCs: the driver slows to a crawl when they linger.
                            int before = objects; objects += f.Oids.Count;
                            if ((objects >> 11) != (before >> 11)) { GC.Collect(); GC.WaitForPendingFinalizers(); }
                        }
                        int take = f.AtDevice ? f.Oids.Count : Math.Min(ListChunk, f.Oids.Count - f.Pos);
                        chunk = f.Oids.GetRange(f.Pos, take);
                        f.Pos += take;
                        info = FetchProps(s, j, keys, chunk, !f.AtDevice);
                    }
                    catch (Exception ex)
                    {
                        // One unreadable folder must not sink the whole scan;
                        // a device-level failure still does.
                        string c = Err.Code(ex);
                        if (f.AtDevice || Err.IsDeviceLevel(c) || c == "CANCELLED") throw;
                        Host.Log("skipping folder '" + f.Prefix + "': " + Err.Describe(ex));
                        stack.Pop();
                        continue;
                    }
                    foreach (var oid in chunk)
                    {
                        if (max > 0 && media >= max) break;
                        ObjInfo oi;
                        if (!info.TryGetValue(oid, out oi)) continue;
                        string nm = string.IsNullOrEmpty(oi.Name) ? oid : oi.Name;
                        if (oi.Ct == W.CT_FOLDER || oi.Ct == W.CT_FUNCTIONAL)
                        {
                            if (f.AtDevice) { f.StorageOids.Add(oid); f.Subs.Add(new Frame { Oid = oid, Prefix = "", AtDevice = false }); continue; }
                            if (f.Prefix.Length == 0) { if (!AllowTop(nm)) continue; }
                            else if (Skip(nm)) continue;
                            f.Subs.Add(new Frame { Oid = oid, Prefix = f.Prefix.Length == 0 ? nm : f.Prefix + "/" + nm, AtDevice = false });
                            continue;
                        }
                        if (f.AtDevice) continue;
                        string ext = Ext(nm);
                        bool video = VideoExt.Contains(ext);
                        if (!video && !ImageExt.Contains(ext)) continue;
                        string id = f.Prefix.Length == 0 ? nm : f.Prefix + "/" + nm;
                        // Two storages (internal + SD card) can hold the same
                        // relative path; ids must stay unique.
                        if (!seen.Add(id)) { id = id + "|" + oid; seen.Add(id); }
                        var it = new Dictionary<string, object>();
                        it["id"] = id; it["oid"] = oid; it["name"] = nm; it["folder"] = f.Prefix;
                        it["ext"] = ext.TrimStart('.'); it["kind"] = video ? "video" : "image";
                        batch.Add(it);
                        media++;
                    }
                    if (f.Pos >= f.Oids.Count)
                    {
                        stack.Pop();
                        if (f.AtDevice)
                        {
                            storages = ReadStorages(s, f.StorageOids);
                            // No storage = the phone has not granted access yet: an
                            // untrusted / locked iPhone, or Android in "charge only".
                            if (f.StorageOids.Count == 0) throw new BridgeError("NO_STORAGE", "device exposes no storage");
                            var ev = new Dictionary<string, object>(); ev["storages"] = storages;
                            Host.Event(j.Id, "storages", ev);
                        }
                        for (int i = f.Subs.Count - 1; i >= 0; i--) stack.Push(f.Subs[i]);
                    }

                    if (batch.Count >= 400 || (batch.Count > 0 && lastFlush.ElapsedMilliseconds > 600))
                    {
                        var ev = new Dictionary<string, object>(); ev["items"] = batch; ev["count"] = media; ev["folder"] = f.Prefix;
                        Host.Event(j.Id, "items", ev);
                        batch = new List<object>(); lastFlush.Restart();
                    }
                    else if (lastFlush.ElapsedMilliseconds > 600)
                    {
                        var ev = new Dictionary<string, object>(); ev["count"] = media; ev["folder"] = f.Prefix;
                        Host.Event(j.Id, "progress", ev);
                        lastFlush.Restart();
                    }
                    if (max > 0 && media >= max) break;
                    yield return true;
                    s = sch.Live(j, s);   // another job may have closed or replaced the session
                }
                if (batch.Count > 0)
                {
                    var ev = new Dictionary<string, object>(); ev["items"] = batch; ev["count"] = media;
                    Host.Event(j.Id, "items", ev);
                }
                Host.Log("list: " + media + " media in " + folders + " folders, " + sw.ElapsedMilliseconds + " ms (bulk " + (s.BulkOk ? "on" : "off") + ")");
                var r = new Dictionary<string, object>();
                r["count"] = media; r["folders"] = folders; r["ms"] = sw.ElapsedMilliseconds; r["bulk"] = s.BulkOk;
                r["storages"] = storages ?? new List<object>();
                j.Result = r;
            }
            finally { W.Rel(keys); }
        }

        static IEnumerable<bool> StorageJob(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            var r = new Dictionary<string, object>();
            r["storages"] = ReadStorages(s, Children(s, j, "DEVICE"));
            j.Result = r;
            yield break;
        }

        // ---- transfers --------------------------------------------------
        // Streams one resource to disk through a ".part" file, so a reader
        // never sees a half-written file and a failure leaves nothing behind.
        static long Transfer(Session s, Job j, string oid, PROPERTYKEY key, string outPath, long expected, Action<long> onBytes)
        {
            string part = outPath + ".part";
            ComTypes.IStream stream = null;
            long total = 0;
            try
            {
                uint optimal = 0;
                s.Res.GetStream(oid, ref key, 0, ref optimal, out stream);
                int bufSize = optimal >= 16384 && optimal <= (8u << 20) ? (int)optimal : 262144;
                var buf = new byte[bufSize];
                IntPtr pcb = Marshal.AllocHGlobal(4);
                try
                {
                    using (var fs = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                    {
                        var tick = Stopwatch.StartNew();
                        while (true)
                        {
                            j.Check();
                            Marshal.WriteInt32(pcb, 0);
                            stream.Read(buf, buf.Length, pcb);
                            int r = Marshal.ReadInt32(pcb);
                            if (r <= 0) break;
                            fs.Write(buf, 0, r);
                            total += r;
                            Host.Sched.Beat();
                            if (onBytes != null && tick.ElapsedMilliseconds > 250) { onBytes(total); tick.Restart(); }
                        }
                    }
                }
                finally { Marshal.FreeHGlobal(pcb); }
                // A cancelled Read may come back as a clean end-of-stream;
                // never commit what is then only part of the file.
                j.Check();
                if (total <= 0) throw new BridgeError("EMPTY", "device returned no data");
                // NOT compared with `expected`: iPhones set to "Transfer to Mac
                // or PC: Automatic" transcode HEIC to JPEG on the fly, so the
                // delivered size legitimately differs from the object size.
                if (File.Exists(outPath)) File.Delete(outPath);
                File.Move(part, outPath);
            }
            catch { W.Rel(stream); stream = null; TryDelete(part); throw; }
            finally { W.Rel(stream); }
            return total;
        }

        static byte[] ReadSmall(Session s, string oid, PROPERTYKEY key)
        {
            ComTypes.IStream stream = null;
            try
            {
                uint optimal = 0;
                s.Res.GetStream(oid, ref key, 0, ref optimal, out stream);
                var ms = new MemoryStream();
                var buf = new byte[optimal >= 4096 && optimal <= (1u << 20) ? (int)optimal : 65536];
                IntPtr pcb = Marshal.AllocHGlobal(4);
                try
                {
                    while (true)
                    {
                        Marshal.WriteInt32(pcb, 0);
                        stream.Read(buf, buf.Length, pcb);
                        int r = Marshal.ReadInt32(pcb);
                        if (r <= 0) break;
                        ms.Write(buf, 0, r);
                        if (ms.Length > (16 << 20)) break;   // not a thumbnail
                    }
                }
                finally { Marshal.FreeHGlobal(pcb); }
                return ms.ToArray();
            }
            finally { W.Rel(stream); }
        }

        public static void TryDelete(string p) { try { if (p != null && File.Exists(p)) File.Delete(p); } catch { } }

        static void WriteAtomic(string path, byte[] data)
        {
            string tmp = path + ".part";
            try
            {
                File.WriteAllBytes(tmp, data);
                if (File.Exists(path)) File.Delete(path);
                File.Move(tmp, path);
            }
            catch { TryDelete(tmp); throw; }
        }

        static bool LooksLikeImage(byte[] b)
        {
            if (b == null || b.Length < 64) return false;
            if (b[0] == 0xFF && b[1] == 0xD8) return true;                              // JPEG
            if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return true; // PNG
            if (b[0] == 0x42 && b[1] == 0x4D) return true;                              // BMP
            return false;
        }

        // The thumbnail resource key differs between devices; take it from the
        // objects themselves (prefer the standard WPD_RESOURCE_THUMBNAIL).
        static bool ResolveThumbKey(Session s, string oid)
        {
            if (s.ThumbKeyResolved) return true;
            if (s.ThumbProbeMisses > 16) return false;
            IPortableDeviceKeyCollection keys = null;
            try { s.Res.GetSupportedResources(oid, out keys); }
            catch { s.ThumbProbeMisses++; return false; }
            try
            {
                uint n = 0; keys.GetCount(ref n);
                PROPERTYKEY other = new PROPERTYKEY(); bool haveOther = false;
                for (uint i = 0; i < n; i++)
                {
                    PROPERTYKEY k; keys.GetAt(i, out k);
                    if (k.fmtid == W.RES_THUMBNAIL) { s.ThumbKey = k; s.ThumbKeyResolved = true; break; }
                    if (k.fmtid != W.RES_DEFAULT && !haveOther) { other = k; haveOther = true; }
                }
                if (!s.ThumbKeyResolved && haveOther) { s.ThumbKey = other; s.ThumbKeyResolved = true; }
                if (s.ThumbKeyResolved) Host.Log("thumbnail key " + s.ThumbKey.fmtid + ":" + s.ThumbKey.pid);
                else s.ThumbProbeMisses++;
                return s.ThumbKeyResolved;
            }
            finally { W.Rel(keys); }
        }

        // ---- thumbs ---------------------------------------------------------
        // Phase 1: the device's own embedded thumbnail (~50 ms, no decoding;
        // HEIC photos come back as JPEG). Phase 2, for files without one (PNG
        // screenshots, re-encoded chat images, some HEICs): pull the full file
        // and let the Windows codecs render it. Videos skip phase 2 -- a full
        // transfer just for a grid tile is too expensive.
        static IEnumerable<bool> Thumbs(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            var items = Arg.List(j.A, "items");
            int size = (int)Arg.Long(j.A, "size", 320);
            bool render = Arg.Bool(j.A, "render", true);
            var phase2 = new List<Dictionary<string, object>>();
            int ok = 0;
            foreach (var it in items)
            {
                j.Check();
                string id = Arg.Str(it, "id", ""), oid = Arg.Str(it, "oid", ""), outp = Arg.Str(it, "out", "");
                if (oid == "" || outp == "") continue;
                bool done = false;
                if (File.Exists(outp) && new FileInfo(outp).Length > 0) done = true;
                else
                {
                    try
                    {
                        if (ResolveThumbKey(s, oid))
                        {
                            var data = ReadSmall(s, oid, s.ThumbKey);
                            if (LooksLikeImage(data)) { Directory.CreateDirectory(Path.GetDirectoryName(outp)); WriteAtomic(outp, data); done = true; }
                        }
                    }
                    catch (Exception ex)
                    {
                        string c = Err.Code(ex);
                        if (c == "DISCONNECTED" || c == "CANCELLED" || c == "TIMEOUT") throw;
                    }
                }
                if (done) { ok++; ThumbEvent(j, id, outp); }
                else if (render && !IsVideoExt("." + Arg.Str(it, "ext", "").ToLowerInvariant()) && !IsVideoExt(Ext(id))) phase2.Add(it);
                else ThumbEvent(j, id, null);
                yield return true;
                s = sch.Live(j, s);   // another job may have closed or replaced the session
            }
            bool renderBroken = false;
            foreach (var it in phase2)
            {
                j.Check();
                string id = Arg.Str(it, "id", ""), oid = Arg.Str(it, "oid", ""), outp = Arg.Str(it, "out", "");
                if (renderBroken) { ThumbEvent(j, id, null); continue; }
                // Extension from the item, not the id: de-duplicated ids look
                // like "a/IMG_1.HEIC|o3E8" and would make an invalid file name.
                string ext = SafeExt(Arg.Str(it, "ext", ""));
                if (ext == "") ext = SafeExt(Ext(id).TrimStart('.'));
                if (ext == "") ext = ".bin";
                string src = outp + ".src" + ext;
                string got = null;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(outp));
                    var key = new PROPERTYKEY(); key.fmtid = W.RES_DEFAULT; key.pid = 0;
                    Transfer(s, j, oid, key, src, 0, null);
                    Render.ToJpeg(src, size, outp, j);
                    got = outp; ok++;
                }
                catch (Exception ex)
                {
                    string c = Err.Code(ex);
                    if (c == "DISCONNECTED" || c == "CANCELLED" || c == "TIMEOUT") { TryDelete(src); throw; }
                    if (c == "RENDER_TIMEOUT") renderBroken = true;   // a hung codec: don't feed it more
                    Host.Log("thumb render failed for " + id + ": " + Err.Describe(ex));
                }
                finally { TryDelete(src); }
                ThumbEvent(j, id, got);
                yield return true;
                s = sch.Live(j, s);   // another job may have closed or replaced the session
            }
            var r = new Dictionary<string, object>(); r["count"] = ok; j.Result = r;
        }
        static void ThumbEvent(Job j, string id, string path)
        {
            var e = new Dictionary<string, object>(); e["itemId"] = id; e["thumb"] = path;
            Host.Event(j.Id, "item", e);
        }

        // ---- preview ----------------------------------------------------------
        static readonly HashSet<string> BrowserReady = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".jpg",".jpeg",".png",".gif",".webp",".bmp",".avif"
        };

        static IEnumerable<bool> Preview(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            var item = Arg.Obj(j.A, "item") ?? new Dictionary<string, object>();
            string oid = Arg.Str(item, "oid", ""), name = Arg.Str(item, "name", ""), id = Arg.Str(item, "id", "");
            string outBase = Arg.Str(j.A, "outBase", "");
            int size = (int)Arg.Long(j.A, "size", 2048);
            if (oid == "" || outBase == "") throw new BridgeError("BAD_ARGS", "preview needs item.oid and outBase");
            string ext = Ext(name); if (ext == "") ext = Ext(id);
            Directory.CreateDirectory(Path.GetDirectoryName(outBase));

            string date = ReadDateIso(s, oid);
            var r = new Dictionary<string, object>();
            if (date != null) r["date"] = date;
            yield return true;   // let something more urgent in before the transfer
            s = sch.Live(j, s);   // another job may have closed or replaced the session

            var key = new PROPERTYKEY(); key.fmtid = W.RES_DEFAULT; key.pid = 0;
            bool video = VideoExt.Contains(ext);
            if (video || BrowserReady.Contains(ext))
            {
                string outp = outBase + ext;
                if (!File.Exists(outp)) Transfer(s, j, oid, key, outp, 0, delegate (long b) { var e = new Dictionary<string, object>(); e["bytes"] = b; Host.Event(j.Id, "progress", e); });
                r["path"] = outp; r["kind"] = video ? "video" : "image";
                j.Result = r;
                yield break;
            }
            // HEIC / RAW / TIFF: render through the Windows codecs.
            string jpg = outBase + ".jpg";
            if (!File.Exists(jpg))
            {
                string src = outBase + ".src" + ext;
                try
                {
                    Transfer(s, j, oid, key, src, 0, delegate (long b) { var e = new Dictionary<string, object>(); e["bytes"] = b; Host.Event(j.Id, "progress", e); });
                    Render.ToJpeg(src, size, jpg, j);
                }
                finally { TryDelete(src); }
            }
            r["path"] = jpg; r["kind"] = "image";
            j.Result = r;
        }

        static string ReadDateIso(Session s, string oid)
        {
            DateTime? d = null;
            var keys = W.Keys(W.OBJECT_DATE_CREATED, W.OBJECT_DATE_MODIFIED);
            IPortableDeviceValues v = null;
            try
            {
                s.Props.GetValues(oid, keys, out v);
                d = W.Date(v, W.OBJECT_DATE_CREATED) ?? W.Date(v, W.OBJECT_DATE_MODIFIED);
            }
            catch (Exception ex)
            {
                string c = Err.Code(ex);
                if (c == "DISCONNECTED" || c == "TIMEOUT") throw;
            }
            finally { W.Rel(v); W.Rel(keys); }
            return d.HasValue ? d.Value.ToString("yyyy-MM-ddTHH:mm:ss") : null;
        }

        // ---- copy -------------------------------------------------------------
        static string UniquePath(string dir, string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            if (name.Trim().Length == 0) name = "photo";
            string p = Path.Combine(dir, name);
            if (!File.Exists(p) && !File.Exists(p + ".part")) return p;
            string b = Path.GetFileNameWithoutExtension(name), x = Path.GetExtension(name);
            for (int n = 1; ; n++)
            {
                p = Path.Combine(dir, b + " (" + n + ")" + x);
                if (!File.Exists(p) && !File.Exists(p + ".part")) return p;
            }
        }

        static IEnumerable<bool> Copy(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            var items = Arg.List(j.A, "items");
            string dest = Arg.Str(j.A, "dest", "");
            bool keepTimes = Arg.Bool(j.A, "keepTimes", true);
            if (dest == "") throw new BridgeError("BAD_ARGS", "copy needs dest");
            Directory.CreateDirectory(dest);
            var dateKeys = W.Keys(W.OBJECT_SIZE, W.OBJECT_DATE_CREATED, W.OBJECT_DATE_MODIFIED);
            int ok = 0, failed = 0, streak = 0; string streakCode = null;
            try
            {
                for (int i = 0; i < items.Count; i++)
                {
                    j.Check();
                    var it = items[i];
                    string id = Arg.Str(it, "id", ""), oid = Arg.Str(it, "oid", ""), name = Arg.Str(it, "name", "");
                    if (name == "") name = Path.GetFileName(id.Replace('/', '\\'));
                    var e = new Dictionary<string, object>();
                    e["itemId"] = id; e["index"] = i;
                    string path = null; string fatal = null;
                    try
                    {
                        if (oid == "") throw new BridgeError("NOT_FOUND", "no object id");
                        long size = 0; DateTime? when = null;
                        IPortableDeviceValues v = null;
                        try
                        {
                            s.Props.GetValues(oid, dateKeys, out v);
                            size = (long)W.ULong(v, W.OBJECT_SIZE, 0);
                            when = W.Date(v, W.OBJECT_DATE_CREATED) ?? W.Date(v, W.OBJECT_DATE_MODIFIED);
                        }
                        catch (Exception ex)
                        {
                            string c = Err.Code(ex);
                            if (c == "DISCONNECTED" || c == "TIMEOUT" || c == "CANCELLED") throw;
                        }
                        finally { W.Rel(v); }

                        path = UniquePath(dest, name);
                        var key = new PROPERTYKEY(); key.fmtid = W.RES_DEFAULT; key.pid = 0;
                        int idx = i; long sz = size;
                        long bytes = Transfer(s, j, oid, key, path, size, delegate (long b)
                        {
                            var pe = new Dictionary<string, object>(); pe["index"] = idx; pe["bytes"] = b; pe["size"] = sz;
                            Host.Event(j.Id, "progress", pe);
                        });
                        if (keepTimes && when.HasValue)
                        {
                            try { File.SetCreationTime(path, when.Value); File.SetLastWriteTime(path, when.Value); } catch { }
                            e["date"] = when.Value.ToString("yyyy-MM-ddTHH:mm:ss");
                        }
                        e["ok"] = true; e["path"] = path; e["bytes"] = bytes;
                        ok++; streak = 0;
                    }
                    catch (Exception ex)
                    {
                        string c = Err.Code(ex);
                        e["ok"] = false; e["code"] = c; e["error"] = Err.Describe(ex);
                        failed++;
                        if (c == "DISCONNECTED" || c == "CANCELLED" || c == "TIMEOUT" || c == "DISK_FULL") fatal = c;
                        // The same device-level failure over and over (locked
                        // phone, revoked trust) means the rest will fail too.
                        if (Err.IsDeviceLevel(c)) { if (c == streakCode) streak++; else { streakCode = c; streak = 1; } }
                        else { streak = 0; streakCode = null; }
                        if (streak >= 4) fatal = c;
                        if (fatal != null && fatal != "DISK_FULL") throw;
                    }
                    finally { Host.Event(j.Id, "item", e); }
                    if (fatal != null) throw new BridgeError(fatal, "copy aborted: " + fatal);
                    yield return true;
                    s = sch.Live(j, s);   // another job may have closed or replaced the session
                }
                var r = new Dictionary<string, object>(); r["copied"] = ok; r["failed"] = failed;
                j.Result = r;
            }
            finally { W.Rel(dateKeys); }
        }

        // ---- delete -----------------------------------------------------------
        // One object per Delete() call, on purpose: a multi-object collection
        // makes some devices (Huawei P30 Pro, verified) return no per-object
        // status at all, and single-object delete is the form proven to really
        // remove photos on both iPhone and Android. Afterwards every object is
        // checked for existence, because some devices answer S_OK and keep the
        // file.
        static IEnumerable<bool> Delete(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            var items = Arg.List(j.A, "items");
            var hrs = new int?[items.Count];
            // This job opts out of the scheduler's cancel pre-check (HandlesCancel):
            // a user cancel stops deleting but still verifies and reports what
            // was already deleted, so the grid matches the phone.
            for (int i = 0; i < items.Count; i++)
            {
                if (j.Cancelled) break;
                string oid = Arg.Str(items[i], "oid", "");
                if (oid == "") continue;
                var pe = new Dictionary<string, object>(); pe["index"] = i; pe["total"] = items.Count;
                Host.Event(j.Id, "progress", pe);
                IPortableDevicePropVariantCollection coll = null, results = null;
                try
                {
                    coll = (IPortableDevicePropVariantCollection)W.Create(W.CLSID_PropVariantCollection);
                    var pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(oid);
                    try { coll.Add(ref pv); } finally { Marshal.FreeCoTaskMem(pv.p); }
                    s.Content.Delete(0, coll, out results);
                    if (results != null)
                    {
                        try
                        {
                            uint rc = 0; results.GetCount(ref rc);
                            if (rc > 0) { PROPVARIANT rv; results.GetAt(0, out rv); if (rv.vt == 10) hrs[i] = (int)(rv.p.ToInt64() & 0xFFFFFFFF); else hrs[i] = 0; }
                        }
                        catch { }
                    }
                }
                catch (Exception ex)
                {
                    hrs[i] = ex.HResult;
                    string c = Err.Code(ex);
                    if (c == "DISCONNECTED" || c == "TIMEOUT") { W.Rel(results); W.Rel(coll); throw; }
                }
                finally { W.Rel(results); W.Rel(coll); }
                Host.Sched.Beat();
                yield return true;
                s = sch.Live(j, s);   // another job may have closed or replaced the session
            }
            Thread.Sleep(250);   // let the device apply the deletes before asking about them
            var keys = W.Keys(W.OBJECT_NAME);
            var res = new List<object>();
            int okCount = 0;
            bool unreachable = false;   // once the device stops answering, stop asking
            try
            {
                for (int i = 0; i < items.Count; i++)
                {
                    string id = Arg.Str(items[i], "id", ""), oid = Arg.Str(items[i], "oid", "");
                    bool exists = true, unknown = false;
                    if (oid != "" && unreachable) unknown = true;
                    else if (oid != "")
                    {
                        IPortableDeviceValues v = null;
                        try { s.Props.GetValues(oid, keys, out v); exists = W.Str(v, W.OBJECT_NAME) != null; }
                        catch (Exception ex)
                        {
                            // Asking about a deleted object fails (the exact
                            // HRESULT varies by driver) -- that means "gone".
                            // But a locked, busy or vanished device fails the
                            // same call for objects that are still there.
                            string c = Err.Code(ex);
                            if (c == "ACCESS_DENIED" || c == "DEVICE_BUSY" || c == "DISCONNECTED" || c == "TIMEOUT" || c == "CANCELLED") { unknown = true; unreachable = true; }
                            else exists = false;
                        }
                        finally { W.Rel(v); }
                    }
                    var o = new Dictionary<string, object>();
                    o["itemId"] = id;
                    if (unknown) { o["ok"] = false; o["code"] = "UNKNOWN"; }
                    else if (!exists) { o["ok"] = true; okCount++; }
                    else
                    {
                        o["ok"] = false;
                        if (oid == "") o["code"] = "NOT_FOUND";
                        else if (!hrs[i].HasValue) o["code"] = j.Cancelled ? "CANCELLED" : "NO_STATUS";
                        else if (hrs[i].Value == 0) o["code"] = "STILL_THERE";
                        else { o["code"] = "REFUSED"; o["hr"] = "0x" + ((uint)hrs[i].Value).ToString("X8"); }
                    }
                    res.Add(o);
                    Host.Event(j.Id, "item", new Dictionary<string, object>(o));
                    if ((i & 7) == 0) Host.Sched.Beat();
                }
            }
            finally { W.Rel(keys); }
            var r = new Dictionary<string, object>(); r["results"] = res; r["deleted"] = okCount;
            j.Result = r;
        }

        // ---- bench (read-only diagnostics) ---------------------------------------
        // Measures, on the biggest photo folder, how this device answers the
        // three ways of reading object properties, so the scan strategy can be
        // chosen from data: handle enumeration, one-by-one reads, and bulk
        // reads (incl. whether bulk reports progress or stays silent until the
        // end -- a silent multi-minute call is indistinguishable from a hang).
        static IEnumerable<bool> Bench(Job j, Scheduler sch)
        {
            var s = sch.EnsureSession(j);
            var r = new Dictionary<string, object>();
            var keys = W.Keys(W.OBJECT_ID, W.OBJECT_ORIGINAL_FILE_NAME, W.OBJECT_NAME, W.OBJECT_CONTENT_TYPE);
            try
            {
                string path = Arg.Str(j.A, "path", "DCIM/Camera");
                string cur = "DEVICE";
                var sw = Stopwatch.StartNew();
                var roots = Children(s, j, cur);
                if (roots.Count == 0) throw new BridgeError("NO_STORAGE", "no storage");
                cur = roots[0];
                foreach (var part in path.Split('/'))
                {
                    var kids = Children(s, j, cur);
                    var info = FetchProps(s, j, keys, kids, false);
                    string hit = null;
                    foreach (var kv in info) if (string.Equals(kv.Value.Name, part, StringComparison.OrdinalIgnoreCase)) { hit = kv.Key; break; }
                    if (hit == null) throw new BridgeError("NOT_FOUND", "folder not found: " + part);
                    cur = hit;
                }
                r["navigateMs"] = sw.ElapsedMilliseconds;
                Host.Log("bench: folder " + path + " found in " + sw.ElapsedMilliseconds + " ms");
                yield return true;

                sw.Restart();
                var oids = Children(s, j, cur);
                r["count"] = oids.Count; r["enumMs"] = sw.ElapsedMilliseconds;
                Host.Log("bench: enumerated " + oids.Count + " handles in " + sw.ElapsedMilliseconds + " ms");
                Host.Event(j.Id, "progress", new Dictionary<string, object>(r));
                yield return true;

                int n = Math.Min(200, oids.Count / 3);
                if (n < 10) { r["note"] = "folder too small"; j.Result = r; yield break; }

                sw.Restart();
                var a = FetchProps(s, j, keys, oids.GetRange(0, n), false);
                r["perObjectN"] = n; r["perObjectMs"] = sw.ElapsedMilliseconds; r["perObjectGot"] = a.Count;
                Host.Log("bench: per-object " + a.Count + "/" + n + " in " + sw.ElapsedMilliseconds + " ms");
                Host.Event(j.Id, "progress", new Dictionary<string, object>(r));
                yield return true;

                if (s.Bulk != null)
                {
                    var st = new Dictionary<string, object>();
                    sw.Restart();
                    var b = FetchBulk(s, j, keys, oids.GetRange(n, n), st);
                    var cb = st.ContainsKey("cb") ? (BulkCallback)st["cb"] : null;
                    r["bulkN"] = n; r["bulkMs"] = sw.ElapsedMilliseconds; r["bulkGot"] = b == null ? -1 : b.Count;
                    if (cb != null) { r["bulkFirstProgressMs"] = cb.FirstProgressMs; r["bulkCallbacks"] = cb.Callbacks; r["bulkHr"] = "0x" + ((uint)cb.Hr).ToString("X8"); }
                    Host.Log("bench: bulk " + r["bulkGot"] + "/" + n + " in " + sw.ElapsedMilliseconds + " ms, first progress " + (cb != null ? cb.FirstProgressMs : -1) + " ms, callbacks " + (cb != null ? cb.Callbacks : 0));
                    Host.Event(j.Id, "progress", new Dictionary<string, object>(r));
                }
                else r["bulk"] = "unsupported";
            }
            finally { W.Rel(keys); }
            j.Result = r;
        }

        // ---- diag ---------------------------------------------------------------
        static IEnumerable<bool> Diag(Job j, Scheduler sch)
        {
            var r = new Dictionary<string, object>();
            r["version"] = Host.Version;
            r["clr"] = Environment.Version.ToString();
            r["os"] = Host.OsVersion();
            r["x64"] = Environment.Is64BitProcess;
            var devs = new List<object>();
            foreach (var d in Devices.Enumerate())
            {
                var o = new Dictionary<string, object>(); o["name"] = d.Name; o["mfr"] = d.Mfr; o["desc"] = d.Desc; o["kind"] = d.Kind;
                devs.Add(o);
            }
            r["devices"] = devs;
            r["usb"] = Usb.Probe();
            if (j.Device != "")
            {
                try
                {
                    var s = sch.EnsureSession(j);
                    var keys = W.Keys(W.DEVICE_MODEL, W.DEVICE_FIRMWARE, W.DEVICE_PROTOCOL);
                    IPortableDeviceValues v = null;
                    try
                    {
                        s.Props.GetValues("DEVICE", keys, out v);
                        r["model"] = W.Str(v, W.DEVICE_MODEL);
                        r["firmware"] = W.Str(v, W.DEVICE_FIRMWARE);
                        r["protocol"] = W.Str(v, W.DEVICE_PROTOCOL);
                    }
                    catch (Exception ex) { r["deviceProps"] = Err.Describe(ex); }
                    finally { W.Rel(v); W.Rel(keys); }
                    r["bulk"] = s.BulkOk;
                    r["storages"] = ReadStorages(s, Children(s, j, "DEVICE"));
                    if (s.ThumbKeyResolved) r["thumbKey"] = s.ThumbKey.fmtid + ":" + s.ThumbKey.pid;
                }
                catch (Exception ex) { r["session"] = Err.Code(ex) + " " + Err.Describe(ex); }
            }
            j.Result = r;
            yield break;
        }
    }

    // ======================================================================
    // Local rendering through the Windows shell (IShellItemImageFactory) --
    // the same codecs Explorer uses, so HEIC works wherever the HEIF/HEVC
    // extensions are installed, and EXIF orientation is honoured. Runs on its
    // own STA thread, as shell objects expect.
    // ======================================================================
    static class Render
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
            [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);

        [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItemImageFactory { void GetImage([In, MarshalAs(UnmanagedType.Struct)] SIZE size, [In] int flags, out IntPtr phbm); }
        [StructLayout(LayoutKind.Sequential)]
        struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

        class Req { public string Src, Out; public int Size; public Exception Err; public readonly ManualResetEvent Done = new ManualResetEvent(false); }
        // One STA render thread with its own queue. A codec that hangs takes
        // only its own thread down: on timeout we abandon it (and its queue)
        // and the next render starts a fresh one.
        class Worker { public readonly Queue<Req> Q = new Queue<Req>(); public Thread T; }
        static readonly object L = new object();
        static Worker _w;

        public static void ToJpeg(string src, int size, string outJpg, Job j)
        {
            var r = new Req { Src = Path.GetFullPath(src), Out = outJpg, Size = size };
            Worker w;
            lock (L)
            {
                if (_w == null)
                {
                    var nw = new Worker();
                    nw.T = new Thread(delegate () { Loop(nw); });
                    nw.T.SetApartmentState(ApartmentState.STA);
                    nw.T.IsBackground = true;
                    nw.T.Start();
                    _w = nw;
                }
                w = _w;
                w.Q.Enqueue(r);
                Monitor.PulseAll(L);
            }
            // A big HEIC can take a second or two to decode; keep the watchdog fed.
            var sw = Stopwatch.StartNew();
            while (!r.Done.WaitOne(500))
            {
                Host.Sched.Beat();
                if (sw.ElapsedMilliseconds > 45000)
                {
                    lock (L) { if (_w == w) _w = null; }
                    Host.Log("render thread hung on " + Path.GetFileName(src) + "; replacing it");
                    throw new BridgeError("RENDER_TIMEOUT", "image decoder hung");
                }
            }
            if (r.Err != null) throw new BridgeError("RENDER_FAILED", Err.Describe(r.Err));
        }

        static void Loop(Worker w)
        {
            while (true)
            {
                Req r;
                lock (L) { while (w.Q.Count == 0) Monitor.Wait(L); r = w.Q.Dequeue(); }
                try { Do(r); } catch (Exception ex) { r.Err = ex; }
                r.Done.Set();
            }
        }

        static readonly Guid IID_Factory = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");

        static void Do(Req r)
        {
            object o;
            Guid iid = IID_Factory;
            SHCreateItemFromParsingName(r.Src, IntPtr.Zero, ref iid, out o);
            IntPtr h = IntPtr.Zero;
            try
            {
                // 0x8 SIIGBF_THUMBNAILONLY: a real decode or an error -- never a
                // generic file-type icon passed off as the photo.
                ((IShellItemImageFactory)o).GetImage(new SIZE(r.Size, r.Size), 0x8, out h);
            }
            finally { Marshal.ReleaseComObject(o); }
            if (h == IntPtr.Zero) throw new BridgeError("RENDER_FAILED", "no image");
            try
            {
                using (var bmp = Image.FromHbitmap(h))
                {
                    string tmp = r.Out + ".part";
                    try
                    {
                        var enc = JpegEncoder();
                        if (enc != null)
                        {
                            var ps = new EncoderParameters(1);
                            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
                            bmp.Save(tmp, enc, ps);
                        }
                        else bmp.Save(tmp, ImageFormat.Jpeg);
                        if (File.Exists(r.Out)) File.Delete(r.Out);
                        File.Move(tmp, r.Out);
                    }
                    catch { Jobs.TryDelete(tmp); throw; }
                }
            }
            finally { DeleteObject(h); }
        }

        static ImageCodecInfo _jpeg;
        static ImageCodecInfo JpegEncoder()
        {
            if (_jpeg != null) return _jpeg;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) { _jpeg = c; break; }
            return _jpeg;
        }
    }
}
