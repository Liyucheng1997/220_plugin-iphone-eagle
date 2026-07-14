<#
  iphone.ps1  --  iPhone/iPad photo backend for the Eagle plugin.

  Talks to the connected Apple device through the Windows Shell (the same
  mechanism File Explorer uses to show "Apple iPhone > Internal Storage >
  DCIM"). No .NET SDK, no drivers beyond Apple's own USB driver (installed
  with iTunes / "Apple Devices").

  All output on STDOUT is a single JSON object. Progress / errors go to STDERR
  so STDOUT stays clean JSON for Node to parse.

  Actions:
    -Action devices
    -Action list     [-Device <name>] [-Max <n>]
    -Action thumb    -Device <name> -InputFile <ids.json> -OutDir <dir> [-Size 256]
    -Action copy     -Device <name> -InputFile <ids.json> -Dest <dir>
    -Action delete   -Device <name> -InputFile <ids.json>
    -Action diagnose [-Device <name>]
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('devices', 'list', 'meta', 'thumb', 'preview', 'copy', 'delete', 'diagnose')]
    [string]$Action,

    [string]$Device = '',
    [string]$InputFile = '',
    [string]$Dest = '',
    [string]$OutDir = '',
    [int]$Size = 256,
    [int]$Max = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ---- image / video extensions we treat as "photos" ----
$script:MediaExt = @('.heic', '.heif', '.jpg', '.jpeg', '.png', '.gif', '.dng',
                     '.tiff', '.tif', '.bmp', '.webp', '.mov', '.mp4', '.m4v', '.avi')

function Write-Log([string]$msg) { [Console]::Error.WriteLine($msg) }

function Emit($obj) {
    # PS 5.1: force arrays to stay arrays, emit compact UTF-8 JSON.
    $json = $obj | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.WriteLine($json)
}

function Fail([string]$message) {
    Emit @{ ok = $false; error = $message }
    exit 0
}

# ------------------------------------------------------------------
# Device discovery
# ------------------------------------------------------------------
function Get-Shell { New-Object -ComObject Shell.Application }

# Returns FolderItems in "This PC" that are portable devices (not drive letters,
# not the usual known folders). iPhone/iPad show up here when plugged in + trusted.
function Get-DeviceItems($shell) {
    $thisPC = $shell.NameSpace(0x11)   # ssfDRIVES = This PC
    $result = @()
    if ($null -eq $thisPC) { return $result }
    foreach ($it in $thisPC.Items()) {
        try {
            $p = $it.Path
        } catch { $p = '' }
        # Drive letters look like "C:\". Portable devices have a shell/GUID path.
        if ($p -match '^[A-Za-z]:\\?$') { continue }
        if (-not $it.IsFolder) { continue }
        $result += $it
    }
    return $result
}

function Select-DeviceItem($shell, [string]$wanted) {
    $devices = Get-DeviceItems $shell
    if ($devices.Count -eq 0) { return $null }

    if ($wanted -ne '') {
        foreach ($d in $devices) { if ($d.Name -eq $wanted) { return $d } }
    }
    # Prefer an Apple device by name.
    foreach ($d in $devices) {
        if ($d.Name -match '(?i)iphone|ipad|ipod|apple') { return $d }
    }
    # Otherwise the first portable device.
    return $devices[0]
}

# Depth-first search for a folder named DCIM under the device.
function Find-DcimFolder($folder, [int]$depth) {
    if ($null -eq $folder) { return $null }
    if ($depth -gt 4) { return $null }
    $subs = @()
    foreach ($it in $folder.Items()) {
        if (-not $it.IsFolder) { continue }
        if ($it.Name -match '(?i)^dcim$') {
            try { return $it.GetFolder } catch { return $null }
        }
        $subs += $it
    }
    foreach ($it in $subs) {
        $child = $null
        try { $child = $it.GetFolder } catch { $child = $null }
        $r = Find-DcimFolder $child ($depth + 1)
        if ($null -ne $r) { return $r }
    }
    return $null
}

# Returns the folder to recurse for photos. iPhones expose one storage
# ("Internal Storage"); we descend into it and then collect ALL media by
# extension, regardless of subfolder names. This works whether the device
# uses the classic DCIM/100APPLE layout OR (as some do) date-named folders
# like 202506_a directly under the storage.
function Get-PhotoRoot($deviceFolder) {
    if ($null -eq $deviceFolder) { return $null }
    $folders = @()
    foreach ($it in $deviceFolder.Items()) { if ($it.IsFolder) { $folders += $it } }
    if ($folders.Count -eq 1) {
        try { $s = $folders[0].GetFolder; if ($s) { return $s } } catch {}
    }
    return $deviceFolder
}

function Get-ItemMeta($item) {
    $size = $null; $date = $null; $typeText = $null
    foreach ($key in @('System.Size')) {
        try { $v = $item.ExtendedProperty($key); if ($null -ne $v) { $size = [long]$v; break } } catch {}
    }
    foreach ($key in @('System.ItemDate', 'System.DateModified', 'System.DateCreated')) {
        try { $v = $item.ExtendedProperty($key); if ($null -ne $v) { $date = $v; break } } catch {}
    }
    try { $typeText = $item.ExtendedProperty('System.ItemTypeText') } catch {}
    $dateStr = ''
    if ($null -ne $date) {
        try { $dateStr = ([datetime]$date).ToString('yyyy-MM-ddTHH:mm:ss') } catch { $dateStr = "$date" }
    }
    return @{ size = $size; date = $dateStr; typeText = $typeText }
}

# Recursively collect media files under DCIM. id = path relative to DCIM,
# using '/' separators, e.g. "100APPLE/IMG_0001.HEIC".
function Collect-Media($folder, [string]$prefix, [System.Collections.ArrayList]$acc, [int]$max) {
    # Heartbeat on entering each folder: keeps the Node-side watchdog alive
    # while we traverse many folders (folder-open over MTP can take seconds).
    if ($prefix -ne '') { Write-Log "SCAN $prefix" }
    foreach ($it in $folder.Items()) {
        if ($max -gt 0 -and $acc.Count -ge $max) { return }
        $name = $it.Name
        if ($it.IsFolder) {
            $childPrefix = if ($prefix -eq '') { $name } else { "$prefix/$name" }
            $child = $null
            try { $child = $it.GetFolder } catch { $child = $null }
            if ($null -ne $child) { Collect-Media $child $childPrefix $acc $max }
            continue
        }
        $ext = [System.IO.Path]::GetExtension($name).ToLowerInvariant()
        if ($script:MediaExt -notcontains $ext) { continue }
        $id = if ($prefix -eq '') { $name } else { "$prefix/$name" }
        # NOTE: no per-item metadata here on purpose. Fetching size/date via
        # ExtendedProperty costs ~4 slow MTP round-trips per file, which makes
        # 10k-photo libraries take many minutes. Size/date are fetched lazily
        # (Action 'meta') only for items the user actually looks at.
        [void]$acc.Add([ordered]@{
            id     = $id
            name   = $name
            folder = $prefix
            ext    = $ext.TrimStart('.')
            kind   = if ($ext -in @('.mov', '.mp4', '.m4v', '.avi')) { 'video' } else { 'image' }
        })
        if (($acc.Count % 100) -eq 0) { Write-Log "PROGRESS $($acc.Count)" }
    }
}

# Walk id path from DCIM to the live FolderItem (needed for copy/delete/thumb).
function Resolve-ItemById($dcim, [string]$id) {
    $parts = $id -split '/'
    $cur = $dcim
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
        $next = $null
        foreach ($it in $cur.Items()) {
            if ($it.IsFolder -and $it.Name -eq $parts[$i]) { try { $next = $it.GetFolder } catch {}; break }
        }
        if ($null -eq $next) { return $null }
        $cur = $next
    }
    $leaf = $parts[$parts.Count - 1]
    foreach ($it in $cur.Items()) { if ($it.Name -eq $leaf) { return $it } }
    return $null
}

function Read-Ids([string]$path) {
    if ($path -eq '' -or -not (Test-Path -LiteralPath $path)) { return @() }
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    if ($raw.Trim() -eq '') { return @() }
    $parsed = $raw | ConvertFrom-Json
    return @($parsed)
}

# ------------------------------------------------------------------
# Copy one live item into $destDir via a private staging folder so we
# never hit "file exists" prompts or name collisions. Returns final path.
# CopyHere is async, so we poll for the file to appear and settle.
# ------------------------------------------------------------------
function Copy-One($shell, $item, [string]$destDir) {
    $staging = Join-Path $destDir (".stg_" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        $ns = $shell.NameSpace($staging)
        # 4 = no progress UI, 16 = yes-to-all, 512 = no "confirm new dir"
        $ns.CopyHere($item, 4 -bor 16 -bor 512)

        $staged = Join-Path $staging $item.Name
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $staged) -and $sw.Elapsed.TotalSeconds -lt 300) {
            Start-Sleep -Milliseconds 150
        }
        if (-not (Test-Path -LiteralPath $staged)) { throw "timed out waiting for copy" }

        # Wait until the file size stops changing (copy finished).
        $last = -1
        while ($sw.Elapsed.TotalSeconds -lt 600) {
            $cur = (Get-Item -LiteralPath $staged).Length
            if ($cur -eq $last -and $cur -gt 0) { break }
            $last = $cur
            Start-Sleep -Milliseconds 200
        }

        # Move to final destination with a collision-safe name.
        $finalPath = Join-Path $destDir $item.Name
        if (Test-Path -LiteralPath $finalPath) {
            $base = [System.IO.Path]::GetFileNameWithoutExtension($item.Name)
            $ext  = [System.IO.Path]::GetExtension($item.Name)
            $n = 1
            do { $finalPath = Join-Path $destDir ("$base ($n)$ext"); $n++ } while (Test-Path -LiteralPath $finalPath)
        }
        Move-Item -LiteralPath $staged -Destination $finalPath -Force
        return $finalPath
    } finally {
        try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# Find and invoke the shell "delete" verb, handling localized labels.
$script:DeleteLabels = @('delete', 'löschen', 'supprimer', 'eliminar', 'elimina',
                         'excluir', 'usuń', 'verwijderen', '삭제', '削除', '删除',
                         '刪除', 'удалить', 'ta bort', 'slet', 'poista')
function Delete-One($item) {
    $verbs = $item.Verbs()
    $chosen = $null
    for ($i = 0; $i -lt $verbs.Count; $i++) {
        $v = $verbs.Item($i)
        $label = ($v.Name -replace '&', '').Trim().ToLowerInvariant()
        if ($label -eq '') { continue }
        foreach ($cand in $script:DeleteLabels) {
            if ($label -eq $cand -or $label.StartsWith($cand)) { $chosen = $v; break }
        }
        if ($null -ne $chosen) { break }
    }
    if ($null -eq $chosen) {
        # Last resort: the canonical verb name.
        try { $item.InvokeVerb('delete'); return $true } catch {}
        throw "no delete verb found (device may forbid deletion, or label unrecognized)"
    }
    $chosen.DoIt()
    return $true
}

# ------------------------------------------------------------------
# Thumbnail extraction via IShellItemImageFactory (best effort).
# Compiled at runtime with the in-box .NET Framework compiler (Add-Type),
# so no SDK is required. Windows decodes HEIC here if the HEIF codec is present.
# ------------------------------------------------------------------
$script:ThumbTypeReady = $false
function Ensure-ThumbType {
    if ($script:ThumbTypeReady) { return $true }
    $code = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class ShellThumb
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc,
        [In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory
    {
        void GetImage([In, MarshalAs(UnmanagedType.Struct)] SIZE size, [In] int flags, out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SIZE { public int cx; public int cy; public SIZE(int x, int y){cx=x;cy=y;} }

    static readonly Guid IID_IShellItemImageFactory =
        new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");

    // SIIGBF: 0x0 resize to fit, 0x4 thumbnail-only off, 0x20 = ICONONLY off.
    // 0x00 = default (thumbnail if available, else icon). We ask for a scaled bitmap.
    public static bool Save(string parsingName, int size, string outPath)
    {
        object o;
        Guid iid = IID_IShellItemImageFactory;
        SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref iid, out o);
        var factory = (IShellItemImageFactory)o;
        IntPtr hbmp = IntPtr.Zero;
        factory.GetImage(new SIZE(size, size), 0x0, out hbmp);
        if (hbmp == IntPtr.Zero) return false;
        try
        {
            using (var bmp = Image.FromHbitmap(hbmp))
            {
                bmp.Save(outPath, ImageFormat.Png);
            }
        }
        finally { DeleteObject(hbmp); }
        return true;
    }

    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
}
'@
    try {
        Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Drawing' -ErrorAction Stop
        $script:ThumbTypeReady = $true
        return $true
    } catch {
        Write-Log "thumb: Add-Type failed: $($_.Exception.Message)"
        return $false
    }
}

# ------------------------------------------------------------------
# WPD fast enumeration (Windows Portable Devices API, compiled at runtime).
# ~300x faster than Shell for large libraries (seconds vs minutes). Builds the
# item list JSON directly. Path ids match the Shell scheme (folder/name), so
# copy/thumb/delete keep working through the Shell code unchanged.
# ------------------------------------------------------------------
$script:WpdTypeReady = $false
function Ensure-WpdType {
    if ($script:WpdTypeReady) { return $true }
    $code = @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using ComTypes = System.Runtime.InteropServices.ComTypes;

public static class Wpd
{
    static readonly Guid RES_THUMBNAIL = new Guid("C7C407BA-98FA-46B5-9960-23FEC124CFDE");
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

    static readonly Guid CLSID_PropVariantCollection = new Guid("08A99E2F-6D6D-4B80-AF5A-BAF2BCBE4CB9");
    static readonly Guid RES_DEFAULT_FMTID = new Guid("E81E79BE-34F0-41BF-B53F-F1A06AE87842");

    static readonly Guid OBJ = new Guid("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C");
    static PROPERTYKEY K(uint pid){ PROPERTYKEY k; k.fmtid=OBJ; k.pid=pid; return k; }
    static PROPERTYKEY WPD_OBJECT_NAME               = K(4);
    static PROPERTYKEY WPD_OBJECT_CONTENT_TYPE       = K(7);
    static PROPERTYKEY WPD_OBJECT_ORIGINAL_FILE_NAME = K(12);
    static PROPERTYKEY WPD_OBJECT_DATE_CREATED       = K(18);
    static readonly Guid CLIENT = new Guid("204D9F0C-2292-4080-9F42-40664E70F859");
    static readonly Guid CT_FOLDER     = new Guid("27E2E392-A111-48E0-AB0C-E17705A05F85");
    static readonly Guid CT_FUNCTIONAL = new Guid("99ED0160-17FF-4C44-9D98-1D7A6F941921");
    static readonly Guid CLSID_DeviceManager  = new Guid("0AF10CEC-2ECD-4B92-9581-34F6AE0637F3");
    static readonly Guid CLSID_DeviceFTM      = new Guid("F7C0039A-4762-488A-B4B3-760EF9A1BA9B");
    static readonly Guid CLSID_Values         = new Guid("0C15D503-D017-47CE-9016-7B3F978721CC");
    static readonly Guid CLSID_KeyCollection  = new Guid("DE2D022D-2480-43BE-97F0-D1FA2CF98F4F");

    [ComImport, Guid("A1567595-4C2F-4574-A6FA-ECEF917B9A40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceManager {
        void GetDevices([In,Out, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.LPWStr, SizeParamIndex=1)] string[] ids, [In,Out] ref uint count);
        void RefreshDeviceList();
        void GetDeviceFriendlyName([MarshalAs(UnmanagedType.LPWStr)] string id, [In,Out] StringBuilder name, [In,Out] ref uint pcch);
        void GetDeviceDescription([MarshalAs(UnmanagedType.LPWStr)] string id, [In,Out] StringBuilder desc, [In,Out] ref uint pcch);
        void GetDeviceManufacturer([MarshalAs(UnmanagedType.LPWStr)] string id, [In,Out] StringBuilder mfr, [In,Out] ref uint pcch);
    }
    [ComImport, Guid("625E2DF8-6392-4CF0-9AD1-3CFA5F17775C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevice {
        void Open([MarshalAs(UnmanagedType.LPWStr)] string id, IPortableDeviceValues clientInfo);
        void SendCommand(int flags, IntPtr pParams, out IntPtr ppResults);
        void Content(out IPortableDeviceContent ppContent);
    }
    [ComImport, Guid("6A96ED84-7C73-4480-9938-BF5AF477D426"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceContent {
        void EnumObjects(uint flags, [MarshalAs(UnmanagedType.LPWStr)] string parent, IPortableDeviceValues filter, out IEnumPortableDeviceObjectIDs ppEnum);
        void Properties(out IPortableDeviceProperties ppProperties);
        void Transfer(out IPortableDeviceResources ppResources);
        void CreateObjectWithPropertiesOnly(IntPtr a, IntPtr b);              // unused slot
        void CreateObjectWithPropertiesAndData(IntPtr a, IntPtr b, IntPtr c, IntPtr d); // unused slot
        void Delete(uint dwOptions, IPortableDevicePropVariantCollection pObjectIDs, out IPortableDevicePropVariantCollection ppResults);
    }
    [ComImport, Guid("89B2E422-4F1B-4316-BCEF-A44AFEA9DC19"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevicePropVariantCollection {
        void GetCount(ref uint pcElems);
        void GetAt(uint index, out PROPVARIANT pValue);
        void Add(ref PROPVARIANT pValue);
        void GetTypeVt(out ushort pvt);
        void ChangeType(ushort vt);
        void Clear();
        void RemoveAt(uint index);
    }
    [ComImport, Guid("FD8878AC-D841-4D17-891C-E6829CDB6934"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceResources {
        void GetSupportedResources([MarshalAs(UnmanagedType.LPWStr)] string objId, out IPortableDeviceKeyCollection ppKeys);
        void GetResourceAttributes([MarshalAs(UnmanagedType.LPWStr)] string objId, ref PROPERTYKEY key, out IPortableDeviceValues ppAttrs);
        void GetStream([MarshalAs(UnmanagedType.LPWStr)] string objId, ref PROPERTYKEY key, uint dwStgAccess, ref uint pOptimalBufferSize, out ComTypes.IStream ppStream);
    }
    [ComImport, Guid("10ECE955-CF41-4728-BFA0-41EEDF1BBF19"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumPortableDeviceObjectIDs {
        [PreserveSig] int Next(uint cObjects, [In,Out, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.LPWStr, SizeParamIndex=0)] string[] pObjIDs, ref uint pcFetched);
    }
    [ComImport, Guid("7F6D695C-03DF-4439-A809-59266BEEE3A6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceProperties {
        void GetSupportedProperties([MarshalAs(UnmanagedType.LPWStr)] string objId, out IPortableDeviceKeyCollection ppKeys);
        void GetPropertyAttributes([MarshalAs(UnmanagedType.LPWStr)] string objId, ref PROPERTYKEY key, out IPortableDeviceValues ppAttrs);
        void GetValues([MarshalAs(UnmanagedType.LPWStr)] string objId, IPortableDeviceKeyCollection pKeys, out IPortableDeviceValues ppValues);
    }
    [ComImport, Guid("DADA2357-E0AD-492E-98DB-DD61C53BA353"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceKeyCollection {
        void GetCount(ref uint pcElems);
        void GetAt(uint index, out PROPERTYKEY pKey);
        void Add(ref PROPERTYKEY Key);
    }
    [ComImport, Guid("6848F6F2-3155-4F86-B6F5-263EEEAB3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceValues {
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

    static object CreateCom(Guid clsid){ return Activator.CreateInstance(Type.GetTypeFromCLSID(clsid)); }
    static string SbGet(Action<StringBuilder> call){ try { var sb=new StringBuilder(260); call(sb); return sb.ToString(); } catch { return ""; } }

    static bool IsMedia(string name, out bool video){
        video=false; if(name==null) return false;
        int d=name.LastIndexOf('.'); if(d<0) return false;
        string e=name.Substring(d).ToLowerInvariant();
        if(e==".mov"||e==".mp4"||e==".m4v"||e==".avi"){video=true;return true;}
        return (e==".heic"||e==".heif"||e==".jpg"||e==".jpeg"||e==".png"||e==".gif"||e==".dng"||e==".tiff"||e==".tif"||e==".bmp"||e==".webp");
    }

    public static string FindAppleDeviceId(){
        var mgr = (IPortableDeviceManager)CreateCom(CLSID_DeviceManager);
        uint c=0; mgr.GetDevices(null, ref c);
        if(c==0) return null;
        var ids = new string[c]; mgr.GetDevices(ids, ref c);
        for(int i=0;i<c;i++){
            string id=ids[i];
            string mfr = SbGet(sb=>{ uint x=260; mgr.GetDeviceManufacturer(id, sb, ref x); });
            string nm  = SbGet(sb=>{ uint x=260; mgr.GetDeviceFriendlyName(id, sb, ref x); });
            if(mfr.IndexOf("apple", StringComparison.OrdinalIgnoreCase)>=0) return id;
            if(nm.IndexOf("iphone", StringComparison.OrdinalIgnoreCase)>=0) return id;
            if(nm.IndexOf("ipad", StringComparison.OrdinalIgnoreCase)>=0) return id;
        }
        return null;
    }

    static IPortableDeviceValues MakeClientInfo(){
        var v = (IPortableDeviceValues)CreateCom(CLSID_Values);
        PROPERTYKEY k; k.fmtid=CLIENT; k.pid=2; v.SetStringValue(ref k, "EagleiPhoneSync");
        return v;
    }

    static void JsonEsc(StringBuilder sb, string s){
        sb.Append('"');
        if(s!=null) foreach(char ch in s){
            if(ch=='"'||ch=='\\'){ sb.Append('\\'); sb.Append(ch); }
            else if(ch=='\n') sb.Append("\\n");
            else if(ch=='\r') sb.Append("\\r");
            else if(ch=='\t') sb.Append("\\t");
            else if(ch<0x20){ sb.Append("\\u"); sb.Append(((int)ch).ToString("x4")); }
            else sb.Append(ch);
        }
        sb.Append('"');
    }

    static int _count, _media, _max; static bool _first; static StringBuilder _sb;
    public static int LastCount;

    // Stream one resource of one object to a file. isThumb=true -> the small JPEG
    // thumbnail; false -> WPD_RESOURCE_DEFAULT (the full original file). Returns
    // bytes written, or -1 on failure.
    public static long SaveResource(string deviceId, string oid, bool isThumb, string outPath){
        long total = -1;
        var dev = (IPortableDevice)CreateCom(CLSID_DeviceFTM);
        dev.Open(deviceId, MakeClientInfo());
        IPortableDeviceContent content; dev.Content(out content);
        IPortableDeviceResources res; content.Transfer(out res);
        try {
            PROPERTYKEY key; key.fmtid = isThumb ? RES_THUMBNAIL : RES_DEFAULT_FMTID; key.pid = 0;
            uint optimal=0; ComTypes.IStream stream;
            res.GetStream(oid, ref key, 0, ref optimal, out stream);
            using(var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write)){
                var buf = new byte[optimal>0?(int)optimal:262144]; IntPtr pcb=Marshal.AllocHGlobal(4); total=0;
                while(true){ stream.Read(buf, buf.Length, pcb); int r=Marshal.ReadInt32(pcb); if(r<=0) break; fs.Write(buf,0,r); total+=r; }
                Marshal.FreeHGlobal(pcb);
            }
            try { Marshal.FinalReleaseComObject(stream); } catch {}
        } catch { total = -1; }
        try { Marshal.FinalReleaseComObject(res); } catch {}
        try { Marshal.FinalReleaseComObject(dev); } catch {}
        return total;
    }

    // Capture date for ONE object (cheap for a single item; too slow for all).
    public static string GetDate(string deviceId, string oid){
        string dt = null;
        try {
            var dev = (IPortableDevice)CreateCom(CLSID_DeviceFTM);
            dev.Open(deviceId, MakeClientInfo());
            IPortableDeviceContent content; dev.Content(out content);
            IPortableDeviceProperties props; content.Properties(out props);
            var keys = (IPortableDeviceKeyCollection)CreateCom(CLSID_KeyCollection);
            var k = WPD_OBJECT_DATE_CREATED; keys.Add(ref k);
            IPortableDeviceValues v; props.GetValues(oid, keys, out v);
            try { var kk = WPD_OBJECT_DATE_CREATED; v.GetStringValue(ref kk, out dt); } catch {}
            try { Marshal.FinalReleaseComObject(v); } catch {}
            try { Marshal.FinalReleaseComObject(dev); } catch {}
        } catch {}
        return dt;
    }

    // Delete objects from the device by object id (frees phone storage). Returns
    // how many were requested (device performs the delete). VT_LPWSTR = 31.
    public static int DeleteObjects(string deviceId, string[] oids){
        var dev = (IPortableDevice)CreateCom(CLSID_DeviceFTM);
        dev.Open(deviceId, MakeClientInfo());
        IPortableDeviceContent content; dev.Content(out content);
        var coll = (IPortableDevicePropVariantCollection)CreateCom(CLSID_PropVariantCollection);
        foreach(var oid in oids){
            PROPVARIANT pv; pv.vt=31; pv.p=Marshal.StringToCoTaskMemUni(oid);
            coll.Add(ref pv);
            Marshal.FreeCoTaskMem(pv.p);
        }
        IPortableDevicePropVariantCollection results;
        content.Delete(0, coll, out results);   // 0 = no recursion
        try { Marshal.FinalReleaseComObject(results); } catch {}
        try { Marshal.FinalReleaseComObject(coll); } catch {}
        try { Marshal.FinalReleaseComObject(dev); } catch {}
        return oids.Length;
    }

    // Fetch the device-generated JPEG thumbnail for each object id (fast, ~50ms
    // each; HEIC photos also yield a JPEG thumbnail, so no HEIC decode needed).
    // Writes each to outPaths[i]. Returns how many succeeded.
    // The thumbnail resource key varies by device/iOS version. Detect it from the
    // object's supported resources (the non-DEFAULT one) instead of hardcoding a
    // GUID that only matched one specific iPhone.
    static PROPERTYKEY ResolveThumbKey(IPortableDeviceResources res, string[] oids){
        PROPERTYKEY fb; fb.fmtid=RES_THUMBNAIL; fb.pid=0;
        for(int i=0;i<oids.Length && i<8;i++){
            if(string.IsNullOrEmpty(oids[i])) continue;
            IPortableDeviceKeyCollection keys=null;
            try { res.GetSupportedResources(oids[i], out keys); } catch { continue; }
            try {
                uint n=0; keys.GetCount(ref n);
                for(uint j=0;j<n;j++){ PROPERTYKEY k; keys.GetAt(j, out k); if(k.fmtid != RES_DEFAULT_FMTID) return k; }
                return fb;
            } finally { try{ Marshal.FinalReleaseComObject(keys); }catch{} }
        }
        return fb;
    }

    public static int SaveThumbnails(string deviceId, string[] oids, string[] outPaths){
        int ok=0;
        var dev = (IPortableDevice)CreateCom(CLSID_DeviceFTM);
        dev.Open(deviceId, MakeClientInfo());
        IPortableDeviceContent content; dev.Content(out content);
        IPortableDeviceResources res; content.Transfer(out res);
        PROPERTYKEY key = ResolveThumbKey(res, oids);
        Console.Error.WriteLine("THUMBKEY " + key.fmtid.ToString() + ":" + key.pid);
        for(int i=0;i<oids.Length;i++){
            try {
                uint optimal=0; ComTypes.IStream stream;
                res.GetStream(oids[i], ref key, 0, ref optimal, out stream);
                var ms=new MemoryStream(); var buf=new byte[optimal>0?(int)optimal:65536];
                IntPtr pcb=Marshal.AllocHGlobal(4);
                while(true){ stream.Read(buf, buf.Length, pcb); int r=Marshal.ReadInt32(pcb); if(r<=0) break; ms.Write(buf,0,r); }
                Marshal.FreeHGlobal(pcb);
                try { Marshal.FinalReleaseComObject(stream); } catch {}
                File.WriteAllBytes(outPaths[i], ms.ToArray());
                ok++;
            } catch {}
        }
        try { Marshal.FinalReleaseComObject(res); } catch {}
        try { Marshal.FinalReleaseComObject(dev); } catch {}
        return ok;
    }

    public static string ListResultJson(string deviceId, string deviceName, int maxCount){
        var dev = (IPortableDevice)CreateCom(CLSID_DeviceFTM);
        dev.Open(deviceId, MakeClientInfo());
        IPortableDeviceContent content; dev.Content(out content);
        IPortableDeviceProperties props; content.Properties(out props);
        var keys = (IPortableDeviceKeyCollection)CreateCom(CLSID_KeyCollection);
        var k1 = WPD_OBJECT_ORIGINAL_FILE_NAME; keys.Add(ref k1);
        var k2 = WPD_OBJECT_NAME; keys.Add(ref k2);
        var k3 = WPD_OBJECT_CONTENT_TYPE; keys.Add(ref k3);

        _sb = new StringBuilder(1<<20); _sb.Append('[');
        _first=true; _count=0; _media=0; _max=maxCount;
        Walk(content, props, keys, "DEVICE", "", true);
        _sb.Append(']');
        try { Marshal.FinalReleaseComObject(dev); } catch {}
        LastCount = _media;

        var outp = new StringBuilder(_sb.Length + 64);
        outp.Append("{\"ok\":true,\"device\":"); JsonEsc(outp, deviceName ?? "Apple iPhone");
        outp.Append(",\"count\":"); outp.Append(_media);
        outp.Append(",\"items\":"); outp.Append(_sb.ToString()); outp.Append('}');
        return outp.ToString();
    }

    static void Walk(IPortableDeviceContent content, IPortableDeviceProperties props,
                     IPortableDeviceKeyCollection keys, string parentId, string prefix, bool atDevice){
        IEnumPortableDeviceObjectIDs e; content.EnumObjects(0, parentId, null, out e);
        const uint BATCH=64; var arr=new string[BATCH]; uint fetched;
        do {
            fetched=0; e.Next(BATCH, arr, ref fetched);
            for(uint i=0;i<fetched;i++){
                if(_max>0 && _media>=_max) break;
                _count++;
                string oid=arr[i];
                IPortableDeviceValues vals;
                try { props.GetValues(oid, keys, out vals); } catch { continue; }
                Guid ct=Guid.Empty; try{var kc=WPD_OBJECT_CONTENT_TYPE; vals.GetGuidValue(ref kc, out ct);}catch{}
                string nm=null; try{var kn=WPD_OBJECT_ORIGINAL_FILE_NAME; vals.GetStringValue(ref kn, out nm);}catch{}
                if(string.IsNullOrEmpty(nm)){try{var kn=WPD_OBJECT_NAME; vals.GetStringValue(ref kn, out nm);}catch{}}
                if(string.IsNullOrEmpty(nm)) nm=oid;
                // Full release is essential: a lingering ref makes the device
                // progressively stall (rate collapses ~200x after a few thousand).
                try { Marshal.FinalReleaseComObject(vals); } catch {}
                if((_count & 0x7FF)==0){ GC.Collect(); GC.WaitForPendingFinalizers(); }

                bool container=(ct==CT_FOLDER || ct==CT_FUNCTIONAL);
                if(container){
                    string np = atDevice ? "" : (prefix.Length==0 ? nm : prefix + "/" + nm);
                    Walk(content, props, keys, oid, np, false);
                } else {
                    bool video;
                    if(IsMedia(nm, out video)){
                        string p = prefix.Length==0 ? nm : prefix + "/" + nm;
                        int dot=nm.LastIndexOf('.'); string ext = dot>=0 ? nm.Substring(dot+1).ToLowerInvariant() : "";
                        if(!_first) _sb.Append(',');
                        _first=false;
                        _sb.Append("{\"id\":"); JsonEsc(_sb, p);
                        _sb.Append(",\"oid\":"); JsonEsc(_sb, oid);
                        _sb.Append(",\"name\":"); JsonEsc(_sb, nm);
                        _sb.Append(",\"folder\":"); JsonEsc(_sb, prefix);
                        _sb.Append(",\"ext\":"); JsonEsc(_sb, ext);
                        _sb.Append(",\"kind\":"); _sb.Append(video?"\"video\"":"\"image\"");
                        _sb.Append('}');
                        _media++;
                        if((_media % 500)==0) Console.Error.WriteLine("PROGRESS " + _media);
                    }
                }
            }
        } while(fetched>0);
        try { Marshal.FinalReleaseComObject(e); } catch {}
    }
}
'@
    try {
        Add-Type -TypeDefinition $code -ErrorAction Stop
        $script:WpdTypeReady = $true
        return $true
    } catch {
        Write-Log "wpd: Add-Type failed: $($_.Exception.Message)"
        return $false
    }
}

# ==================================================================
# Main
# ==================================================================
switch ($Action) {

    'devices' {
        $shell = Get-Shell
        $devices = Get-DeviceItems $shell
        $names = @()
        foreach ($d in $devices) { $names += @{ name = $d.Name } }
        Emit @{ ok = $true; devices = @($names) }
        exit 0
    }

    'diagnose' {
        $shell = Get-Shell
        $allDev = Get-DeviceItems $shell
        $names = @(); foreach ($d in $allDev) { $names += $d.Name }
        $dev = Select-DeviceItem $shell $Device
        $out = [ordered]@{
            ok           = $true
            devicesFound = @($names)
            picked       = if ($dev) { $dev.Name } else { $null }
        }
        if ($dev) {
            $root = $dev.GetFolder
            $topNames = @(); foreach ($it in $root.Items()) { $topNames += $it.Name }
            $out.topLevel = @($topNames)
            $dcim = Get-PhotoRoot $root
            $out.dcimFound = ($null -ne $dcim)
            if ($dcim) {
                $acc = New-Object System.Collections.ArrayList
                Collect-Media $dcim '' $acc 3
                $out.sampleCount = $acc.Count
                $out.sample = @($acc)
                if ($acc.Count -gt 0) {
                    # Test a thumbnail on the first sample.
                    $first = Resolve-ItemById $dcim $acc[0].id
                    if ($first) {
                        $out.firstPath = $first.Path
                        if (Ensure-ThumbType) {
                            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("diag_" + [guid]::NewGuid().ToString('N') + '.png')
                            try {
                                $okThumb = [ShellThumb]::Save($first.Path, 256, $tmp)
                                $out.thumbTest = ($okThumb -and (Test-Path $tmp))
                            } catch { $out.thumbTest = $false; $out.thumbError = $_.Exception.Message }
                            finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
                        } else { $out.thumbTest = $false; $out.thumbError = 'Add-Type failed' }
                    }
                }
            }
        }
        Emit $out
        exit 0
    }

    'list' {
        # Fast path: WPD bulk enumeration (~2s for ~8k photos). Falls back to the
        # Shell scan if WPD is unavailable or finds no Apple device.
        $devName = if ($Device -ne '') { $Device } else { 'Apple iPhone' }
        if (Ensure-WpdType) {
            $devId = $null
            try { $devId = [Wpd]::FindAppleDeviceId() } catch { Write-Log "wpd: find failed: $($_.Exception.Message)" }
            if ($devId) {
                try {
                    Write-Log "fast scan via WPD..."
                    $json = [Wpd]::ListResultJson($devId, $devName, $Max)
                    Write-Log "wpd: $([Wpd]::LastCount) media files"
                    [Console]::Out.WriteLine($json)
                    exit 0
                } catch { Write-Log "wpd: enumerate failed, falling back to Shell: $($_.Exception.Message)" }
            } else {
                Write-Log "wpd: no Apple device via WPD, falling back to Shell"
            }
        }
        # Fallback: Shell enumeration.
        $shell = Get-Shell
        $dev = Select-DeviceItem $shell $Device
        if ($null -eq $dev) { Fail 'no Apple device found. Plug in your iPhone, unlock it, and tap "Trust".' }
        Write-Log "scanning device folders on '$($dev.Name)'..."
        $dcim = Get-PhotoRoot $dev.GetFolder
        if ($null -eq $dcim) { Fail "device '$($dev.Name)' found but its storage is not accessible. Unlock the phone and tap Trust." }
        $acc = New-Object System.Collections.ArrayList
        Collect-Media $dcim '' $acc $Max
        Write-Log "found $($acc.Count) media files"
        Emit @{ ok = $true; device = $dev.Name; count = $acc.Count; items = @($acc) }
        exit 0
    }

    'meta' {
        # Lazy metadata (size + date) for a batch of ids the user is viewing.
        $ids = Read-Ids $InputFile
        $shell = Get-Shell
        $dev = Select-DeviceItem $shell $Device
        if ($null -eq $dev) { Fail 'no Apple device found.' }
        $dcim = Get-PhotoRoot $dev.GetFolder
        if ($null -eq $dcim) { Fail 'DCIM not accessible.' }
        $results = @()
        foreach ($id in $ids) {
            $entry = @{ id = $id; size = $null; date = '' }
            try {
                $item = Resolve-ItemById $dcim $id
                if ($null -ne $item) {
                    $m = Get-ItemMeta $item
                    $entry.size = $m.size
                    $entry.date = $m.date
                }
            } catch {}
            $results += $entry
        }
        Emit @{ ok = $true; results = @($results) }
        exit 0
    }

    'thumb' {
        # Fetch device-generated JPEG thumbnails via WPD by object id (fast).
        # Input is a JSON array of { id, oid }. Output files named by id-hash.
        if ($OutDir -eq '') { Fail 'thumb: -OutDir required' }
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        $items = Read-Ids $InputFile
        if (-not (Ensure-WpdType)) { Fail 'wpd engine unavailable' }
        $devId = $null
        try { $devId = [Wpd]::FindAppleDeviceId() } catch {}
        if (-not $devId) { Fail 'no Apple device (WPD).' }

        $sha = New-Object Security.Cryptography.SHA1Managed
        $results = @()
        $fetchOids = New-Object System.Collections.ArrayList
        $fetchOuts = New-Object System.Collections.ArrayList
        foreach ($it in $items) {
            $id = $it.id; $oid = $it.oid
            $hash = [System.BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($id))).Replace('-', '').Substring(0, 16)
            $outPath = Join-Path $OutDir ("$hash.jpg")
            $results += @{ id = $id; thumb = $null; _out = $outPath }
            if ((Test-Path -LiteralPath $outPath) -or -not $oid) { continue }
            [void]$fetchOids.Add($oid)
            [void]$fetchOuts.Add($outPath)
        }
        if ($fetchOids.Count -gt 0) {
            try { [void][Wpd]::SaveThumbnails($devId, $fetchOids.ToArray(), $fetchOuts.ToArray()) }
            catch { Write-Log "wpd thumb failed: $($_.Exception.Message)" }
        }
        foreach ($r in $results) {
            if (Test-Path -LiteralPath $r._out) { $r.thumb = $r._out }
            $r.Remove('_out')
        }
        Emit @{ ok = $true; results = @($results) }
        exit 0
    }

    'preview' {
        # Big preview for the viewer. Input [{id,oid,name}] (uses first). Transfers
        # the full file via WPD; JPG/PNG served as-is, HEIC rendered to PNG via the
        # Windows codec (IShellItemImageFactory on the local file).
        if ($OutDir -eq '') { Fail 'preview: -OutDir required' }
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        $OutDir = [System.IO.Path]::GetFullPath($OutDir)   # SHCreateItemFromParsingName needs absolute
        $items = Read-Ids $InputFile
        $it = @($items)[0]
        if (-not (Ensure-WpdType)) { Fail 'wpd unavailable' }
        $devId = $null; try { $devId = [Wpd]::FindAppleDeviceId() } catch {}
        if (-not $devId) { Fail 'no Apple device (WPD).' }

        $date = ''; try { $date = [Wpd]::GetDate($devId, $it.oid) } catch {}
        $sha = New-Object Security.Cryptography.SHA1Managed
        $hash = [System.BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($it.id))).Replace('-', '').Substring(0, 16)
        $ext = ([System.IO.Path]::GetExtension($it.name)).ToLowerInvariant()
        $displayReady = @('.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp')
        $videoExt = @('.mov', '.mp4', '.m4v', '.avi')

        if ($videoExt -contains $ext) {
            $out = Join-Path $OutDir ("$hash$ext")
            if (-not (Test-Path -LiteralPath $out)) { [void][Wpd]::SaveResource($devId, $it.oid, $false, $out) }
            if (Test-Path -LiteralPath $out) { Emit @{ ok = $true; path = $out; kind = 'video'; date = $date } }
            else { Emit @{ ok = $false; error = 'video transfer failed'; kind = 'video' } }
            exit 0
        }
        if ($displayReady -contains $ext) {
            $out = Join-Path $OutDir ("$hash$ext")
            if (-not (Test-Path -LiteralPath $out)) { [void][Wpd]::SaveResource($devId, $it.oid, $false, $out) }
            if (Test-Path -LiteralPath $out) { Emit @{ ok = $true; path = $out; kind = 'image'; date = $date } }
            else { Emit @{ ok = $false; error = 'transfer failed' } }
            exit 0
        }
        # HEIC / other: transfer full, render to PNG via Windows codec.
        $out = Join-Path $OutDir ("$hash.png")
        if (-not (Test-Path -LiteralPath $out)) {
            $tmp = Join-Path $OutDir ("$hash.orig$ext")
            $n = [Wpd]::SaveResource($devId, $it.oid, $false, $tmp)
            if ($n -gt 0 -and (Ensure-ThumbType)) {
                try { [void][ShellThumb]::Save($tmp, 1600, $out) } catch { Write-Log "render failed: $($_.Exception.Message)" }
            }
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $out) { Emit @{ ok = $true; path = $out; kind = 'image'; date = $date } }
        else { Emit @{ ok = $false; error = 'could not render (HEIF codec may be missing; install "HEIF Image Extensions")' } }
        exit 0
    }

    'copy' {
        # Transfer originals to $Dest via WPD (fast, reliable). Input [{id,oid,name}].
        if ($Dest -eq '') { Fail 'copy: -Dest required' }
        New-Item -ItemType Directory -Path $Dest -Force | Out-Null
        $items = Read-Ids $InputFile
        if (-not (Ensure-WpdType)) { Fail 'wpd unavailable' }
        $devId = $null; try { $devId = [Wpd]::FindAppleDeviceId() } catch {}
        if (-not $devId) { Fail 'no Apple device (WPD).' }
        $results = @()
        $i = 0
        foreach ($it in $items) {
            $i++
            Write-Log "copy $i/$(@($items).Count): $($it.name)"
            $entry = @{ id = $it.id; name = $it.name; ok = $false; path = $null; error = $null }
            try {
                $name = if ($it.name) { $it.name } else { [System.IO.Path]::GetFileName($it.id) }
                $finalPath = Join-Path $Dest $name
                if (Test-Path -LiteralPath $finalPath) {
                    $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
                    $x = [System.IO.Path]::GetExtension($name); $n = 1
                    do { $finalPath = Join-Path $Dest ("$base ($n)$x"); $n++ } while (Test-Path -LiteralPath $finalPath)
                }
                $bytes = [Wpd]::SaveResource($devId, $it.oid, $false, $finalPath)
                if ($bytes -gt 0) { $entry.path = $finalPath; $entry.ok = $true }
                else { $entry.error = 'transfer failed (photo may be in iCloud, not on device)'; Remove-Item -LiteralPath $finalPath -Force -EA SilentlyContinue }
            } catch { $entry.error = $_.Exception.Message }
            $results += $entry
            if (($i % 5) -eq 0) { Write-Log "PROGRESS $i" }
        }
        Emit @{ ok = $true; results = @($results) }
        exit 0
    }

    'delete' {
        # Delete objects from the phone via WPD (frees storage). Input [{id,oid}].
        $items = Read-Ids $InputFile
        if (-not (Ensure-WpdType)) { Fail 'wpd unavailable' }
        $devId = $null; try { $devId = [Wpd]::FindAppleDeviceId() } catch {}
        if (-not $devId) { Fail 'no Apple device (WPD).' }
        $oids = @(); $map = @{}
        foreach ($it in $items) { if ($it.oid) { $oids += $it.oid; $map[$it.oid] = $it.id } }
        $results = @()
        if ($oids.Count -gt 0) {
            try { [void][Wpd]::DeleteObjects($devId, $oids) }
            catch { Write-Log "wpd delete failed: $($_.Exception.Message)" }
        }
        # Confirm by re-enumerating remaining oids.
        $remaining = @{}
        try {
            $json = [Wpd]::ListResultJson($devId, 'Apple iPhone', 0)
            $parsed = $json | ConvertFrom-Json
            foreach ($m in $parsed.items) { $remaining[$m.oid] = $true }
        } catch {}
        foreach ($it in $items) {
            $gone = -not $remaining.ContainsKey($it.oid)
            $results += @{ id = $it.id; ok = $gone; error = if ($gone) { $null } else { 'still present' } }
        }
        Emit @{ ok = $true; results = @($results) }
        exit 0
    }
}
