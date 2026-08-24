'use strict';

/*
 * Native folder picker. Pops the real OS dialog (Windows Explorer / Linux
 * zenity or kdialog / macOS Finder) and returns the folder the user chose.
 *
 * Kept as its own module for two reasons:
 *   - the spawn layer is injectable, so the guard below is unit-testable;
 *   - Windows is slow to reach a dialog: Windows PowerShell 5.1 has to boot
 *     and then Add-Type compiles the C# helper with the full C# compiler on
 *     every call. The compiled DLL is cached in the temp folder keyed by a
 *     hash of its source, so the second pick onwards just loads the assembly
 *     instead of recompiling it.
 *
 * The module runs one dialog at a time: while one is open, a second call
 * throws an error carrying code PICKER_BUSY instead of stacking another OS
 * dialog on top.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PICKER_BUSY = 'PICKER_BUSY';
const PICKER_UNAVAILABLE = 'PICKER_UNAVAILABLE';
const PICKER_TIMEOUT = 'PICKER_TIMEOUT';

// How long a dialog may stay open before we assume it is never coming back.
// Generous enough that someone genuinely browsing for a folder is not cut off,
// short enough that a dialog which failed to reach the screen cannot hold the
// one-at-a-time guard - and the caller's Browse button - shut for good.
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_TITLE = 'Select the parent folder for the new server';

/* ---------------------------------------------------------------------------
 * Windows modern dialog (IFileOpenDialog with FOS_PICKFOLDERS).
 * ------------------------------------------------------------------------- */

const MODERN_DIALOG_CS = `
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class ModernFolderDialog
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRcw { }

    // Vtable order MUST match the COM definition of IFileOpenDialog:
    // IModalWindow (1) + IFileDialog (17) + IFileOpenDialog (8) = 26 entries.
    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        [PreserveSig] int SetFileTypeIndex(uint iFileType);
        [PreserveSig] int GetFileTypeIndex(out uint piFileType);
        [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
        [PreserveSig] int Unadvise(uint dwCookie);
        [PreserveSig] int SetOptions(uint fos);
        [PreserveSig] int GetOptions(out uint pfos);
        [PreserveSig] int SetDefaultFolder(IntPtr psi);
        [PreserveSig] int SetFolder(IntPtr psi);
        [PreserveSig] int GetFolder(out IntPtr ppsi);
        [PreserveSig] int GetCurrentSelection(out IntPtr ppsi);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        [PreserveSig] int GetResult(out IntPtr ppsi);
        [PreserveSig] int AddPlace(IntPtr psi, int fdap);
        [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        [PreserveSig] int Close(int hr);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr pFilter);
        [PreserveSig] int GetResults(out IntPtr ppenum);
        [PreserveSig] int GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IntPtr ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IntPtr psi, uint hint, out int piOrder);
    }

    public static string Pick(string title, string initialPath)
    {
        const uint FOS_PICKFOLDERS = 0x20;
        const uint FOS_FORCEFILESYSTEM = 0x40;
        // 0x800704C7 (ERROR_CANCELLED) overflows int; the old C# compiler
        // used by Windows PowerShell 5.1's Add-Type rejects the bare hex
        // literal in an int comparison, so cast it via unchecked().
        const int HRESULT_CANCELLED = unchecked((int)0x800704C7);

        IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogRcw();
        dlg.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        dlg.SetTitle(title);

        if (!string.IsNullOrEmpty(initialPath) && Directory.Exists(initialPath))
        {
            Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
            IntPtr item;
            if (SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref iid, out item) == 0 && item != IntPtr.Zero)
            {
                dlg.SetFolder(item);
                Marshal.Release(item);
            }
        }

        // Anchor the dialog to the user's current foreground window (the
        // browser) so it pops on top of it instead of being orphaned. The
        // spawned PowerShell has no visible parent of its own.
        IntPtr parent = GetForegroundWindow();
        if (parent != IntPtr.Zero) SetForegroundWindow(parent);

        int hr = dlg.Show(parent);
        // hr == 0: user pressed OK
        // hr == 0x800704C7 (ERROR_CANCELLED): user pressed Cancel
        if (hr == 0) {
            IntPtr resultPtr;
            if (dlg.GetResult(out resultPtr) != 0 || resultPtr == IntPtr.Zero) return "__ERROR__:GetResult failed (0x" + Marshal.GetLastWin32Error().ToString("X") + ")";
            IShellItem item2 = (IShellItem)Marshal.GetTypedObjectForIUnknown(resultPtr, typeof(IShellItem));
            string path;
            item2.GetDisplayName(0x80058000, out path);
            Marshal.ReleaseComObject(item2);
            Marshal.Release(resultPtr);
            return path;
        }
        if (hr == HRESULT_CANCELLED) return "__CANCELLED__";
        return "__ERROR__:Show returned 0x" + hr.ToString("X");
    }
}
`;

// A PowerShell-safe single-quoted string: '' escapes a literal quote, and
// nothing else is interpolated inside single quotes, so paths that contain $,
// backticks or backslashes survive the trip intact.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cacheDir() {
  return path.join(os.tmpdir(), 'fleetdeck-folder-picker');
}

// The DLL name is derived from the C# source, so changing the helper gets a
// fresh file instead of silently running a stale one.
function cacheDllPath() {
  const hash = crypto.createHash('sha1').update(MODERN_DIALOG_CS).digest('hex').slice(0, 12);
  return path.join(cacheDir(), `ModernFolderDialog-${hash}.dll`);
}

/*
 * The PowerShell that runs the modern dialog. The DLL is compiled once, on the
 * first run that finds the cache empty, and every run then loads it from a
 * per-run copy. The copy exists because Add-Type locks the loaded file, and a
 * lock on the cache itself would break every later panel while this one is
 * open.
 *
 * Compile and load are separate steps on purpose: `Add-Type -OutputAssembly`
 * writes the assembly to disk but does not load the type into the session, so
 * the run that compiled it has to load it back like any other. Folding the
 * load into the "already cached" branch is what left the first pick on a fresh
 * machine failing with "Unable to find type [ModernFolderDialog]" - and, from
 * there, falling through to the legacy dialog for no reason.
 *
 * Kept as a pure function so the compile-vs-reuse shape is testable without a
 * Windows box.
 */
function buildWindowsScript({ dll, title, defaultPath }) {
  const cache = path.dirname(dll);
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `$src = @'\n${MODERN_DIALOG_CS}\n'@`,
    `try {`,
    `  if (-not (Test-Path -LiteralPath ${psQuote(dll)})) {`,
    `    $tmp = Join-Path ${psQuote(cache)} ('HostkindPickerCompile-' + [guid]::NewGuid().ToString('N') + '.dll')`,
    `    Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $tmp`,
    `    Move-Item -LiteralPath $tmp -Destination ${psQuote(dll)} -Force`,
    `  }`,
    `  $run = Join-Path ${psQuote(cache)} ('HostkindPickerRun-' + [guid]::NewGuid().ToString('N') + '.dll')`,
    `  Copy-Item -LiteralPath ${psQuote(dll)} -Destination $run -Force`,
    `  Add-Type -Path $run`,
    `  $p = [ModernFolderDialog]::Pick(${psQuote(title)}, ${psQuote(defaultPath || '')})`,
    // Cancelling is neither a path nor an error, and it is tested for first:
    // the sentinel is a non-empty string that does not start with __ERROR__,
    // so a success-shaped test ahead of it swallows the cancel and prints
    // "__CANCELLED__" as though the user had chosen a folder by that name.
    `  if ($p -eq '__CANCELLED__') {`,
    `    exit 2`,
    `  } elseif ($p -and -not $p.StartsWith('__ERROR__')) {`,
    `    [Console]::Out.WriteLine($p); exit 0`,
    `  } else {`,
    `    [Console]::Error.WriteLine('FOLDERPICKER_ERR:' + $p); exit 1`,
    `  }`,
    `} catch {`,
    `  [Console]::Error.WriteLine('FOLDERPICKER_ERR:' + $_.Exception.Message)`,
    `  exit 1`,
    `}`,
  ].join('\n');
  return ps;
}

/* ---------------------------------------------------------------------------
 * Platform helpers. Each resolves to { status, stdout, stderr, error } where
 * `error` is the spawn error (e.g. ENOENT) when the command never started, or
 * { timedOut: true } when the dialog outlived its welcome and was killed.
 * ------------------------------------------------------------------------- */

function spawnResult(spawnFn, cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { encoding: 'utf8', windowsHide: true });
    } catch (err) {
      return resolve({ error: err, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A dialog that never draws never closes, and the caller would wait on it
    // forever. Killing the process closes any dialog it did manage to open.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs || DIALOG_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (err) => finish({ error: err, stdout, stderr }));
    child.once('close', (code) => finish({ status: code, stdout, stderr }));
  });
}

async function pickFolderWindows(defaultPath, title, spawnFn, timeoutMs) {
  const dll = cacheDllPath();
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
  } catch { /* the picker can still run, it will just recompile */ }
  const script = buildWindowsScript({ dll, title, defaultPath });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const modern = await spawnResult(spawnFn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], timeoutMs);
  // The modern IFileOpenDialog path errored (exit 1): fall back to the legacy
  // Windows.Forms FolderBrowserDialog so the Browse button at least works.
  // Cancellation (exit 2) is passed through as-is, and so is a timeout - a
  // dialog we just killed for hanging is no reason to open a second one.
  if (modern.status === 1) return pickFolderWindowsLegacy(defaultPath, title, spawnFn, timeoutMs);
  return modern;
}

/*
 * Fallback: the older Windows.Forms FolderBrowserDialog. It shows a tree-style
 * picker instead of the modern Explorer one, but it ships in every .NET
 * Framework since 1.1. We only set properties that exist on every supported
 * framework version (Description and ShowNewFolderButton) - UseDescriptionForTitle
 * and the description-as-title trick are .NET 4.0+ only and aren't on every
 * PowerShell host.
 *
 * ShowDialog() gets an explicit owner because it is spawned from a windowless
 * process: with nothing to sit in front of, the dialog came up behind the
 * panel and the pick blocked on a window nobody could see. The owner is a
 * top-most 1x1 form parked off-screen, so the picker is pulled to the front
 * without a second window showing up on screen or in the taskbar.
 */
function buildWindowsLegacyScript({ title, defaultPath }) {
  return [
    `try {`,
    `  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop | Out-Null`,
    `  $owner = New-Object System.Windows.Forms.Form`,
    `  $owner.StartPosition = 'Manual'`,
    `  $owner.Left = -32000; $owner.Top = -32000; $owner.Width = 1; $owner.Height = 1`,
    `  $owner.ShowInTaskbar = $false`,
    `  $owner.TopMost = $true`,
    `  $owner.Show()`,
    `  $f = New-Object System.Windows.Forms.FolderBrowserDialog`,
    `  $f.Description = ${psQuote(title)}`,
    `  $f.ShowNewFolderButton = $true`,
    defaultPath
      ? `  try { $f.SelectedPath = (Resolve-Path -LiteralPath ${psQuote(defaultPath)} -ErrorAction Stop).ProviderPath } catch {}`
      : '',
    `  $result = $f.ShowDialog($owner)`,
    `  $owner.Close()`,
    `  if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($f.SelectedPath); exit 0 } else { exit 2 }`,
    `} catch {`,
    `  [Console]::Error.WriteLine('FOLDERPICKER_ERR:' + $_.Exception.Message); exit 1`,
    `}`,
  ].filter(Boolean).join('\n');
}

function pickFolderWindowsLegacy(defaultPath, title, spawnFn, timeoutMs) {
  const encoded = Buffer.from(buildWindowsLegacyScript({ title, defaultPath }), 'utf16le').toString('base64');
  return spawnResult(spawnFn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], timeoutMs);
}

async function pickFolderLinux(defaultPath, title, spawnFn, timeoutMs) {
  // Try the desktop's own native file chooser in order:
  //   zenity  - GTK dialog (GNOME / Nautilus desktops)
  //   kdialog - Qt dialog  (KDE / Dolphin desktops)
  //   python3 - tkinter fallback (any desktop, incl. Dolphin without kdialog)
  const start = defaultPath ? defaultPath.replace(/'/g, "'\\''") + '/' : '';
  const zenityArgs = ['--file-selection', '--directory', `--title=${title}`, `--filename=${start}`];
  let r = await spawnResult(spawnFn, 'zenity', zenityArgs, timeoutMs);
  if (r.error && r.error.code === 'ENOENT') {
    r = await spawnResult(spawnFn, 'kdialog', ['--getexistingdirectory', defaultPath || os.homedir()], timeoutMs);
  }
  if (r.error && r.error.code === 'ENOENT') {
    const py = [
      'import sys, tkinter, tkinter.filedialog',
      'root = tkinter.Tk()',
      'root.withdraw()',
      'root.attributes("-topmost", True)',
      'd = tkinter.filedialog.askdirectory(title=sys.argv[2], initialdir=sys.argv[1])',
      'print(d, end="")',
    ].join('\n');
    r = await spawnResult(spawnFn, 'python3', ['-c', py, defaultPath || os.homedir(), title], timeoutMs);
  }
  return r;
}

function pickFolderMacos(defaultPath, title, spawnFn, timeoutMs) {
  const def = defaultPath ? `default location POSIX file ${JSON.stringify(defaultPath)}` : '';
  const script = `set _f to choose folder with prompt ${JSON.stringify(title)} ${def}\nPOSIX path of _f`;
  return spawnResult(spawnFn, 'osascript', ['-e', script], timeoutMs);
}

/* ---------------------------------------------------------------------------
 * Public entry point with the one-at-a-time guard.
 * ------------------------------------------------------------------------- */

let inFlight = false;

async function pickFolder(defaultPath = '', title = DEFAULT_TITLE, deps = {}) {
  if (inFlight) {
    const err = new Error('Another folder picker is already open.');
    err.code = PICKER_BUSY;
    throw err;
  }
  const platform = deps.platform || process.platform;
  const spawnFn = deps.spawn || spawn;
  const timeoutMs = deps.timeoutMs || DIALOG_TIMEOUT_MS;
  inFlight = true;
  try {
    let r;
    if (platform === 'win32') r = await pickFolderWindows(defaultPath, title, spawnFn, timeoutMs);
    else if (platform === 'darwin') r = await pickFolderMacos(defaultPath, title, spawnFn, timeoutMs);
    else r = await pickFolderLinux(defaultPath, title, spawnFn, timeoutMs);

    if (r.timedOut) {
      const err = new Error('The folder picker did not respond and was closed.');
      err.code = PICKER_TIMEOUT;
      throw err;
    }
    if (r.error) {
      const err = new Error(r.error.message);
      err.code = PICKER_UNAVAILABLE;
      throw err;
    }
    if (r.status === 0) {
      const out = String(r.stdout || '').replace(/\r?\n$/, '');
      if (!out) return { cancelled: true };
      return { path: out };
    }
    // Exit 2 = explicit "user cancelled" (modern IFileOpenDialog or legacy
    // FolderBrowserDialog). Anything else is a real error: pull the
    // FOLDERPICKER_ERR: prefix the helpers write so the toast is clean
    // instead of the raw PowerShell CLIXML noise.
    if (r.status === 2) return { cancelled: true };
    const allOut = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const m = allOut.match(/FOLDERPICKER_ERR:\s*([^\r\n]+)/);
    const err = new Error(m ? m[1].trim() : `Folder picker exited with code ${r.status}`);
    err.code = 'PICKER_FAILED';
    throw err;
  } finally {
    inFlight = false;
  }
}

function __resetInFlight() {
  inFlight = false;
}

module.exports = {
  pickFolder,
  PICKER_BUSY,
  PICKER_UNAVAILABLE,
  PICKER_TIMEOUT,
  buildWindowsScript,
  buildWindowsLegacyScript,
  cacheDllPath,
  cacheDir,
  psQuote,
  __resetInFlight,
};
