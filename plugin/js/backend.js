/*
 * backend.js — Node bridge between the Eagle plugin UI and the phone backend
 * (scripts/iphone.ps1 — handles iPhone AND Android over WPD/MTP; filename kept
 * for backward compatibility). Spawns PowerShell, passes item ids through temp
 * JSON files, parses the single JSON object the script prints on stdout.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'iphone.ps1');

// All temp files/dirs must live under an ASCII, all-users-writable path.
// os.tmpdir() lives under the user profile, so a non-ASCII Windows username
// (e.g. "魏培") produces a path that gets mangled when passed as a PowerShell
// argument — which silently breaks thumbnails/preview/copy (but not listing).
let CACHE_BASE = null;
function tryDir(d) {
  // eslint-disable-next-line no-control-regex
  if (!d || /[^\x00-\x7F]/.test(d)) return null;   // must be pure ASCII
  try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { return null; }
}
// Choose an ASCII, writable cache base. Prefer a folder next to the plugin
// (per user request), then C:\Users\Public, then ProgramData, then tmpdir.
function setBase(pluginPath) {
  const cands = [];
  if (pluginPath) cands.push(path.join(pluginPath, '.cache'));
  if (process.env.PUBLIC) cands.push(path.join(process.env.PUBLIC, 'eagle-iphone-sync'));
  if (process.env.ProgramData) cands.push(path.join(process.env.ProgramData, 'eagle-iphone-sync'));
  cands.push(path.join(os.tmpdir(), 'eagle-iphone-sync'));
  for (const c of cands) { const r = tryDir(c); if (r) { CACHE_BASE = r; return r; } }
  CACHE_BASE = path.join(os.tmpdir(), 'eagle-iphone-sync');   // last resort
  try { fs.mkdirSync(CACHE_BASE, { recursive: true }); } catch (_) {}
  return CACHE_BASE;
}
function cacheBase() { if (!CACHE_BASE) setBase(null); return CACHE_BASE; }

// onProgress(count) is called live as the backend prints "PROGRESS <n>" on stderr.
// opts.idleMs: if set, abort when the backend produces no output for that long
// (a wedged/locked device blocks silently — better to fail with advice than hang).
function runAction(action, opts = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, '-Action', action,
    ];
    if (opts.device) args.push('-Device', opts.device);
    if (opts.inputFile) args.push('-InputFile', opts.inputFile);
    if (opts.dest) args.push('-Dest', opts.dest);
    if (opts.outDir) args.push('-OutDir', opts.outDir);
    if (opts.size) args.push('-Size', String(opts.size));
    if (opts.max) args.push('-Max', String(opts.max));

    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) { return reject(e); }

    let out = '';
    let errTail = '';
    let errLineBuf = '';
    let settled = false;
    let idleTimer = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      fn(arg);
    };
    const armIdle = () => {
      if (!opts.idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        const err = new Error('IDLE_TIMEOUT');
        err.code = 'IDLE_TIMEOUT';
        finish(reject, err);
      }, opts.idleMs);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => { out += d; armIdle(); });
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000);
      errLineBuf += d;
      armIdle();
      let idx;
      while ((idx = errLineBuf.indexOf('\n')) >= 0) {
        const line = errLineBuf.slice(0, idx).trim();
        errLineBuf = errLineBuf.slice(idx + 1);
        if (onProgress && line.startsWith('PROGRESS ')) {
          const n = parseInt(line.slice(9).trim(), 10);
          if (!isNaN(n)) onProgress(n);
        }
      }
    });

    child.on('error', (e) => finish(reject, e));
    child.on('close', () => {
      const text = out.trim();
      if (!text) {
        return finish(reject, new Error(errTail.trim() || 'no output from backend'));
      }
      const lastLine = text.split(/\r?\n/).filter(Boolean).pop();
      try {
        finish(resolve, JSON.parse(lastLine));
      } catch (e) {
        finish(reject, new Error('could not parse backend output: ' + lastLine));
      }
    });

    armIdle(); // start the watchdog
  });
}

function writeIdsFile(ids) {
  const p = path.join(cacheBase(), 'ids_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify(ids), 'utf8');
  return p;
}

function cleanup(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

module.exports = {
  setBase,
  cacheBase,

  listDevices: () => runAction('devices'),

  diagnose: (device) => runAction('diagnose', { device }),

  listPhotos: (device, max = 0, onProgress) =>
    runAction('list', { device, max, idleMs: 45000 }, onProgress),

  // Lazy size/date for a batch of ids. Returns { ok, results:[{id, size, date}] }
  meta: (device, ids) => {
    const inputFile = writeIdsFile(ids);
    return runAction('meta', { device, inputFile })
      .finally(() => cleanup(inputFile));
  },

  // items: [{id, oid}]. Returns { ok, results:[{id, thumb}] }
  thumbs: (device, items, outDir, size = 256) => {
    const inputFile = writeIdsFile(items);
    return runAction('thumb', { device, inputFile, outDir, size, idleMs: 25000 })
      .finally(() => cleanup(inputFile));
  },

  // Big preview for the viewer. item: {id, oid, name}. Returns { ok, path, kind }.
  preview: (device, item, outDir) => {
    const inputFile = writeIdsFile([item]);
    return runAction('preview', { device, inputFile, outDir, idleMs: 60000 })
      .finally(() => cleanup(inputFile));
  },

  // Copy originals to a destination folder. items: [{id, oid, name}].
  // Returns { ok, results:[{id,name,path,ok,error}] }
  copy: (device, items, dest, onProgress) => {
    const inputFile = writeIdsFile(items);
    return runAction('copy', { device, inputFile, dest }, onProgress)
      .finally(() => cleanup(inputFile));
  },

  // Delete from the device. items: [{id, oid}]. Returns { ok, results:[{id,ok,error}] }
  remove: (device, items) => {
    const inputFile = writeIdsFile(items);
    return runAction('delete', { device, inputFile, idleMs: 40000 })
      .finally(() => cleanup(inputFile));
  },
};
