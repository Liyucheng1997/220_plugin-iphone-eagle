<#
  iphone.ps1  --  phone photo backend for the Eagle plugin (iPhone AND Android).

  ENCODING: this file MUST stay UTF-8 *with BOM*. It contains Chinese strings,
  and PowerShell 5.1 decodes a BOM-less .ps1 using the system ANSI codepage —
  on a Chinese Windows (ACP 936) the UTF-8 bytes are read as GBK, a closing
  quote gets swallowed as a double-byte trail byte, and the whole script dies
  with a ParserError before it can run at all. This is invisible on a machine
  whose ACP is already 65001/UTF-8, so it only ever shows up on someone else's
  computer. Do not let an editor "clean up" the BOM.

  Talks to the connected phone through the Windows Portable Devices (WPD) /
  MTP channel — the same one File Explorer uses to show "This PC > <phone> >
  Internal Storage". Both iPhones and Android phones speak MTP, so the same
  engine handles either. No .NET SDK required; iPhones use Apple's USB driver
  (installed with iTunes / "Apple Devices"), Android uses the in-box Windows
  MTP driver. (Filename kept as iphone.ps1 for backward compatibility.)

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
    # Prefer a phone-like device by name (iPhone or a known Android brand).
    $phoneRe = '(?i)iphone|ipad|ipod|apple|android|phone|galaxy|samsung|xiaomi|redmi|poco|huawei|honor|oppo|vivo|oneplus|pixel|google|moto|nokia|xperia|realme|asus|meizu|lenovo|tecno|infinix'
    foreach ($d in $devices) {
        if ($d.Name -match $phoneRe) { return $d }
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

# Folder filtering, mirroring the WPD scan (see the C# AllowTopFolder/SkipFolder
# comments): at a storage's top level only descend into real photo folders;
# deeper down, prune cache/hidden junk. No-op for iPhone's clean layout.
$script:PhotoTopFolders = @('dcim', 'pictures', 'picture', 'screenshots', 'screenshot',
                            'download', 'downloads', 'movies', 'movie', 'video', 'videos',
                            'camera', 'photo', 'photos', 'images', 'image', '100apple', '100andro')
$script:SkipFolders = @('android', 'tencent', 'cache', 'caches', 'thumbnails',
                        'log', 'logs', 'temp', 'tmp', 'netease', 'sina')
function Should-AllowTopFolder([string]$name) {
    if ([string]::IsNullOrEmpty($name)) { return $false }
    if ($name -match '^\d{6}') { return $true }   # iPhone YYYYMM date folder (202506_a)
    return ($script:PhotoTopFolders -contains $name.ToLowerInvariant())
}
function Should-SkipFolder([string]$name) {
    if ([string]::IsNullOrEmpty($name)) { return $false }
    if ($name[0] -eq '.') { return $true }   # hidden: .thumbnails, .Statuses, ...
    return ($script:SkipFolders -contains $name.ToLowerInvariant())
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
            if ($prefix -eq '') { if (-not (Should-AllowTopFolder $name)) { continue } }
            elseif (Should-SkipFolder $name) { continue }
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
using System.Threading;
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
    static PROPERTYKEY WPD_OBJECT_ID                 = K(2);
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
    // Open() starts an MTP session and MTP allows exactly ONE per device, so
    // Close() is mandatory — leaving it to process teardown is what wedged the
    // device after a delete: the stale session had to time out in the driver
    // before the next Open() could be granted, and our watchdog killed the
    // read first, leaking yet another session. Every slot up to Close must be
    // declared or the call lands on the wrong method (slot order verified
    // against the SDK's IPortableDeviceVtbl: Close is slot 8).
    [ComImport, Guid("625E2DF8-6392-4CF0-9AD1-3CFA5F17775C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevice {
        void Open([MarshalAs(UnmanagedType.LPWStr)] string id, IPortableDeviceValues clientInfo);
        void SendCommand(int flags, IntPtr pParams, out IntPtr ppResults);
        void Content(out IPortableDeviceContent ppContent);
        void Capabilities(out IntPtr ppCapabilities);   // unused slot
        void Cancel();
        void Close();
        void Advise(int dwFlags, IntPtr pCallback, IntPtr pParameters, out IntPtr ppszCookie);  // unused slot
        void Unadvise([MarshalAs(UnmanagedType.LPWStr)] string pszCookie);                      // unused slot
        void GetPnPDeviceID(out IntPtr ppszPnPDeviceID);                                        // unused slot
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
    // NOTE: correct IID is ...A44AFEA83EB3. An earlier ...A44AFEA9DC19 was WRONG,
    // so the cast QI'd E_NOINTERFACE and delete never ran (silent failure).
    [ComImport, Guid("89B2E422-4F1B-4316-BCEF-A44AFEA83EB3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
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
    // ---- Bulk property reads (the difference between 2s and 200s) ----------
    // props.GetValues() is ONE call per object. Apple's driver caches properties
    // so that's cheap, but the in-box MTP driver Android uses turns every call
    // into a separate MTP transaction (~20ms), which is why a 10k-photo Android
    // library crawled. IPortableDevicePropertiesBulk maps onto the MTP
    // GetObjectPropList operation: one transaction for a whole folder.
    // Not every device implements it — the QI below returns null then, and we
    // fall back to the per-object loop. All four IIDs verified against
    // HKLM\SOFTWARE\Classes\Interface; a wrong one QIs to E_NOINTERFACE and
    // silently disables the fast path (see the PropVariantCollection note above).
    [ComImport, Guid("6E3F2D79-4E07-48C4-8208-D8C2E5AF4A99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDeviceValuesCollection {
        void GetCount(ref uint pcElems);
        void GetAt(uint index, out IPortableDeviceValues ppValues);
        void Add(IPortableDeviceValues pValues);
        void Clear();
        void RemoveAt(uint index);
    }
    [ComImport, Guid("9DEACB80-11E8-40E3-A9F3-F557986A7845"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevicePropertiesBulkCallback {
        void OnStart(ref Guid pContext);
        void OnProgress(ref Guid pContext, IPortableDeviceValuesCollection pResults);
        void OnEnd(ref Guid pContext, int hrStatus);
    }
    [ComImport, Guid("482B05C0-4056-44ED-9E0F-5E23B009DA93"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPortableDevicePropertiesBulk {
        void QueueGetValuesByObjectList(IPortableDevicePropVariantCollection pObjectIDs, IPortableDeviceKeyCollection pKeys, IPortableDevicePropertiesBulkCallback pCallback, out Guid pContext);
        void QueueGetValuesByObjectFormat(ref Guid pguidObjectFormat, [MarshalAs(UnmanagedType.LPWStr)] string pszParentObjectID, uint dwDepth, IPortableDeviceKeyCollection pKeys, IPortableDevicePropertiesBulkCallback pCallback, out Guid pContext);
        void QueueSetValuesByObjectList(IPortableDeviceValuesCollection pObjectValues, IPortableDevicePropertiesBulkCallback pCallback, out Guid pContext);
        void Start(ref Guid pContext);
        void Cancel(ref Guid pContext);
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

    // Release a COM wrapper. Order matters: children (content/props/resources)
    // hold their own refs to the device, so releasing the device first closed
    // nothing at all — which is how sessions leaked.
    static void Rel(object o){ if(o != null){ try { Marshal.FinalReleaseComObject(o); } catch {} } }

    // Open a session. Pair EVERY call with CloseDevice in a finally. A throwing
    // Open must not leak the wrapper either — the caller's `dev` stays null, so
    // only we can still see it.
    static IPortableDevice OpenDevice(string deviceId){
        var dev = (IPortableDevice)CreateCom(CLSID_DeviceFTM);
        try { dev.Open(deviceId, MakeClientInfo()); }
        catch { Rel(dev); throw; }
        return dev;
    }
    // End the MTP session, then drop the wrapper. Close() is what actually frees
    // the device for the next process; without it the driver holds the session.
    static void CloseDevice(IPortableDevice dev){
        if(dev == null) return;
        try { dev.Close(); } catch {}
        Rel(dev);
    }
    static string SbGet(Action<StringBuilder> call){ try { var sb=new StringBuilder(260); call(sb); return sb.ToString(); } catch { return ""; } }

    static bool IsMedia(string name, out bool video){
        video=false; if(name==null) return false;
        int d=name.LastIndexOf('.'); if(d<0) return false;
        string e=name.Substring(d).ToLowerInvariant();
        if(e==".mov"||e==".mp4"||e==".m4v"||e==".avi"){video=true;return true;}
        return (e==".heic"||e==".heif"||e==".jpg"||e==".jpeg"||e==".png"||e==".gif"||e==".dng"||e==".tiff"||e==".tif"||e==".bmp"||e==".webp");
    }

    // On Android, MTP exposes the WHOLE storage, so a plain recursion picks up
    // tens of thousands of CACHED images (thumbnail caches, WeChat/QQ/app image
    // caches, ad/loading-pic junk that apps like DrCom/MIUI drop at the storage
    // root) that are not the user's real photos. So at the TOP level of a storage
    // we only descend into folders that actually hold photos (allowlist). Deeper
    // down we additionally prune obvious cache/hidden folders (denylist).
    //
    // iPhone compatibility: its camera roll lives either in DCIM, or (as on this
    // user's phone) in date-named folders like "202506_a" directly under the
    // storage — so the top-level allowlist also passes any name that starts with
    // 6 digits (YYYYMM). Do NOT remove that or iPhone stops listing.
    static readonly string[] PhotoTopFolders = {
        "dcim","pictures","picture","screenshots","screenshot","download",
        "downloads","movies","movie","video","videos","camera","photo","photos",
        "images","image","100apple","100andro"
    };
    static bool AllowTopFolder(string name){
        if(string.IsNullOrEmpty(name)) return false;
        if(name.Length>=6){
            bool six=true;
            for(int i=0;i<6;i++){ if(name[i]<'0'||name[i]>'9'){ six=false; break; } }
            if(six) return true;   // iPhone YYYYMM date folder
        }
        string n=name.ToLowerInvariant();
        foreach(var f in PhotoTopFolders) if(n==f) return true;
        return false;
    }
    static readonly string[] SkipFolders = {
        "android","tencent","cache","caches","thumbnails",
        "log","logs","temp","tmp","netease","sina"
    };
    static bool SkipFolder(string name){
        if(string.IsNullOrEmpty(name)) return false;
        if(name[0]=='.') return true;   // hidden: .thumbnails, .face, .Statuses, .trashed ...
        string n=name.ToLowerInvariant();
        foreach(var s in SkipFolders) if(n==s) return true;
        return false;
    }

    // A device (friendly name + manufacturer) looks like a phone we can sync —
    // an iPhone/iPad, or any known Android brand. Used to auto-pick when the UI
    // hasn't told us exactly which device, and to skip non-phone WPD devices
    // (e.g. a USB SSD or card reader that also enumerates via WPD).
    static readonly string[] PhoneHints = {
        "apple","iphone","ipad","ipod","android","phone","galaxy","samsung",
        "xiaomi","redmi","poco","huawei","honor","oppo","vivo","oneplus","pixel",
        "google","moto","nokia","xperia","realme","asus","zte","meizu","lenovo",
        "tecno","infinix","nothing"
    };
    static bool LooksLikePhone(string name, string mfr){
        string s = ((name ?? "") + " " + (mfr ?? "")).ToLowerInvariant();
        foreach(var h in PhoneHints) if(s.IndexOf(h, StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // JSON list of every connected WPD/MTP device: [{name,desc,mfr,phone}].
    // The UI shows these in the device dropdown and auto-selects a phone.
    public static string ListDevicesJson(){
        var mgr = (IPortableDeviceManager)CreateCom(CLSID_DeviceManager);
        uint c=0; mgr.GetDevices(null, ref c);
        var sb = new StringBuilder(); sb.Append('[');
        if(c>0){
            var ids = new string[c]; mgr.GetDevices(ids, ref c);
            bool first=true;
            for(int i=0;i<c;i++){
                string id=ids[i];
                string nm   = SbGet(s=>{ uint x=260; mgr.GetDeviceFriendlyName(id, s, ref x); });
                string desc = SbGet(s=>{ uint x=260; mgr.GetDeviceDescription(id, s, ref x); });
                string mfr  = SbGet(s=>{ uint x=260; mgr.GetDeviceManufacturer(id, s, ref x); });
                if(string.IsNullOrEmpty(nm)) nm = !string.IsNullOrEmpty(desc) ? desc : id;
                if(!first) sb.Append(','); first=false;
                sb.Append("{\"name\":"); JsonEsc(sb, nm);
                sb.Append(",\"desc\":"); JsonEsc(sb, desc);
                sb.Append(",\"mfr\":");  JsonEsc(sb, mfr);
                sb.Append(",\"phone\":"); sb.Append(LooksLikePhone(nm, mfr) ? "true" : "false");
                sb.Append('}');
            }
        }
        sb.Append(']');
        return sb.ToString();
    }

    // Resolve the WPD device id to operate on. Preference order:
    //  1) the device whose friendly name matches what the UI selected,
    //  2) any phone-like device (iPhone or Android),
    //  3) the first connected device.
    public static string FindDeviceId(string wantedName){
        var mgr = (IPortableDeviceManager)CreateCom(CLSID_DeviceManager);
        uint c=0; mgr.GetDevices(null, ref c);
        if(c==0) return null;
        var ids = new string[c]; mgr.GetDevices(ids, ref c);
        var names = new string[c]; var mfrs = new string[c];
        for(int i=0;i<c;i++){
            string id=ids[i];
            names[i] = SbGet(sb=>{ uint x=260; mgr.GetDeviceFriendlyName(id, sb, ref x); });
            mfrs[i]  = SbGet(sb=>{ uint x=260; mgr.GetDeviceManufacturer(id, sb, ref x); });
        }
        if(!string.IsNullOrEmpty(wantedName)){
            for(int i=0;i<c;i++)
                if(string.Equals(names[i], wantedName, StringComparison.OrdinalIgnoreCase)) return ids[i];
            for(int i=0;i<c;i++)
                if(!string.IsNullOrEmpty(names[i]) &&
                   (names[i].IndexOf(wantedName, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    wantedName.IndexOf(names[i], StringComparison.OrdinalIgnoreCase) >= 0)) return ids[i];
        }
        for(int i=0;i<c;i++) if(LooksLikePhone(names[i], mfrs[i])) return ids[i];
        return ids[0];
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

    // The two properties the scan actually needs per object.
    class ObjInfo { public string Name; public Guid Ct; }

    static IPortableDevicePropertiesBulk _bulk;   // null = device has no bulk support
    static bool _bulkOk;
    static int _bulkFails;
    // Where the scan's time actually went. Printed at the end of every list, so a
    // slow read can be diagnosed from a user's log instead of guessed at.
    static int _viaBulk, _viaPerObject;
    static long _msBulk, _msPerObject;

    // Collects the values WPD hands back on its own worker thread. Results are
    // keyed by object id because the device may return them in any order and may
    // omit objects it can't describe.
    class BulkCallback : IPortableDevicePropertiesBulkCallback
    {
        public readonly Dictionary<string, ObjInfo> Map = new Dictionary<string, ObjInfo>();
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr;

        public void OnStart(ref Guid ctx) {}

        public void OnProgress(ref Guid ctx, IPortableDeviceValuesCollection results){
            uint n = 0;
            try { results.GetCount(ref n); } catch { return; }
            for(uint i = 0; i < n; i++){
                IPortableDeviceValues v = null;
                try { results.GetAt(i, out v); } catch { continue; }
                try {
                    string oid = null;
                    try { var k = WPD_OBJECT_ID; v.GetStringValue(ref k, out oid); } catch {}
                    if(string.IsNullOrEmpty(oid)) continue;
                    string nm = null;
                    try { var k = WPD_OBJECT_ORIGINAL_FILE_NAME; v.GetStringValue(ref k, out nm); } catch {}
                    if(string.IsNullOrEmpty(nm)){ try { var k = WPD_OBJECT_NAME; v.GetStringValue(ref k, out nm); } catch {} }
                    Guid ct = Guid.Empty;
                    try { var k = WPD_OBJECT_CONTENT_TYPE; v.GetGuidValue(ref k, out ct); } catch {}
                    Map[oid] = new ObjInfo { Name = nm, Ct = ct };
                } finally { try { Marshal.FinalReleaseComObject(v); } catch {} }
            }
        }

        public void OnEnd(ref Guid ctx, int hrStatus){ Hr = hrStatus; Done.Set(); }
    }

    // One bulk request for a whole folder's worth of object ids. Returns null if
    // the device refused or went quiet, so the caller can fall back.
    static Dictionary<string, ObjInfo> FetchBulk(IPortableDeviceKeyCollection keys, List<string> oids){
        var coll = (IPortableDevicePropVariantCollection)CreateCom(CLSID_PropVariantCollection);
        foreach(var oid in oids){
            PROPVARIANT pv = new PROPVARIANT(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(oid);
            coll.Add(ref pv);
            Marshal.FreeCoTaskMem(pv.p);
        }
        var cb = new BulkCallback();
        Dictionary<string, ObjInfo> map = null;
        try {
            Guid ctx;
            _bulk.QueueGetValuesByObjectList(coll, keys, cb, out ctx);
            _bulk.Start(ref ctx);
            // The wait is why the scan runs on an MTA thread: on an STA the
            // callback would be marshalled back to this blocked thread.
            if(cb.Done.WaitOne(180000)) map = cb.Map;
            else { try { _bulk.Cancel(ref ctx); } catch {} }
        } catch { map = null; }
        try { Marshal.FinalReleaseComObject(coll); } catch {}
        return map;
    }

    // Name + content type for every object id, in as few round-trips as the
    // device allows.
    static Dictionary<string, ObjInfo> FetchProps(IPortableDeviceProperties props,
                                                  IPortableDeviceKeyCollection keys, List<string> oids){
        var map = new Dictionary<string, ObjInfo>();
        if(oids.Count == 0) return map;

        // Only worth a bulk round-trip for a real folder. The device root holds
        // just a storage or two, and judging bulk support on those would be
        // wrong: a storage/functional object can refuse a property list even
        // though the photo folders underneath serve it fine. Requiring a couple
        // of failures on real folders avoids disabling the fast path over one
        // hiccup.
        if(_bulk != null && _bulkOk && oids.Count >= 8){
            var t0 = DateTime.UtcNow;
            var m = FetchBulk(keys, oids);
            _msBulk += (long)(DateTime.UtcNow - t0).TotalMilliseconds;
            if(m != null && m.Count > 0){
                foreach(var kv in m) map[kv.Key] = kv.Value;
                _viaBulk += m.Count;
                if(map.Count >= oids.Count) return map;   // complete; done in one transaction
            } else if(++_bulkFails >= 2){
                _bulkOk = false;   // device won't serve it — stop paying for the attempt
                Console.Error.WriteLine("BULK unsupported on this device; using per-object reads");
            }
        }
        var t1 = DateTime.UtcNow;
        // Per-object fallback: whole folder if bulk is unavailable, otherwise just
        // the stragglers the device left out.
        foreach(var oid in oids){
            if(map.ContainsKey(oid)) continue;
            IPortableDeviceValues vals;
            try { props.GetValues(oid, keys, out vals); } catch { continue; }
            Guid ct = Guid.Empty;
            try { var kc = WPD_OBJECT_CONTENT_TYPE; vals.GetGuidValue(ref kc, out ct); } catch {}
            string nm = null;
            try { var kn = WPD_OBJECT_ORIGINAL_FILE_NAME; vals.GetStringValue(ref kn, out nm); } catch {}
            if(string.IsNullOrEmpty(nm)){ try { var kn = WPD_OBJECT_NAME; vals.GetStringValue(ref kn, out nm); } catch {} }
            // Full release is essential: a lingering ref makes the device
            // progressively stall (rate collapses ~200x after a few thousand).
            try { Marshal.FinalReleaseComObject(vals); } catch {}
            map[oid] = new ObjInfo { Name = nm, Ct = ct };
            _viaPerObject++;
        }
        _msPerObject += (long)(DateTime.UtcNow - t1).TotalMilliseconds;
        return map;
    }

    // Stream one resource of one object to a file. isThumb=true -> the small JPEG
    // thumbnail; false -> WPD_RESOURCE_DEFAULT (the full original file). Returns
    // bytes written, or -1 on failure.
    public static long SaveResource(string deviceId, string oid, bool isThumb, string outPath){
        long total = -1;
        IPortableDevice dev = null; IPortableDeviceContent content = null; IPortableDeviceResources res = null;
        try {
            dev = OpenDevice(deviceId);
            dev.Content(out content);
            content.Transfer(out res);
            PROPERTYKEY key; key.fmtid = isThumb ? RES_THUMBNAIL : RES_DEFAULT_FMTID; key.pid = 0;
            uint optimal=0; ComTypes.IStream stream;
            res.GetStream(oid, ref key, 0, ref optimal, out stream);
            using(var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write)){
                var buf = new byte[optimal>0?(int)optimal:262144]; IntPtr pcb=Marshal.AllocHGlobal(4); total=0;
                while(true){ stream.Read(buf, buf.Length, pcb); int r=Marshal.ReadInt32(pcb); if(r<=0) break; fs.Write(buf,0,r); total+=r; }
                Marshal.FreeHGlobal(pcb);
            }
            Rel(stream);
        } catch { total = -1; }
        finally { Rel(res); Rel(content); CloseDevice(dev); }
        return total;
    }

    // Capture date for ONE object (cheap for a single item; too slow for all).
    public static string GetDate(string deviceId, string oid){
        string dt = null;
        IPortableDevice dev = null; IPortableDeviceContent content = null; IPortableDeviceProperties props = null;
        IPortableDeviceKeyCollection keys = null;
        try {
            dev = OpenDevice(deviceId);
            dev.Content(out content);
            content.Properties(out props);
            keys = (IPortableDeviceKeyCollection)CreateCom(CLSID_KeyCollection);
            var k = WPD_OBJECT_DATE_CREATED; keys.Add(ref k);
            IPortableDeviceValues v; props.GetValues(oid, keys, out v);
            try { var kk = WPD_OBJECT_DATE_CREATED; v.GetStringValue(ref kk, out dt); } catch {}
            Rel(v);
        } catch {}
        finally { Rel(keys); Rel(props); Rel(content); CloseDevice(dev); }
        return dt;
    }

    // Does an object still exist on the device? (opens its own session.) Used to
    // confirm a delete without re-enumerating the whole library.
    public static bool ObjectExists(string deviceId, string oid){
        IPortableDevice dev = null; IPortableDeviceContent content = null; IPortableDeviceProperties props = null;
        IPortableDeviceKeyCollection keys = null;
        try {
            dev = OpenDevice(deviceId);
            dev.Content(out content);
            content.Properties(out props);
            keys = (IPortableDeviceKeyCollection)CreateCom(CLSID_KeyCollection);
            var k = WPD_OBJECT_NAME; keys.Add(ref k);
            bool exists;
            try {
                IPortableDeviceValues v; props.GetValues(oid, keys, out v);
                string nm=null; try { var kk=WPD_OBJECT_NAME; v.GetStringValue(ref kk, out nm); } catch {}
                Rel(v);
                exists = (nm != null);
            } catch { exists = false; }
            return exists;
        } catch { return true; }   // can't tell → assume present (reports as not-deleted)
        finally { Rel(keys); Rel(props); Rel(content); CloseDevice(dev); }
    }

    // Delete objects from the device by object id (frees phone storage). Returns a
    // JSON array [{oid,hr,exists}] so the caller can tell, per object, the delete
    // HRESULT AND whether it's actually gone (some devices return S_OK but keep the
    // file, or refuse with an access-denied HRESULT). VT_LPWSTR = 31.
    // Deletes are issued ONE OBJECT PER CALL, on purpose. Handing Delete() a
    // multi-object collection makes this device (Huawei P30 Pro, verified)
    // return a NULL results collection — no per-object status at all, and the
    // NullReferenceException that caused was swallowed, leaving every HRESULT
    // reported as 0. A single-object delete returns a proper result (rc=1,
    // VT_ERROR scode), and it's the only form confirmed to actually remove a
    // real photo. One call per object also gives a per-object stderr heartbeat,
    // so a big selection can't sit silent long enough for the watchdog to kill
    // us mid-delete (which would leak the MTP session and wedge the device).
    public static string DeleteObjectsDiag(string deviceId, string[] oids){
        IPortableDevice dev = null;
        IPortableDeviceContent content = null;
        IPortableDeviceProperties props = null;
        IPortableDeviceKeyCollection nameKeys = null;
        var sb = new StringBuilder();
        var hrs = new int[oids.Length];
        var hrKnown = new bool[oids.Length];
        try {
            dev = OpenDevice(deviceId);
            dev.Content(out content);
            content.Properties(out props);
            nameKeys = (IPortableDeviceKeyCollection)CreateCom(CLSID_KeyCollection);
            var kn = WPD_OBJECT_NAME; nameKeys.Add(ref kn);

            for(int i=0;i<oids.Length;i++){
                Console.Error.WriteLine("DELETING " + (i+1) + "/" + oids.Length);
                IPortableDevicePropVariantCollection coll = null;
                try {
                    coll = (IPortableDevicePropVariantCollection)CreateCom(CLSID_PropVariantCollection);
                    PROPVARIANT pv = new PROPVARIANT(); pv.vt=31; pv.p=Marshal.StringToCoTaskMemUni(oids[i]);
                    coll.Add(ref pv);
                    Marshal.FreeCoTaskMem(pv.p);
                    IPortableDevicePropVariantCollection results = null;
                    content.Delete(0, coll, out results);   // 0 = no recursion
                    if(results != null){
                        try {
                            uint rc=0; results.GetCount(ref rc);
                            if(rc>0){
                                PROPVARIANT rv; results.GetAt(0, out rv);
                                hrs[i] = (int)(rv.p.ToInt64() & 0xFFFFFFFF);   // VT_ERROR scode
                                hrKnown[i] = true;
                            }
                        } catch {}
                        Rel(results);
                    }
                } catch (Exception ex) { hrs[i] = ex.HResult; hrKnown[i] = true; }
                finally { Rel(coll); }
            }
            Console.Error.WriteLine("DELETED, verifying");

            // Let the device finish applying the delete before we ask about the
            // objects again — querying a just-deleted handle is what some drivers
            // choke on.
            Thread.Sleep(250);

            sb.Append('[');
            for(int i=0;i<oids.Length;i++){
                bool exists;
                try {
                    IPortableDeviceValues v; props.GetValues(oids[i], nameKeys, out v);
                    string nm=null; try { var k=WPD_OBJECT_NAME; v.GetStringValue(ref k, out nm); } catch {}
                    Rel(v);
                    exists = (nm != null);
                } catch { exists = false; }
                if(i>0) sb.Append(',');
                sb.Append("{\"oid\":"); JsonEsc(sb, oids[i]);
                // null, not 0: "the device told us nothing" must not read as S_OK.
                sb.Append(",\"hr\":"); sb.Append(hrKnown[i] ? hrs[i].ToString() : "null");
                sb.Append(",\"exists\":"); sb.Append(exists?"true":"false"); sb.Append('}');
                if((i & 7)==0) Console.Error.WriteLine("VERIFY " + (i+1) + "/" + oids.Length);
            }
            sb.Append(']');
        } finally {
            // Children first, device last, and Close() before the release —
            // otherwise the session outlives this process and the next read hangs.
            Rel(nameKeys); Rel(props); Rel(content);
            CloseDevice(dev);
            Console.Error.WriteLine("session closed");
        }
        return sb.ToString();
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
        IPortableDevice dev = null; IPortableDeviceContent content = null; IPortableDeviceResources res = null;
        try {
            dev = OpenDevice(deviceId);
            dev.Content(out content);
            content.Transfer(out res);
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
                    Rel(stream);
                    File.WriteAllBytes(outPaths[i], ms.ToArray());
                    ok++;
                } catch {}
            }
        } finally { Rel(res); Rel(content); CloseDevice(dev); }
        return ok;
    }

    // Runs the scan on a dedicated MTA thread. PowerShell hosts us on an STA, and
    // the bulk callback arrives on a WPD worker thread — on an STA that call gets
    // marshalled back to the thread already blocked in WaitOne, and the scan
    // deadlocks. An MTA thread takes the callback directly. The big stack is for
    // the folder recursion.
    public static string ListResultJsonMta(string deviceId, string deviceName, int maxCount){
        string res = null; Exception err = null;
        var t = new Thread(delegate(){
            try { res = ListResultJson(deviceId, deviceName, maxCount); }
            catch(Exception ex){ err = ex; }
        }, 16 * 1024 * 1024);
        t.SetApartmentState(ApartmentState.MTA);
        t.IsBackground = true;
        t.Start();
        t.Join();
        if(err != null) throw err;
        return res;
    }

    public static string ListResultJson(string deviceId, string deviceName, int maxCount){
        IPortableDevice dev = null; IPortableDeviceContent content = null; IPortableDeviceProperties props = null;
        IPortableDeviceKeyCollection keys = null;
        try {
            Console.Error.WriteLine("opening device session...");
            dev = OpenDevice(deviceId);
            dev.Content(out content);
            content.Properties(out props);
            keys = (IPortableDeviceKeyCollection)CreateCom(CLSID_KeyCollection);
            var k0 = WPD_OBJECT_ID; keys.Add(ref k0);   // bulk results come back unordered
            var k1 = WPD_OBJECT_ORIGINAL_FILE_NAME; keys.Add(ref k1);
            var k2 = WPD_OBJECT_NAME; keys.Add(ref k2);
            var k3 = WPD_OBJECT_CONTENT_TYPE; keys.Add(ref k3);

            _bulk = props as IPortableDevicePropertiesBulk;   // null on devices without it
            _bulkOk = (_bulk != null); _bulkFails = 0;
            Console.Error.WriteLine(_bulkOk ? "bulk property reads: yes" : "bulk property reads: no (per-object)");

            _sb = new StringBuilder(1<<20); _sb.Append('[');
            _first=true; _count=0; _media=0; _max=maxCount;
            _viaBulk=0; _viaPerObject=0; _msBulk=0; _msPerObject=0;
            Walk(content, props, keys, "DEVICE", "", true);
            _sb.Append(']');
            LastCount = _media;
            Console.Error.WriteLine("timing: bulk " + _viaBulk + " objs in " + _msBulk + "ms"
                + " | per-object " + _viaPerObject + " objs in " + _msPerObject + "ms");
        } finally {
            _bulk = null;
            Rel(keys); Rel(props); Rel(content);
            CloseDevice(dev);
            Console.Error.WriteLine("session closed");
        }

        var outp = new StringBuilder(_sb.Length + 64);
        outp.Append("{\"ok\":true,\"device\":"); JsonEsc(outp, deviceName ?? "Phone");
        outp.Append(",\"count\":"); outp.Append(_media);
        outp.Append(",\"items\":"); outp.Append(_sb.ToString()); outp.Append('}');
        return outp.ToString();
    }

    static void Walk(IPortableDeviceContent content, IPortableDeviceProperties props,
                     IPortableDeviceKeyCollection keys, string parentId, string prefix, bool atDevice){
        if(_max>0 && _media>=_max) return;
        // Entering a folder is a heartbeat for the Node-side idle watchdog.
        if(prefix.Length>0) Console.Error.WriteLine("SCAN " + prefix);

        // 1) Object ids in this folder. EnumObjects is cheap — it's the property
        //    reads that cost, so gather the whole folder before asking for them.
        var oids = new List<string>();
        IEnumPortableDeviceObjectIDs e; content.EnumObjects(0, parentId, null, out e);
        const uint BATCH=64; var arr=new string[BATCH]; uint fetched;
        do {
            fetched=0; e.Next(BATCH, arr, ref fetched);
            for(uint i=0;i<fetched;i++) oids.Add(arr[i]);
        } while(fetched>0);
        try { Marshal.FinalReleaseComObject(e); } catch {}

        // 2) One bulk transaction for the whole folder where the device supports it.
        var info = FetchProps(props, keys, oids);

        // 3) Emit files; queue folders and recurse once this folder's data is done.
        var subs = new List<string[]>();   // {oid, childPrefix}
        foreach(var oid in oids){
            if(_max>0 && _media>=_max) break;
            _count++;
            if((_count & 0x7FF)==0){ GC.Collect(); GC.WaitForPendingFinalizers(); }

            ObjInfo oi;
            if(!info.TryGetValue(oid, out oi)) continue;
            string nm = string.IsNullOrEmpty(oi.Name) ? oid : oi.Name;

            bool container=(oi.Ct==CT_FOLDER || oi.Ct==CT_FUNCTIONAL);
            if(container){
                // Never filter a whole storage (device-level child). At the
                // storage's top level, only descend into real photo folders;
                // deeper down, prune cache/hidden junk.
                if(!atDevice){
                    if(prefix.Length==0){ if(!AllowTopFolder(nm)) continue; }
                    else if(SkipFolder(nm)) continue;
                }
                string np = atDevice ? "" : (prefix.Length==0 ? nm : prefix + "/" + nm);
                subs.Add(new string[]{ oid, np });
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
                    if((_media % 200)==0) Console.Error.WriteLine("PROGRESS " + _media);
                }
            }
        }
        info.Clear();
        foreach(var s in subs) Walk(content, props, keys, s[0], s[1], false);
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
        # Prefer WPD enumeration: it returns the same friendly names + object ids
        # the fast backend matches on, and it lists iPhone AND Android alike.
        if (Ensure-WpdType) {
            try {
                $json = [Wpd]::ListDevicesJson()
                # NOTE: ConvertFrom-Json '[]' yields $null in PS 5.1, and @($null)
                # has Count 1 — so filter to real objects with a name before testing.
                $arr = @(($json | ConvertFrom-Json) | Where-Object { $_ -and $_.name })
                if ($arr.Count -gt 0) {
                    $names = @()
                    foreach ($d in $arr) { $names += @{ name = $d.name; mfr = $d.mfr; phone = [bool]$d.phone } }
                    Emit @{ ok = $true; devices = @($names) }
                    exit 0
                }
            } catch { Write-Log "wpd devices failed, shell fallback: $($_.Exception.Message)" }
        }
        # Fallback: Shell enumeration of "This PC" portable devices.
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
        # Shell scan if WPD is unavailable or finds no phone.
        $devName = if ($Device -ne '') { $Device } else { 'Phone' }
        if (Ensure-WpdType) {
            $devId = $null
            try { $devId = [Wpd]::FindDeviceId($Device) } catch { Write-Log "wpd: find failed: $($_.Exception.Message)" }
            if ($devId) {
                try {
                    Write-Log "fast scan via WPD..."
                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $json = [Wpd]::ListResultJsonMta($devId, $devName, $Max)
                    Write-Log "wpd: $([Wpd]::LastCount) media files in $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
                    [Console]::Out.WriteLine($json)
                    exit 0
                } catch { Write-Log "wpd: enumerate failed, falling back to Shell: $($_.Exception.Message)" }
            } else {
                Write-Log "wpd: no phone via WPD, falling back to Shell"
            }
        }
        # Fallback: Shell enumeration.
        $shell = Get-Shell
        $dev = Select-DeviceItem $shell $Device
        if ($null -eq $dev) { Fail 'no phone found. Connect your phone and unlock it. iPhone: tap "Trust". Android: pull down the notification and set USB use to "File transfer / MTP".' }
        Write-Log "scanning device folders on '$($dev.Name)'..."
        $dcim = Get-PhotoRoot $dev.GetFolder
        if ($null -eq $dcim) { Fail "device '$($dev.Name)' found but its storage is not accessible. Unlock the phone (iPhone: tap Trust; Android: switch USB use to File transfer / MTP)." }
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
        if ($null -eq $dev) { Fail 'no phone found.' }
        $dcim = Get-PhotoRoot $dev.GetFolder
        if ($null -eq $dcim) { Fail 'phone storage not accessible.' }
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
        # Thumbnails by object id. Input is a JSON array of { id, oid }.
        # Phase 1 (fast): the device-provided WPD thumbnail (embedded JPEG). Camera
        #   photos have one; it's ~50ms each and needs no decode.
        # Phase 2 (fallback): many files have NO embedded thumbnail — PNG
        #   screenshots, re-encoded/downloaded/chat JPEGs (WeChat etc.), and HEIC on
        #   some devices. For those we transfer the full file and render a small
        #   thumbnail locally via the Windows codec (same path 'preview' uses).
        #   Video is skipped here (a full transfer just for a grid thumb is too
        #   costly). Output files named by id-hash.
        if ($OutDir -eq '') { Fail 'thumb: -OutDir required' }
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        $OutDir = [System.IO.Path]::GetFullPath($OutDir)   # ShellThumb needs absolute paths
        $items = Read-Ids $InputFile
        if (-not (Ensure-WpdType)) { Fail 'wpd engine unavailable' }
        $devId = $null
        try { $devId = [Wpd]::FindDeviceId($Device) } catch {}
        if (-not $devId) { Fail 'no phone (WPD).' }

        $sha = New-Object Security.Cryptography.SHA1Managed
        $results = @()
        $fetchOids = New-Object System.Collections.ArrayList
        $fetchOuts = New-Object System.Collections.ArrayList
        foreach ($it in $items) {
            $id = $it.id; $oid = $it.oid
            $hash = [System.BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($id))).Replace('-', '').Substring(0, 16)
            $outPath = Join-Path $OutDir ("$hash.jpg")
            $results += @{ id = $id; oid = $oid; thumb = $null; _out = $outPath }
            if ((Test-Path -LiteralPath $outPath) -or -not $oid) { continue }
            [void]$fetchOids.Add($oid)
            [void]$fetchOuts.Add($outPath)
        }
        # Phase 1: device-provided WPD thumbnails.
        if ($fetchOids.Count -gt 0) {
            try { [void][Wpd]::SaveThumbnails($devId, $fetchOids.ToArray(), $fetchOuts.ToArray()) }
            catch { Write-Log "wpd thumb failed: $($_.Exception.Message)" }
        }
        # Phase 2: local render for whatever phase 1 couldn't produce.
        $videoExt = @('.mov', '.mp4', '.m4v', '.avi')
        $needRender = @($results | Where-Object { $_.oid -and -not (Test-Path -LiteralPath $_._out) })
        if ($needRender.Count -gt 0 -and (Ensure-ThumbType)) {
            foreach ($r in $needRender) {
                $ext = ([System.IO.Path]::GetExtension($r.id)).ToLowerInvariant()
                if ($videoExt -contains $ext) { continue }
                Write-Log "RENDER $($r.id)"   # stderr heartbeat keeps the idle watchdog alive
                $base = [System.IO.Path]::GetFileNameWithoutExtension($r._out)
                $tmp = Join-Path $OutDir ("$base.orig$ext")
                try {
                    $n = [Wpd]::SaveResource($devId, $r.oid, $false, $tmp)
                    if ($n -gt 0) { try { [void][ShellThumb]::Save($tmp, $Size, $r._out) } catch { Write-Log "render failed $($r.id): $($_.Exception.Message)" } }
                } catch { Write-Log "transfer failed $($r.id): $($_.Exception.Message)" }
                finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            }
        }
        foreach ($r in $results) {
            if (Test-Path -LiteralPath $r._out) { $r.thumb = $r._out }
            $r.Remove('_out'); $r.Remove('oid')
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
        $devId = $null; try { $devId = [Wpd]::FindDeviceId($Device) } catch {}
        if (-not $devId) { Fail 'no phone (WPD).' }

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
        $devId = $null; try { $devId = [Wpd]::FindDeviceId($Device) } catch {}
        if (-not $devId) { Fail 'no phone (WPD).' }
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
        # Delete objects from the phone to free storage. Input [{id,oid}].
        # WPD delete (fast, batch) with per-object HRESULT + existence check. No
        # full re-enumeration (that cost ~90s on a big library); existence is
        # confirmed per object. On failure the HRESULT is surfaced so we can tell a
        # device that refuses deletion (e.g. iPhone: iOS blocks MTP delete of the
        # camera roll) from something fixable.
        $items = Read-Ids $InputFile
        if (-not (Ensure-WpdType)) { Fail 'wpd unavailable' }
        $devId = $null; try { $devId = [Wpd]::FindDeviceId($Device) } catch {}
        if (-not $devId) { Fail 'no phone (WPD).' }
        $oids = @(); foreach ($it in $items) { if ($it.oid) { $oids += $it.oid } }

        $diag = @{}
        if ($oids.Count -gt 0) {
            try {
                $diagJson = [Wpd]::DeleteObjectsDiag($devId, $oids)
                # MUST assign before @(): PS 5.1 hands a multi-element JSON array
                # to the pipeline as ONE object, so the inline
                # `@($diagJson | ConvertFrom-Json)` collapsed to Count=1. $d then
                # became the whole array, $d.oid member-enumerated to an array of
                # oids, and the hashtable key turned into "System.Object[]" — so
                # every per-item lookup missed and multi-select delete reported
                # "设备拒绝删除 (HRESULT ?)" for all of them. A single delete only
                # worked by luck (1-element member enumeration unwraps to the
                # string). Same family as the ConvertFrom-Json '[]' -> $null trap
                # in the devices action below.
                $parsed = $diagJson | ConvertFrom-Json
                foreach ($d in @($parsed)) { $diag[[string]$d.oid] = $d }
            } catch { Write-Log "wpd delete failed: $($_.Exception.Message)" }
        }

        # Report per-item, using the (authoritative) existence check.
        $results = @()
        foreach ($it in $items) {
            if (-not $it.oid) { $results += @{ id = $it.id; ok = $false; error = 'no object id' }; continue }
            $d = $diag[[string]$it.oid]
            $gone = ($null -ne $d) -and (-not $d.exists)
            if ($gone) {
                $results += @{ id = $it.id; ok = $true; error = $null }
            } else {
                # The file is still on the phone. Say WHY as precisely as the
                # device let us know — hr 0 means it claimed success and kept the
                # file anyway, which is a different problem from a refusal.
                # ($null -ne, not truthiness: hr = 0 is S_OK, and 0 is falsy.)
                $why =
                    if ($null -eq $d) { '设备没有返回该文件的删除结果' }
                    elseif ($null -eq $d.hr) { '设备没有回报删除结果，且文件仍在手机上' }
                    elseif ([int64]$d.hr -eq 0) { '设备报告删除成功，但文件仍在手机上（可能被相册/图库应用占用）' }
                    else { '设备拒绝删除 (HRESULT 0x{0:X8})' -f ([int64]$d.hr -band 0xFFFFFFFF) }
                $results += @{ id = $it.id; ok = $false; error = $why }
            }
        }
        Emit @{ ok = $true; results = @($results) }
        exit 0
    }
}
