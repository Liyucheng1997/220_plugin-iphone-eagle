/*
 * backend.js — Node client for bridge/PhoneBridge (the long-lived phone backend).
 *
 * One helper process per plugin window, started once and kept alive. Requests
 * are JSON lines on its stdin; replies and progress events come back as JSON
 * lines on stdout, routed here by request id. The helper owns the device and
 * schedules work by priority, so callers simply fire requests and may cancel
 * them — nothing on this side needs to serialize device access any more.
 *
 * Launch order: the prebuilt PhoneBridge.exe, then (if an antivirus or policy
 * blocks unknown executables) PowerShell compiling the same C# source with
 * Add-Type. -EncodedCommand is used for the fallback because it is exempt from
 * the script execution policy and carries non-ASCII paths intact.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const BRIDGE_DIR = path.join(__dirname, '..', 'bridge');
const EXE = path.join(BRIDGE_DIR, 'PhoneBridge.exe');
const SRC = path.join(BRIDGE_DIR, 'PhoneBridge.cs');

// ---------------------------------------------------------------------------
// Cache location. Thumbnails, previews and import staging live here. Prefer a
// folder next to the plugin; fall back to all-users locations, then tmpdir.
// (Paths reach the helper as JSON, so non-ASCII folders are fine now.)
// ---------------------------------------------------------------------------
let CACHE_BASE = null;
function tryDir(d) {
  if (!d) return null;
  try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { return null; }
}
function setBase(pluginPath) {
  const cands = [];
  if (pluginPath) cands.push(path.join(pluginPath, '.cache'));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'EaglePhoneSync'));
  if (process.env.PUBLIC) cands.push(path.join(process.env.PUBLIC, 'eagle-iphone-sync'));
  cands.push(path.join(os.tmpdir(), 'eagle-phone-sync'));
  for (const c of cands) { const r = tryDir(c); if (r) { CACHE_BASE = r; return r; } }
  CACHE_BASE = path.join(os.tmpdir(), 'eagle-phone-sync');
  return CACHE_BASE;
}
function cacheBase() { if (!CACHE_BASE) setBase(null); return CACHE_BASE; }

// ---------------------------------------------------------------------------
// Log file (rotated at 2 MB). Everything the helper prints on stderr lands here,
// so a problem on someone else's computer can be diagnosed from one file.
// ---------------------------------------------------------------------------
let logPath = null;
function logFile() {
  if (logPath) return logPath;
  const dir = path.join(cacheBase(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  logPath = path.join(dir, 'bridge.log');
  try {
    const st = fs.statSync(logPath);
    if (st.size > 2 * 1024 * 1024) { try { fs.renameSync(logPath, logPath + '.1'); } catch (_) {} }
  } catch (_) {}
  return logPath;
}
function log(line) {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  try { fs.appendFileSync(logFile(), `${ts} ${line}\n`); } catch (_) {}
}
function readLogTail(maxBytes = 24000) {
  try {
    const p = logFile(); const st = fs.statSync(p);
    const fd = fs.openSync(p, 'r'); const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

// An error carrying the helper's stable code (NO_DEVICE, ACCESS_DENIED, ...).
class BridgeError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ---------------------------------------------------------------------------
// Bridge process
// ---------------------------------------------------------------------------
class Bridge extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.mode = null;          // 'exe' | 'ps'
    this.info = null;          // the helper's "ready" message
    this.ready = null;         // Promise<void> while starting/running
    this.nextId = 1;
    this.pending = new Map();  // id -> {resolve, reject, onEvent, op}
    this.restarts = [];
    this.disposed = false;
    this.exeBlocked = false;   // the exe could not run at all → use PowerShell from now on
    this.lastStartError = '';
  }

  start() {
    if (this.disposed) return Promise.reject(new BridgeError('CANCELLED', 'plugin closing'));
    if (this.ready) return this.ready;
    this.ready = this._startAny().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async _startAny() {
    const attempts = [];
    if (!this.exeBlocked && fs.existsSync(EXE)) attempts.push('exe');
    attempts.push('ps');
    let lastErr = null;
    for (const mode of attempts) {
      try { await this._spawn(mode); return; }
      catch (e) {
        lastErr = e;
        log(`start (${mode}) failed: ${e.message}`);
        // Only a hard failure (blocked, crashed) sticks. A slow first start —
        // typically an antivirus scanning the new exe — falls back to
        // PowerShell this once and tries the exe again next time.
        if (mode === 'exe' && e.hard) this.exeBlocked = true;
      }
    }
    this.lastStartError = lastErr ? lastErr.message : 'unknown';
    throw new BridgeError('BRIDGE_START_FAILED', this.lastStartError);
  }

  _spawn(mode) {
    return new Promise((resolve, reject) => {
      let child;
      const args = ['--parent', String(process.pid)];
      const fail = (msg, hard) => { const e = new Error(msg); e.hard = hard; return e; };
      try {
        if (mode === 'exe') {
          child = spawn(EXE, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } else {
          const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
          const script = [
            "$ErrorActionPreference = 'Stop'",
            `$src = [IO.File]::ReadAllText(${lit(SRC)})`,
            'Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing, System.Web.Extensions, System.Management',
            `[PhoneBridge.Host]::Run(@(${args.map(lit).join(',')}, '--ps'))`,
          ].join('; ');
          const enc = Buffer.from(script, 'utf16le').toString('base64');
          child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        }
      } catch (e) { e.hard = true; return reject(e); }

      let settled = false, errTail = '';
      const startTimer = setTimeout(() => {
        if (settled) return; settled = true;
        try { child.kill(); } catch (_) {}
        reject(fail(`no ready signal from ${mode} helper` + (errTail ? ': ' + errTail.slice(-400) : ''), false));
      }, mode === 'exe' ? 20000 : 45000);

      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch (_) { log('bad line: ' + line.slice(0, 300)); continue; }
          if (msg.type === 'ready' && !settled) {
            settled = true; clearTimeout(startTimer);
            if (this.disposed) { try { child.stdin.end(); } catch (_) {} reject(fail('plugin closing', false)); return; }
            this.child = child; this.mode = mode; this.info = msg;
            log(`bridge ready: ${mode} v${msg.version} pid ${msg.pid} clr ${msg.clr} ${msg.x64 ? 'x64' : 'x86'} · ${msg.os || ''}`);
            resolve();
            continue;
          }
          if (this.child !== child) continue;   // a helper we already replaced
          this._onMessage(msg);
        }
      });
      let errBuf = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        errTail = (errTail + d).slice(-2000);
        errBuf += d;
        let i;
        while ((i = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, i).replace(/\r$/, ''); errBuf = errBuf.slice(i + 1);
          if (line && !line.startsWith('#< CLIXML') && !line.startsWith('<Objs')) log('[helper] ' + line);
        }
      });
      child.stdin.on('error', () => {});   // EPIPE after the helper died — handled by 'close'
      child.on('error', (e) => {
        if (!settled) { settled = true; clearTimeout(startTimer); e.hard = true; reject(e); }
      });
      // 'close', not 'exit': it fires only after stdout is drained, so a final
      // "done" line is never lost.
      child.on('close', (code, sig) => {
        if (!settled) { settled = true; clearTimeout(startTimer); reject(fail(`helper exited (${code}) before ready` + (errTail ? ': ' + errTail.slice(-400) : ''), true)); return; }
        if (this.child !== child) return;
        log(`bridge exited code=${code} sig=${sig}`);
        this.child = null; this.ready = null; this.info = null;
        this._rejectAll(new BridgeError('BRIDGE_EXIT', '后台进程已退出'));
        if (!this.disposed) this.emit('exit', code);
      });
    });
  }

  // Every request that will never get its "done" is settled here, and says
  // so ('settled'), so nothing in the UI waits on it forever.
  _rejectAll(err) {
    const all = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [id, p] of all) { this.emit('settled', id); p.reject(err); }
  }

  _onMessage(msg) {
    if (msg.type === 'stall' || msg.type === 'unstall') { this.emit(msg.type, msg); return; }
    if (msg.type === 'fatal') {
      log('bridge fatal: ' + msg.code + ' — restarting helper');
      this.emit('fatal', msg);
      this.restart('fatal ' + msg.code);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'done') {
      this.pending.delete(msg.id);
      this.emit('settled', msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new BridgeError(msg.code || 'ERROR', msg.error || msg.code));
      return;
    }
    if (p.onEvent) { try { p.onEvent(msg); } catch (e) { log('event handler threw: ' + e.message); } }
  }

  // Fire a request. Returns { id, promise, cancel }. The promise resolves with
  // the helper's "done" message and rejects with a BridgeError.
  request(op, args = {}, onEvent) {
    const id = this.nextId++;
    let cancelled = false;
    const promise = (async () => {
      await this.start();
      if (cancelled) throw new BridgeError('CANCELLED', 'cancelled');
      // The helper may have been restarted or closed between start() resolving
      // and this continuation running; a request written nowhere would hang.
      if (this.disposed) throw new BridgeError('CANCELLED', 'plugin closing');
      if (!this.child) throw new BridgeError('BRIDGE_RESTART', '后台进程已重启');
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onEvent, op });
        if (!this._write({ ...args, id, op })) {
          this.pending.delete(id);
          reject(new BridgeError('BRIDGE_EXIT', '无法连接后台进程'));
        }
      });
    })();
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (this.pending.has(id)) this._write({ id: 0, op: 'cancel', target: id });
    };
    promise.catch(() => {});   // callers that only fire-and-forget must not trigger unhandled rejections
    return { id, promise, cancel };
  }

  call(op, args, onEvent) { return this.request(op, args, onEvent).promise; }

  _write(obj) {
    if (!this.child) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch (e) { log('write failed: ' + e.message); return false; }
  }

  // Last resort for a helper whose worker is wedged inside a driver call. The
  // old helper is asked to quit (it closes its session on stdin EOF) and only
  // killed if it hasn't gone after its own shutdown window.
  restart(why) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60000);
    this.restarts.push(now);
    log('restart: ' + why + (this.restarts.length > 3 ? ' (repeated — the phone is probably wedged; replug it)' : ''));
    const c = this.child;
    this.child = null; this.ready = null; this.info = null;
    this._rejectAll(new BridgeError('BRIDGE_RESTART', '后台进程已重启'));
    if (c) { try { c.stdin.end(); } catch (_) {} setTimeout(() => { try { c.kill(); } catch (_) {} }, 6000); }
  }

  // Graceful stop: the helper closes the MTP session itself on stdin EOF.
  dispose() {
    this.disposed = true;
    const c = this.child;
    this.child = null; this.ready = null;
    this._rejectAll(new BridgeError('CANCELLED', 'plugin closing'));
    if (!c) return;
    try { c.stdin.write(JSON.stringify({ id: 0, op: 'quit' }) + '\n'); c.stdin.end(); } catch (_) {}
    setTimeout(() => { try { c.kill(); } catch (_) {} }, 6000);
  }
}

const bridge = new Bridge();

module.exports = {
  setBase,
  cacheBase,
  log,
  readLogTail,
  logFile,
  BridgeError,
  bridge,
  start: () => bridge.start(),
  dispose: () => bridge.dispose(),
  info: () => ({ mode: bridge.mode, ...(bridge.info || {}), startError: bridge.lastStartError }),

  // Cheap: no MTP session. { devices:[{id,name,mfr,desc,kind}], usb? }
  devices: (usb = true) => bridge.call('devices', { usb }),

  // Streams { type:'storages' }, { type:'items', items, count }, { type:'progress', count }.
  list: (device, onEvent) => bridge.request('list', { device }, onEvent),

  // items: [{id, oid, ext, out}] → per-item { type:'item', itemId, thumb }.
  thumbs: (device, items, size, onEvent) => bridge.request('thumbs', { device, items, size }, onEvent),

  // → { path, kind, date }. prio 'high' for what the user is looking at.
  preview: (device, item, outBase, prio = 'high', onEvent) =>
    bridge.request('preview', { device, item, outBase, prio, size: 2048 }, onEvent),

  // → per-item { type:'item', itemId, ok, path, code, error, date }, { type:'progress', index, bytes, size }.
  copy: (device, items, dest, { prio = 'low', keepTimes = true } = {}, onEvent) =>
    bridge.request('copy', { device, items, dest, prio, keepTimes }, onEvent),

  // → per-item { type:'item', itemId, ok, code, hr }, final { results, deleted }.
  remove: (device, items, onEvent) => bridge.request('delete', { device, items }, onEvent),

  storage: (device) => bridge.call('storage', { device }),
  diag: (device) => bridge.call('diag', { device: device || '' }),
  release: () => bridge.call('release', {}),
};
