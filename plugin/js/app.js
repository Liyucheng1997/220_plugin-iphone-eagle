/* app.js — Phone Photo Sync (Eagle plugin): device detection, virtualized grid,
 * background import/export/delete, viewer.
 *
 * All device access goes through backend.js → the long-lived PhoneBridge helper,
 * which owns the phone's single MTP session and schedules requests by priority
 * (viewer > visible thumbnails > background import). This file never needs to
 * serialize device calls itself; it fires requests and cancels the stale ones.
 */

let backend = null, nodePath = null, nodeFs = null, nodeOs = null, nodeUrl = null, nodeCrypto = null;
let PLUGIN_VERSION = '';

const SYNC_TAG = '手机照片';                       // Eagle tag on every imported item
const annotationFor = (deviceName, id) => `来自手机「${deviceName}」：${id}`;   // also the duplicate key — keep stable

const $ = (id) => document.getElementById(id);
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const fmtN = (n) => Number(n || 0).toLocaleString('zh-CN');

// ---------------------------------------------------------------------------
// Icons (inline SVG, stroke style)
// ---------------------------------------------------------------------------
const ICONS = {
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4v5h-5"/>',
  more: '<circle cx="5.5" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="18.5" cy="12" r=".9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  zoom: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  alert: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4.2M12 17.2v.3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M21 16l-5-5-9 9"/>',
  import: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  folder: '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  clean: '<path d="M3 21h18M6 17.5l8.5-12 4.5 3.2-8.5 12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
const ico = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  devices: [],
  device: null,                 // {id, name, mfr, kind}
  phase: 'starting',            // starting | noDevice | appleNoDriver | needAccess | loading | ready | empty | error | bridgeFailed
  phaseInfo: {},
  usb: null,

  items: [], byId: new Map(),
  view: [], indexOf: new Map(),
  listReq: null, listing: false, listCount: 0, listGen: 0,
  storages: [],

  selected: new Set(), anchorId: null, focusId: null,
  filter: 'all', sort: 'date-desc',

  imported: new Set(), importedDirty: false,

  thumbInflight: null,          // {req, pending:Set<id>}
  previewCache: new Map(),      // id -> path (this session; files persist on disk)

  task: null,
  viewerIndex: -1,
  folders: [], targetFolder: '',
  visible: true,
  lastError: null,
};

// layout
const PAD = 16, GAP = 6, HEAD = 42, SECT_GAP = 10, TOP = 6;
let targetTile = 160, tileSize = 160, cell = 166, cols = 1;
let posX = new Int32Array(0), posY = new Int32Array(0), headers = [], totalH = 0;
const rendered = new Map();     // item id -> tile element
const renderedHeads = new Map(); // header index -> element

let dirs = { thumbs: '', preview: '', drag: '' };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot(pluginPath, manifest) {
  nodePath = require('path'); nodeFs = require('fs'); nodeOs = require('os'); nodeUrl = require('url'); nodeCrypto = require('crypto');
  PLUGIN_VERSION = (manifest && manifest.version) || '';
  const base = pluginPath || nodePath.dirname(decodeURIComponent(document.location.pathname.replace(/^\//, '')));
  backend = require(nodePath.join(base, 'js', 'backend.js'));
  const cb = backend.setBase(base);
  dirs.thumbs = nodePath.join(cb, 'thumbs');
  dirs.preview = nodePath.join(cb, 'preview');
  dirs.drag = nodePath.join(cb, 'drag');
  backend.log(`---- plugin ${PLUGIN_VERSION} start · Eagle ${eagleApp('version')} build ${eagleApp('build')} · Windows ${nodeOs.release()} ${process.arch}`);
  cleanupStartup();
  restorePrefs();
  applyTheme();
  wireEvents();
  layoutGrid();
  renderDevice();
  renderEmpty();

  backend.bridge.on('stall', onStall);
  backend.bridge.on('unstall', onUnstall);
  backend.bridge.on('settled', (id) => { if (stallIds.has(id)) onUnstall({ id }); });
  backend.bridge.on('exit', () => { hideStall(); });
  backend.bridge.on('fatal', () => {
    toast('手机连接卡死，已自动重置后台组件', 'error');
    if (state.device) setTimeout(() => reloadDevice(), 1500);
  });

  backend.start()
    .then(() => { backend.log('bridge mode: ' + backend.info().mode); pollDevices(); })
    .catch((e) => { setPhase('bridgeFailed', { error: e.message }); });
  setInterval(pollDevices, 2000);
  loadFolders();
}

function eagleApp(k) { try { return eagle.app[k]; } catch (_) { return ''; } }

if (typeof eagle !== 'undefined') {
  eagle.onPluginCreate((plugin) => boot(plugin.path, plugin.manifest));
  if (eagle.onPluginBeforeExit) eagle.onPluginBeforeExit(() => shutdown());
  if (eagle.onPluginShow) eagle.onPluginShow(() => { state.visible = true; pollDevices(); });
  if (eagle.onPluginHide) eagle.onPluginHide(() => {
    state.visible = false;
    closeViewer(); hoverHide();
    // Hand the phone back to the system while hidden (Explorer, Photos app…).
    if (backend && !state.task) backend.release().catch(() => {});
  });
  if (eagle.onThemeChanged) eagle.onThemeChanged(() => applyTheme());
  if (eagle.onLibraryChanged) eagle.onLibraryChanged(() => { loadFolders(); refreshImported(); });
} else {
  window.addEventListener('load', () => { document.body.innerHTML = '<p style="padding:40px;font:14px sans-serif">请在 Eagle 中以插件方式运行。</p>'; });
}
window.addEventListener('beforeunload', () => shutdown());

let shutDown = false;
function shutdown() {
  if (shutDown || !backend) return;
  shutDown = true;
  flushImported();
  backend.dispose();
}

function applyTheme() {
  let dark = true;
  try {
    const t = String(eagle.app.theme || '').toUpperCase();
    if (t === 'LIGHT') dark = false;
    else if (t === 'AUTO' || t === '') dark = eagle.app.isDarkColors ? !!eagle.app.isDarkColors() : true;
  } catch (_) {}
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function pref(k, v) {
  try {
    if (v === undefined) return localStorage.getItem('pps.' + k);
    localStorage.setItem('pps.' + k, String(v));
  } catch (_) {}
  return null;
}
function restorePrefs() {
  const t = parseInt(pref('tile'), 10); if (t >= 90 && t <= 280) targetTile = t;
  $('zoomRange').value = targetTile;
  const s = pref('sort'); if (s && $('sortBy').querySelector(`option[value="${s}"]`)) { state.sort = s; $('sortBy').value = s; }
  state.targetFolder = pref('folder') || '';
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  $('refreshBtn').innerHTML = ico('refresh');
  $('moreBtn').innerHTML = ico('more');
  $('refreshBtn').onclick = () => reloadDevice(true);
  $('moreBtn').onclick = (e) => showMoreMenu(e.currentTarget);
  $('deviceSelect').onchange = (e) => {
    const d = state.devices.find((x) => x.id === e.target.value);
    if (d) selectDevice(d);
  };
  $('filterSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      state.filter = b.dataset.kind;
      $('filterSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      applyView(true);
    };
  });
  $('sortBy').onchange = (e) => { state.sort = e.target.value; pref('sort', state.sort); applyView(true); };
  $('selectAll').onchange = (e) => { if (e.target.checked) selectAll(); else clearSelection(); };
  $('clearSelBtn').onclick = clearSelection;
  $('importBtn').onclick = onImportClick;
  $('exportBtn').onclick = () => doExport(selectedItems());
  $('deleteBtn').onclick = () => doDelete(selectedItems());
  $('folderSelect').onchange = (e) => { state.targetFolder = e.target.value; pref('folder', state.targetFolder); };
  $('folderSelect').addEventListener('mousedown', () => loadFolders());

  $('zoomRange').oninput = (e) => setTileSize(+e.target.value);
  $('zoomOut').onclick = () => setTileSize(targetTile - 20);
  $('zoomIn').onclick = () => setTileSize(targetTile + 20);

  const grid = $('grid');
  let scrollRaf = false, settleTimer = null;
  grid.addEventListener('scroll', () => {
    if (!scrollRaf) { scrollRaf = true; requestAnimationFrame(() => { scrollRaf = false; updateVisible(); }); }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(cancelOffscreenThumbs, 180);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => layoutGrid(), 80); });
  grid.addEventListener('mousedown', onGridMouseDown);
  grid.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { e.preventDefault(); setTileSize(targetTile + (e.deltaY < 0 ? 20 : -20)); }
  }, { passive: false });

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('mouseup', () => { mouseIsDown = false; });
  window.addEventListener('blur', () => { mouseIsDown = false; });

  $('viewerClose').onclick = closeViewer;
  $('viewerPrev').onclick = () => viewerNav(-1);
  $('viewerNext').onclick = () => viewerNav(1);
  $('viewerAdd').onclick = viewerAdd;
  $('viewerDelete').onclick = viewerDelete;
  wireViewerZoom();
}

function setTileSize(px) {
  targetTile = Math.max(90, Math.min(280, Math.round(px)));
  $('zoomRange').value = targetTile;
  pref('tile', targetTile);
  layoutGrid(true);
}

// ---------------------------------------------------------------------------
// Devices: polled every 2 s (no MTP session involved, so it never disturbs a
// running transfer). Plugging a phone in is all the user has to do.
// ---------------------------------------------------------------------------
let polling = false, accessRetryTimer = null;
async function pollDevices() {
  if (polling || !state.visible || !backend || state.phase === 'bridgeFailed') return;
  polling = true;
  try {
    // Never let one stuck enumeration stop plug/unplug detection for good.
    const res = await Promise.race([
      backend.devices(!state.device),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('devices timeout'), { code: 'TIMEOUT' })), 15000)),
    ]);
    onDevices(res.devices || [], res.usb || null);
  } catch (e) {
    if (e.code === 'BRIDGE_START_FAILED') setPhase('bridgeFailed', { error: e.message });
  } finally { polling = false; }
}

function onDevices(list, usb) {
  const rank = (d) => (d.kind === 'ios' || d.kind === 'android' ? 0 : 1);
  list = list.slice().sort((a, b) => rank(a) - rank(b));
  const before = new Set(state.devices.map((d) => d.id));
  state.devices = list;
  state.usb = usb;

  const cur = state.device;
  if (cur && !list.some((d) => d.id === cur.id)) {
    const name = cur.name;
    dropDevice();
    toast(`「${name}」已断开连接`);
  }
  if (!state.device) {
    const pick = list.find((d) => d.kind !== 'other');
    if (pick) { selectDevice(pick); }
    else if (usb && usb.apple > 0) setPhase('appleNoDriver', { problem: usb.appleProblem, names: usb.appleNames });
    else setPhase('noDevice', { others: list.length });
  } else {
    const fresh = list.filter((d) => !before.has(d.id) && d.kind !== 'other' && d.id !== state.device.id);
    if (fresh.length && before.size) toast(`检测到新设备「${fresh[0].name}」，点左上角设备名可切换`);
  }
  renderDevice();
}

function selectDevice(d) {
  if (state.device && state.device.id === d.id && (state.listing || state.items.length)) return;
  if (state.device && state.device.id !== d.id) dropDevice();
  state.device = { id: d.id, name: d.name, mfr: d.mfr, kind: d.kind };
  state.imported = loadImportedRecord(d.name);
  renderDevice();
  loadList();
}

// Forget the current device and everything read from it (object ids are only
// valid for that connection).
function dropDevice() {
  if (state.listReq) state.listReq.cancel();
  if (state.thumbInflight) state.thumbInflight.req.cancel();
  state.listReq = null; state.thumbInflight = null; state.listing = false;
  clearTimeout(accessRetryTimer);
  flushImported();
  closeViewer(); hoverHide();
  state.device = null; state.storages = [];
  state.items = []; state.byId.clear(); state.selected.clear();
  state.previewCache.clear();
  applyView(true);
  hideStall();
}

function reloadDevice(manual) {
  if (!state.device) { pollDevices(); if (manual) toast('正在查找手机…'); return; }
  if (state.listing && !manual) return;
  loadList();
}

// ---------------------------------------------------------------------------
// Listing (streams in; the grid fills while the phone is still being scanned)
// ---------------------------------------------------------------------------
function loadList(isRetry) {
  const dev = state.device; if (!dev) return;
  if (!isRetry) state.listRetried = false;
  if (state.listReq) state.listReq.cancel();
  if (state.thumbInflight) { state.thumbInflight.req.cancel(); state.thumbInflight = null; }
  clearTimeout(accessRetryTimer);
  const gen = ++state.listGen;
  const keepScroll = state.items.length > 0;
  state.items = []; state.byId.clear(); state.listCount = 0; state.listing = true;
  const prevSel = new Set(state.selected);
  state.selected.clear();
  if (!keepScroll) $('grid').scrollTop = 0;
  setPhase('loading');
  applyView(true);

  let relayoutTimer = null;
  const scheduleRelayout = () => {
    if (relayoutTimer) return;
    relayoutTimer = setTimeout(() => { relayoutTimer = null; if (gen === state.listGen) applyView(false); }, state.items.length < 600 ? 120 : 500);
  };
  const req = backend.list(dev.id, (ev) => {
    if (gen !== state.listGen) return;
    if (ev.type === 'storages') { state.storages = ev.storages || []; renderDevice(); }
    else if (ev.type === 'items') {
      for (const it of ev.items) { prepItem(it); state.items.push(it); state.byId.set(it.id, it); if (prevSel.has(it.id)) state.selected.add(it.id); }
      state.listCount = ev.count;
      if (state.phase === 'loading' && state.items.length) setPhase('ready');
      renderDevice(); scheduleRelayout();
    } else if (ev.type === 'progress') { state.listCount = ev.count; renderDevice(); renderEmpty(); }
  });
  state.listReq = req;
  req.promise.then((r) => {
    if (gen !== state.listGen) return;
    state.listing = false; state.listReq = null;
    if (r.storages && r.storages.length) state.storages = r.storages;
    clearTimeout(relayoutTimer);
    backend.log(`list done: ${r.count} items, ${r.folders} folders, ${r.ms} ms, bulk ${r.bulk}`);
    setPhase(state.items.length ? 'ready' : 'empty');
    applyView(false);
    renderDevice();
    refreshImported();
  }).catch((e) => {
    if (gen !== state.listGen) return;
    state.listing = false; state.listReq = null;
    clearTimeout(relayoutTimer);
    if (e.code === 'CANCELLED') return;
    backend.log(`list failed: ${e.code} ${e.message}`);
    if (e.code === 'DEVICE_RESET' && !state.listRetried) {
      // The phone reset its connection mid-read; one quiet retry fixes it.
      state.listRetried = true;
      setTimeout(() => { if (state.device && gen === state.listGen) loadList(true); }, 1500);
      return;
    }
    if (e.code === 'NO_STORAGE' || e.code === 'ACCESS_DENIED') {
      // Waiting for "Trust" / "File transfer" on the phone: retry quietly.
      setPhase('needAccess', { code: e.code });
      accessRetryTimer = setTimeout(() => { if (state.device && state.phase === 'needAccess') loadList(); }, 3000);
    } else if (e.code === 'NO_DEVICE' || e.code === 'DISCONNECTED') {
      pollDevices();
      setPhase('error', explain(e));
    } else if (state.items.length) {
      // Partial list is still usable; say so instead of throwing it away.
      setPhase('ready');
      toast('读取未完成：' + explain(e).title + '（已显示 ' + fmtN(state.items.length) + ' 张）', 'error');
      applyView(false);
    } else setPhase('error', explain(e));
    renderDevice();
  });
}

// Date key for sorting/grouping. iPhones keep the month in the folder name
// (202506_a); Android cameras/screenshots/chat apps put the date in the file
// name (IMG_20250131_…, Screenshot_2025-01-31-…, mmexport1706688000000.jpg).
const RE_DATE = /(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ .T]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?/;
const RE_EPOCH = /(?:^|\D)(1[2-9]\d{11})(?!\d)/;
function prepItem(it) {
  let k = '';
  const seg = String(it.folder || '').split('/').find((s) => /^\d{6}/.test(s));
  const fm = seg && /^(\d{4})(0[1-9]|1[0-2])/.exec(seg);
  if (fm) k = fm[1] + fm[2] + '00000000';
  else {
    const m = RE_DATE.exec(it.name || '');
    if (m && +m[1] >= 1995) k = m[1] + m[2] + m[3] + (m[4] || '00') + (m[5] || '00') + (m[6] || '00');
    else {
      const e = RE_EPOCH.exec(it.name || '');
      if (e) {
        const d = new Date(+e[1]);
        if (d.getFullYear() >= 2010 && d.getFullYear() <= 2040) {
          const p = (n) => String(n).padStart(2, '0');
          k = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        }
      }
    }
  }
  it._k = k;
  if (k) { it._mk = k.slice(0, 6); it._ml = `${k.slice(0, 4)}年${+k.slice(4, 6)}月`; }
  else {
    // No date in the path (classic DCIM/100APPLE, Download, chat folders):
    // group by folder instead of lumping everything under "unknown date".
    const f = String(it.folder || '');
    it._mk = 'f:' + f;
    it._ml = f ? f.split('/').slice(-2).join(' / ') : '其他';
  }
}

// ---------------------------------------------------------------------------
// View: filter + sort + layout
// ---------------------------------------------------------------------------
function applyView(resetLayout) {
  const f = state.filter;
  let v = state.items.filter((it) =>
    f === 'all' || (f === 'new' ? !state.imported.has(it.id) : it.kind === f));
  const desc = state.sort !== 'date-asc';
  if (state.sort === 'name-asc') v.sort((a, b) => coll.compare(a.name, b.name) || coll.compare(a.id, b.id));
  else {
    v.sort((a, b) => {
      if (a._k !== b._k) {
        if (!a._k) return 1; if (!b._k) return -1;   // unknown dates always last
        return desc ? (a._k < b._k ? 1 : -1) : (a._k < b._k ? -1 : 1);
      }
      return desc ? coll.compare(b.id, a.id) : coll.compare(a.id, b.id);
    });
  }
  state.view = v;
  state.indexOf = new Map();
  v.forEach((it, i) => state.indexOf.set(it.id, i));
  // selection only covers what is visible after a filter change
  if (resetLayout) for (const id of state.selected) if (!state.indexOf.has(id)) state.selected.delete(id);
  layoutGrid(resetLayout);
  updateSelectionUI();
  renderEmpty();
}

function layoutGrid(resetDom) {
  const grid = $('grid');
  const w = grid.clientWidth || 800;
  cols = Math.max(1, Math.floor((w - PAD * 2 + GAP) / (targetTile + GAP)));
  tileSize = Math.max(60, Math.floor((w - PAD * 2 - GAP * (cols - 1)) / cols));
  cell = tileSize + GAP;
  document.documentElement.style.setProperty('--tile', tileSize + 'px');
  const v = state.view, n = v.length;
  posX = new Int32Array(n); posY = new Int32Array(n); headers = [];
  const grouped = state.sort !== 'name-asc';
  let y = TOP, i = 0;
  while (i < n) {
    let j = i;
    if (grouped) {
      const mk = v[i]._mk;
      while (j < n && v[j]._mk === mk) j++;
      headers.push({ y, label: v[i]._ml, count: j - i });
      y += HEAD;
    } else j = n;
    for (let k = i; k < j; k++) {
      const r = ((k - i) / cols) | 0, c = (k - i) % cols;
      posX[k] = PAD + c * cell; posY[k] = y + r * cell;
    }
    y += Math.ceil((j - i) / cols) * cell + SECT_GAP;
    i = j;
  }
  totalH = y + PAD;
  $('gridInner').style.height = totalH + 'px';
  if (resetDom) {
    rendered.forEach((el) => el.remove()); rendered.clear();
    renderedHeads.forEach((el) => el.remove()); renderedHeads.clear();
  }
  updateVisible();
}

function firstIndexAtY(y) {
  let lo = 0, hi = posY.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (posY[mid] + tileSize < y) lo = mid + 1; else hi = mid; }
  return lo;
}

function updateVisible() {
  const grid = $('grid'), inner = $('gridInner');
  const top = grid.scrollTop - 300, bot = grid.scrollTop + grid.clientHeight + 300;
  const frag = document.createDocumentFragment();
  // headers
  const needH = new Set();
  headers.forEach((h, hi) => { if (h.y + HEAD >= top && h.y <= bot) needH.add(hi); });
  renderedHeads.forEach((el, hi) => { if (!needH.has(hi)) { el.remove(); renderedHeads.delete(hi); } });
  needH.forEach((hi) => {
    const h = headers[hi];
    let el = renderedHeads.get(hi);
    if (!el) { el = document.createElement('div'); el.className = 'date-header'; renderedHeads.set(hi, el); frag.appendChild(el); }
    el.style.top = h.y + 'px';
    el.innerHTML = `${escapeHtml(h.label)} <span class="count tabular">${fmtN(h.count)}</span>`;
  });
  // tiles (keyed by id, so items streaming in just move existing tiles)
  const need = new Set();
  const v = state.view;
  for (let i = firstIndexAtY(top); i < v.length && posY[i] <= bot; i++) need.add(v[i].id);
  rendered.forEach((el, id) => { if (!need.has(id)) { el.remove(); rendered.delete(id); } });
  need.forEach((id) => {
    const i = state.indexOf.get(id);
    let el = rendered.get(id);
    if (!el) { el = makeTile(v[i]); rendered.set(id, el); frag.appendChild(el); }
    el.style.left = posX[i] + 'px'; el.style.top = posY[i] + 'px';
  });
  inner.appendChild(frag);
  scheduleThumbs();
}

function makeTile(it) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.id = it.id;
  const thumb = knownThumb(it);
  if (thumb) el.appendChild(thumbImg(thumb));
  else el.insertAdjacentHTML('beforeend', `<div class="ph${it._tf ? '' : ' loading'}"><div class="ext">${escapeHtml(it.ext || '')}</div><div class="fname">${escapeHtml(it.name)}</div></div>`);
  el.insertAdjacentHTML('beforeend',
    `<div class="check" title="选择">${ico('check')}</div>` +
    (it.kind === 'video' ? `<div class="badge video">${ico('play')}视频</div>` : '') +
    `<div class="zoom" title="悬停预览，点击查看大图">${ico('zoom')}</div>`);
  paintTileState(el, it);
  const id = it.id;
  el.querySelector('.check').addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(id); });
  el.querySelector('.check').addEventListener('mousedown', (e) => e.stopPropagation());
  const zoom = el.querySelector('.zoom');
  zoom.addEventListener('mouseenter', () => hoverShow(id));
  zoom.addEventListener('mouseleave', hoverHide);
  zoom.addEventListener('mousedown', (e) => e.stopPropagation());
  zoom.addEventListener('click', (e) => { e.stopPropagation(); hoverHide(); openViewer(state.indexOf.get(id)); });
  el.addEventListener('click', (e) => onTileClick(id, e));
  el.addEventListener('dblclick', () => openViewer(state.indexOf.get(id)));
  el.addEventListener('contextmenu', (e) => onTileContext(id, e));
  el.draggable = true;
  el.addEventListener('mousedown', (e) => onTileMouseDown(id, e));
  el.addEventListener('dragstart', (e) => onTileDragStart(id, e));
  return el;
}

function paintTileState(el, it) {
  el.classList.toggle('selected', state.selected.has(it.id));
  el.classList.toggle('focused', state.focusId === it.id);
  const done = state.imported.has(it.id);
  let b = el.querySelector('.badge.done');
  if (done && !b) el.insertAdjacentHTML('beforeend', `<div class="badge done" title="已导入 Eagle">${ico('ok')}已导入</div>`);
  else if (!done && b) b.remove();
}
function repaintTiles() { rendered.forEach((el, id) => { const it = state.byId.get(id); if (it) paintTileState(el, it); }); }

function thumbImg(p) {
  const img = document.createElement('img');
  img.draggable = false; img.decoding = 'async';
  img.src = fileHref(p);
  return img;
}
function fileHref(p) { return nodeUrl.pathToFileURL(p).href; }

// ---------------------------------------------------------------------------
// Thumbnails — persistent disk cache per device; only what is on screen is
// requested, one small batch at a time, and a batch whose tiles have all been
// scrolled away is cancelled so the next screen is never stuck behind it.
// ---------------------------------------------------------------------------
function devKey(dev) {
  return nodeCrypto.createHash('sha1').update(String(dev.name) + '|' + String(dev.mfr || '')).digest('hex').slice(0, 12);
}
function thumbPathFor(it) {
  return nodePath.join(dirs.thumbs, devKey(state.device), nodeCrypto.createHash('sha1').update(it.id).digest('hex').slice(0, 24) + '.jpg');
}
function knownThumb(it) {
  if (it._t) return it._t;
  if (it._tc || !state.device) return null;
  it._tc = true;   // check the disk cache once per item
  const p = thumbPathFor(it);
  try { if (nodeFs.statSync(p).size > 0) { it._t = p; return p; } } catch (_) {}
  return null;
}

let thumbTimer = null;
function scheduleThumbs() { if (!thumbTimer) thumbTimer = setTimeout(pumpThumbs, 40); }
function pumpThumbs() {
  thumbTimer = null;
  if (!state.device || state.thumbInflight || !state.view.length) return;
  const grid = $('grid');
  const vTop = grid.scrollTop, vBot = vTop + grid.clientHeight;
  const cand = [];
  rendered.forEach((el, id) => {
    const it = state.byId.get(id);
    if (!it || it._t || it._tf || !it.oid) return;
    if (knownThumb(it)) { applyThumb(it); return; }
    const i = state.indexOf.get(id);
    const y = posY[i];
    const onScreen = y + tileSize >= vTop && y <= vBot;
    cand.push({ it, i, rank: onScreen ? 0 : 1 });
  });
  if (!cand.length) return;
  cand.sort((a, b) => a.rank - b.rank || a.i - b.i);
  const batch = cand.slice(0, 12).map((c) => c.it);
  const dev = state.device;
  const pending = new Set(batch.map((it) => it.id));
  const req = backend.thumbs(dev.id, batch.map((it) => ({ id: it.id, oid: it.oid, ext: it.ext, out: thumbPathFor(it) })), 320, (ev) => {
    if (ev.type !== 'item') return;
    pending.delete(ev.itemId);
    const it = state.byId.get(ev.itemId); if (!it || state.device !== dev) return;
    if (ev.thumb) { it._t = ev.thumb; applyThumb(it); } else { it._tf = true; markThumbFailed(it); }
  });
  state.thumbInflight = { req, pending };
  req.promise.catch((e) => {
    // A device-level failure is not the photo's fault — let it retry later.
    if (['CANCELLED', 'TIMEOUT', 'DISCONNECTED', 'DEVICE_RESET', 'DEVICE_BUSY', 'ACCESS_DENIED', 'BRIDGE_EXIT', 'BRIDGE_RESTART'].includes(e.code)) return;
    for (const id of pending) { const it = state.byId.get(id); if (it) { it._tf = true; markThumbFailed(it); } }
  }).then(() => {
    if (state.thumbInflight && state.thumbInflight.req === req) state.thumbInflight = null;
    if (state.device === dev) scheduleThumbs();
  });
}
function cancelOffscreenThumbs() {
  const f = state.thumbInflight; if (!f) return;
  for (const id of f.pending) if (rendered.has(id)) return;   // still useful
  f.req.cancel();
}
function applyThumb(it) {
  const el = rendered.get(it.id); if (!el) return;
  const ph = el.querySelector('.ph'); if (!ph) return;
  const img = thumbImg(it._t);
  img.onload = () => { if (ph.parentNode) ph.replaceWith(img); };
  img.onerror = () => { it._t = null; it._tf = true; markThumbFailed(it); };
}
function markThumbFailed(it) {
  const el = rendered.get(it.id); if (!el) return;
  const ph = el.querySelector('.ph'); if (ph) ph.classList.remove('loading');
}

// ---------------------------------------------------------------------------
// Selection — click selects, Ctrl toggles, Shift extends, drag on empty space
// draws a selection box, the check circle toggles without clearing.
// ---------------------------------------------------------------------------
// Anchor/focus are kept as ids: indices shift whenever items stream in or the
// view is re-sorted.
const idxOf = (id) => (id != null && state.indexOf.has(id) ? state.indexOf.get(id) : -1);
function selectRange(fromIdx, toIdx, additive) {
  const [a, b] = [fromIdx, toIdx].sort((x, y) => x - y);
  if (!additive) state.selected.clear();
  for (let k = a; k <= b; k++) state.selected.add(state.view[k].id);
}
function onTileClick(id, e) {
  const i = idxOf(id); if (i < 0) return;
  const anchor = idxOf(state.anchorId);
  if (e.shiftKey && anchor >= 0) selectRange(anchor, i, e.ctrlKey || e.metaKey);
  else if (e.ctrlKey || e.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    state.anchorId = id;
  } else {
    state.selected.clear(); state.selected.add(id); state.anchorId = id;
  }
  state.focusId = id;
  repaintTiles(); updateSelectionUI();
}
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  state.anchorId = id; state.focusId = id;
  repaintTiles(); updateSelectionUI();
}
function selectAll() { state.view.forEach((it) => state.selected.add(it.id)); repaintTiles(); updateSelectionUI(); }
function clearSelection() { state.selected.clear(); repaintTiles(); updateSelectionUI(); }
function selectedItems() { return state.view.filter((it) => state.selected.has(it.id)); }
function pick(it) { return { id: it.id, oid: it.oid, name: it.name }; }

function onTileContext(id, e) {
  e.preventDefault();
  if (!state.selected.has(id)) { state.selected.clear(); state.selected.add(id); state.anchorId = id; }
  state.focusId = id;
  repaintTiles(); updateSelectionUI();
  const items = selectedItems(), n = items.length;
  const busy = !!state.task;
  showMenu(e.clientX, e.clientY, [
    { icon: 'eye', label: '查看大图', kbd: 'Enter', action: () => openViewer(state.indexOf.get(id)) },
    { sep: true },
    { icon: 'import', label: n > 1 ? `导入 ${n} 项到 Eagle` : '导入到 Eagle', disabled: busy, action: () => doImport(items) },
    { icon: 'folder', label: n > 1 ? `导出 ${n} 项到文件夹…` : '导出到文件夹…', disabled: busy, action: () => doExport(items) },
    { sep: true },
    { icon: 'trash', label: n > 1 ? `从手机删除 ${n} 项…` : '从手机删除…', kbd: 'Del', danger: true, disabled: busy, action: () => doDelete(items) },
  ]);
}

// Box selection on empty grid space.
let marq = null;
function onGridMouseDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.tile')) return;
  const grid = $('grid');
  if (e.offsetX > grid.clientWidth) return;   // the scrollbar
  e.preventDefault();
  grid.focus();
  const rect = grid.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top + grid.scrollTop;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  marq = { sx, sy, x: sx, y: sy, base: additive ? new Set(state.selected) : new Set(), moved: false, clientY: e.clientY };
  if (!additive && state.selected.size) { state.selected.clear(); repaintTiles(); updateSelectionUI(); }
  const move = (ev) => {
    marq.x = ev.clientX - rect.left; marq.y = ev.clientY - rect.top + grid.scrollTop; marq.clientY = ev.clientY;
    if (!marq.moved && Math.hypot(marq.x - marq.sx, marq.y - marq.sy) < 4) return;
    marq.moved = true;
    updateMarquee();
  };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    cancelAnimationFrame(marqScrollRaf); marqScrollRaf = 0;
    $('marquee').hidden = true; grid.classList.remove('selecting'); marq = null;
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  marqAutoScroll();
}
let marqScrollRaf = 0;
function marqAutoScroll() {
  marqScrollRaf = requestAnimationFrame(() => {
    if (!marq) return;
    const grid = $('grid'), r = grid.getBoundingClientRect();
    let dy = 0;
    if (marq.moved) {
      if (marq.clientY < r.top + 30) dy = -Math.min(30, r.top + 30 - marq.clientY);
      else if (marq.clientY > r.bottom - 30) dy = Math.min(30, marq.clientY - (r.bottom - 30));
    }
    if (dy) { grid.scrollTop += dy; marq.y += dy; updateMarquee(); }
    marqAutoScroll();
  });
}
function updateMarquee() {
  const grid = $('grid');
  grid.classList.add('selecting');
  const x1 = Math.min(marq.sx, marq.x), x2 = Math.max(marq.sx, marq.x);
  const y1 = Math.min(marq.sy, marq.y), y2 = Math.max(marq.sy, marq.y);
  const m = $('marquee');
  m.hidden = false;
  Object.assign(m.style, { left: x1 + 'px', top: y1 + 'px', width: (x2 - x1) + 'px', height: (y2 - y1) + 'px' });
  const sel = new Set(marq.base);
  const v = state.view;
  for (let i = firstIndexAtY(y1); i < v.length && posY[i] <= y2; i++) {
    if (posX[i] + tileSize >= x1 && posX[i] <= x2 && posY[i] + tileSize >= y1) sel.add(v[i].id);
  }
  state.selected = sel;
  repaintTiles(); updateSelectionUI();
}

function onKeyDown(e) {
  if (document.querySelector('.modal-overlay')) return;    // the modal handles its own keys
  if (closeMenu()) { if (e.key === 'Escape') return; }
  if (state.viewerIndex >= 0) { viewerKey(e); return; }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAll(); return; }
  if (e.key === 'F5' || (ctrl && (e.key === 'r' || e.key === 'R'))) { e.preventDefault(); reloadDevice(true); return; }
  if (e.key === 'Escape') { clearSelection(); return; }
  if (e.key === 'Delete' && state.selected.size && !state.task) { e.preventDefault(); doDelete(selectedItems()); return; }
  if ((e.key === 'Enter' || e.key === ' ') && state.view.length) {
    e.preventDefault();
    let i = idxOf(state.focusId);
    if (i < 0) i = state.selected.size ? idxOf(selectedItems()[0].id) : 0;
    openViewer(i); return;
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && state.view.length) {
    e.preventDefault();
    const cur = idxOf(state.focusId);
    const i = Math.max(0, Math.min(state.view.length - 1, cur < 0 ? 0 : moveFocus(cur, e.key)));
    const id = state.view[i].id;
    if (e.shiftKey) {
      if (idxOf(state.anchorId) < 0) state.anchorId = cur < 0 ? id : state.view[cur].id;
      selectRange(idxOf(state.anchorId), i, false);
    } else { state.selected.clear(); state.selected.add(id); state.anchorId = id; }
    state.focusId = id;
    scrollIntoView(i); repaintTiles(); updateSelectionUI();
  }
}
// Up/down follow the visual rows, which restart at every month header.
function moveFocus(i, key) {
  if (key === 'ArrowLeft') return i - 1;
  if (key === 'ArrowRight') return i + 1;
  const x = posX[i], y = posY[i], down = key === 'ArrowDown';
  let best = i;
  if (down) {
    let k = i + 1; while (k < posY.length && posY[k] === y) k++;
    if (k >= posY.length) return i;
    const ny = posY[k]; best = k;
    while (k < posY.length && posY[k] === ny) { if (posX[k] <= x) best = k; k++; }
  } else {
    let k = i - 1; while (k >= 0 && posY[k] === y) k--;
    if (k < 0) return i;
    const ny = posY[k]; best = k;
    while (k >= 0 && posY[k] === ny) { if (posX[k] >= x) best = k; k--; }
  }
  return best;
}
function scrollIntoView(i) {
  const grid = $('grid'), y = posY[i];
  if (y < grid.scrollTop + 8) grid.scrollTop = y - HEAD;
  else if (y + tileSize > grid.scrollTop + grid.clientHeight - 8) grid.scrollTop = y + tileSize - grid.clientHeight + 16;
}

function updateSelectionUI() {
  const n = state.selected.size, total = state.view.length;
  const newCount = state.view.reduce((c, it) => c + (state.imported.has(it.id) ? 0 : 1), 0);
  const sel = $('selInfo');
  if (n) sel.innerHTML = `已选 <b>${fmtN(n)}</b> 项`;
  else if (state.items.length) sel.innerHTML = `共 ${fmtN(total)} 项` + (state.imported.size ? ` · <b>${fmtN(newCount)}</b> 项未导入` : '');
  else sel.textContent = '';
  $('selActions').hidden = n === 0;
  const all = $('selectAll');
  all.checked = total > 0 && n >= total && state.view.every((it) => state.selected.has(it.id));
  all.indeterminate = n > 0 && !all.checked;
  all.disabled = total === 0;
  const btn = $('importBtn');
  if (n) { btn.textContent = `导入所选 (${fmtN(n)})`; btn.disabled = !!state.task; }
  else {
    btn.textContent = newCount ? `导入新照片 (${fmtN(newCount)})` : (total ? '已全部导入' : '导入新照片');
    btn.disabled = !!state.task || newCount === 0 || state.listing;
  }
  $('deleteBtn').disabled = !!state.task; $('exportBtn').disabled = !!state.task;
}

// ---------------------------------------------------------------------------
// "Already imported": the local record (per device) united with what the
// current Eagle library actually contains (recovered from the annotation each
// import writes). The library is the source of truth — the record can be lost
// or belong to another computer — and the record heals itself from it.
// ---------------------------------------------------------------------------
function importedStorePath(deviceName) {
  const dir = nodePath.join(nodeOs.homedir(), '.eagle-iphone-sync');   // historical name, kept for continuity
  try { nodeFs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return nodePath.join(dir, 'imported_' + String(deviceName || 'device').replace(/[^\w.-]+/g, '_') + '.json');
}
function loadImportedRecord(name) {
  try { return new Set(JSON.parse(nodeFs.readFileSync(importedStorePath(name), 'utf8'))); } catch (_) { return new Set(); }
}
let importedSaveTimer = null;
function markImported(id) {
  state.imported.add(id); state.importedDirty = true;
  if (!importedSaveTimer) importedSaveTimer = setTimeout(flushImported, 1500);
}
function flushImported() {
  clearTimeout(importedSaveTimer); importedSaveTimer = null;
  if (!state.importedDirty || !state.device) return;
  state.importedDirty = false;
  const p = importedStorePath(state.device.name);
  try { nodeFs.writeFileSync(p + '.tmp', JSON.stringify(Array.from(state.imported))); nodeFs.renameSync(p + '.tmp', p); }
  catch (e) { backend.log('save imported record failed: ' + e.message); }
}
async function libraryImportedIds(deviceName) {
  const prefix = annotationFor(deviceName, '');
  let list;
  try { list = await eagle.item.get({ tags: [SYNC_TAG], fields: ['annotation'] }); }
  catch (_) { try { list = await eagle.item.get({ tags: [SYNC_TAG] }); } catch (e2) { backend.log('library query failed: ' + e2.message); return null; } }
  const ids = new Set();
  for (const it of (list || [])) { const a = it.annotation || ''; if (a.startsWith(prefix)) ids.add(a.slice(prefix.length)); }
  return ids;
}
async function refreshImported() {
  const dev = state.device; if (!dev) return;
  const lib = await libraryImportedIds(dev.name);
  if (state.device !== dev || !lib) return;
  let changed = false;
  for (const id of lib) if (!state.imported.has(id)) { state.imported.add(id); changed = true; }
  if (changed) { state.importedDirty = true; flushImported(); }
  repaintTiles(); updateSelectionUI();
  if (state.filter === 'new') applyView(false);
}

// ---------------------------------------------------------------------------
// Background tasks (import / export / delete). One at a time; the grid stays
// usable while it runs because the helper interleaves interactive requests.
// ---------------------------------------------------------------------------
function onImportClick() {
  if (state.selected.size) return doImport(selectedItems());
  const items = state.view.filter((it) => !state.imported.has(it.id));
  if (!items.length) return;
  if (items.length > 30) {
    confirmBox({
      icon: 'import', title: `导入 ${fmtN(items.length)} 项新照片/视频`,
      message: `将导入到 Eagle「${folderLabel()}」。已导入过的会自动跳过。`,
      detail: '可以一边浏览一边等待。期间请保持手机解锁、不要拔线。',
      ok: '开始导入',
    }).then((yes) => { if (yes) doImport(items); });
  } else doImport(items);
}

function folderLabel() {
  if (!state.targetFolder) return '未分类';
  const f = state.folders.find((x) => x.id === state.targetFolder);
  return f ? f.name : '未分类';
}

function newTask(kind, title, total) {
  const t = { kind, title, total, done: 0, failed: 0, skipped: 0, errors: [], startedAt: Date.now(), finished: false, cancel: null, samples: [], okIds: [] };
  state.task = t; shownTask = t;
  renderTask(true); updateSelectionUI();
  return t;
}
function taskStep(t, ok, item, err) {
  t.curBytes = 0; t.curSize = 0;
  if (ok) { t.done++; if (item) t.okIds.push(item.id); }
  else { t.failed++; if (err) t.errors.push({ name: item ? item.name : '', code: err.code, msg: err.error || err.message || '' }); }
  t.samples.push([Date.now(), t.done + t.failed]);
  if (t.samples.length > 40) t.samples.shift();
  renderTask();
}
function finishTask(t, error) {
  t.finished = true; t.error = error || null;
  if (state.task === t) state.task = null;
  updateSelectionUI(); renderTask(true);
  hideStall();
}

async function doImport(items) {
  if (!items.length || !state.device) return;
  if (state.task) { toast('请等待当前任务完成'); return; }
  const dev = state.device;
  const fresh = items.filter((it) => !state.imported.has(it.id));
  const skipped = items.length - fresh.length;
  if (!fresh.length) { toast(`这 ${fmtN(items.length)} 项都已导入过，已跳过`, 'success'); return; }
  const folderId = state.targetFolder;
  const fname = folderLabel();
  const tmp = nodePath.join(backend.cacheBase(), 'import_' + Date.now());
  try { nodeFs.mkdirSync(tmp, { recursive: true }); } catch (e) { toast('无法创建临时文件夹：' + e.message, 'error'); return; }
  const t = newTask('import', `正在导入到 Eagle「${fname}」`, fresh.length);
  t.skipped = skipped;
  const byId = new Map(fresh.map((it) => [it.id, it]));
  // Eagle ingests one file at a time; chaining keeps it in order and lets the
  // phone transfer the next file meanwhile.
  let chain = Promise.resolve();
  const req = backend.copy(dev.id, fresh.map(pick), tmp, { prio: 'low', keepTimes: true }, (ev) => {
    if (ev.type === 'started') { t.started = true; renderTask(); return; }
    if (ev.type === 'progress') { t.curBytes = ev.bytes; t.curSize = ev.size; renderTask(); return; }
    if (ev.type !== 'item') return;
    const it = byId.get(ev.itemId);
    if (!ev.ok) { taskStep(t, false, it, ev); return; }
    chain = chain.then(async () => {
      try {
        await eagle.item.addFromPath(ev.path, {
          name: stripExt(it ? it.name : nodePath.basename(ev.path)),
          tags: [SYNC_TAG], folders: folderId ? [folderId] : [],
          annotation: annotationFor(dev.name, ev.itemId),
        });
        markImported(ev.itemId);
        taskStep(t, true, it);
        const el = rendered.get(ev.itemId); if (el && it) paintTileState(el, it);
      } catch (e) {
        taskStep(t, false, it, { code: 'EAGLE', error: 'Eagle 入库失败：' + e.message });
      } finally { try { nodeFs.unlinkSync(ev.path); } catch (_) {} }
    });
  });
  t.cancel = () => { t.cancelled = true; req.cancel(); };
  let err = null;
  try { await req.promise; } catch (e) { err = e; }
  await chain;
  flushImported();
  rmDir(tmp);
  finishTask(t, err && err.code !== 'CANCELLED' ? err : null);
  updateSelectionUI();
  if (state.filter === 'new') applyView(false);
}

async function doExport(items) {
  if (!items.length || !state.device) return;
  if (state.task) { toast('请等待当前任务完成'); return; }
  let dest;
  try {
    const r = await eagle.dialog.showOpenDialog({ title: '选择导出位置', properties: ['openDirectory', 'createDirectory'] });
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return;
    dest = r.filePaths[0];
  } catch (e) { toast('无法打开文件夹选择：' + e.message, 'error'); return; }
  const dev = state.device;
  const t = newTask('export', `正在导出到 ${nodePath.basename(dest) || dest}`, items.length);
  t.dest = dest;
  const byId = new Map(items.map((it) => [it.id, it]));
  const req = backend.copy(dev.id, items.map(pick), dest, { prio: 'low', keepTimes: true }, (ev) => {
    if (ev.type === 'started') { t.started = true; renderTask(); return; }
    if (ev.type === 'progress') { t.curBytes = ev.bytes; t.curSize = ev.size; renderTask(); return; }
    if (ev.type === 'item') taskStep(t, ev.ok, byId.get(ev.itemId), ev);
  });
  t.cancel = () => { t.cancelled = true; req.cancel(); };
  let err = null;
  try { await req.promise; } catch (e) { err = e; }
  finishTask(t, err && err.code !== 'CANCELLED' ? err : null);
}

async function doDelete(items, { skipConfirm = false } = {}) {
  if (!items.length || !state.device) return;
  if (state.task) { toast('请等待当前任务完成'); return; }
  if (!skipConfirm) {
    const notImported = items.filter((it) => !state.imported.has(it.id)).length;
    const yes = await confirmBox({
      icon: 'trash', danger: true,
      title: items.length > 1 ? `从手机删除 ${fmtN(items.length)} 项？` : '从手机删除这张照片？',
      message: '会直接从手机删除，无法撤销。',
      detail: notImported ? `注意：其中 ${fmtN(notImported)} 项还没有导入 Eagle。` : '这些都已导入 Eagle。',
      ok: '删除',
    });
    if (!yes) return;
  }
  const dev = state.device;
  const t = newTask('delete', '正在从手机删除', items.length);
  const byId = new Map(items.map((it) => [it.id, it]));
  const req = backend.remove(dev.id, items.map(pick), (ev) => {
    if (ev.type === 'started') { t.started = true; renderTask(); return; }
    if (ev.type === 'progress') { t.phaseIndex = ev.index; renderTask(); return; }
    if (ev.type !== 'item') return;
    const it = byId.get(ev.itemId);
    if (ev.ok) { removeItem(ev.itemId); taskStep(t, true, it); }
    else taskStep(t, false, it, { code: ev.code, error: ev.hr ? `HRESULT ${ev.hr}` : '' });
  });
  t.cancel = () => { t.cancelled = true; req.cancel(); };
  let err = null;
  try { await req.promise; } catch (e) { err = e; }
  applyView(false);
  finishTask(t, err && err.code !== 'CANCELLED' ? err : null);
  if (state.device === dev) backend.storage(dev.id).then((r) => { state.storages = r.storages || state.storages; renderDevice(); }).catch(() => {});
}

function removeItem(id) {
  const it = state.byId.get(id); if (!it) return;
  state.byId.delete(id);
  const i = state.items.indexOf(it); if (i >= 0) state.items.splice(i, 1);
  state.selected.delete(id);
  const el = rendered.get(id); if (el) { el.remove(); rendered.delete(id); }
  scheduleDeleteRelayout();
}
let delRelayout = null;
function scheduleDeleteRelayout() { if (!delRelayout) delRelayout = setTimeout(() => { delRelayout = null; applyView(false); }, 250); }

// Timer-throttled (not rAF): progress must keep updating even while the
// window is in the background.
let taskTimer = 0, taskHideTimer = null;
function renderTask(now) {
  if (now) { clearTimeout(taskTimer); taskTimer = 0; drawTask(); return; }
  if (!taskTimer) taskTimer = setTimeout(() => { taskTimer = 0; drawTask(); }, 120);
}
let shownTask = null;   // the task the panel shows: running, or the last finished one until dismissed
// Shown until the helper says the task really started. The phone serves one
// request at a time, so a task can queue behind a slow cold scan.
function waitingText() {
  if (stallIds.size) return '等待手机响应…请解锁手机';
  if (state.listing) return '等待手机空闲（正在读取照片列表）…';
  return '等待手机空闲…';
}
function drawTask() {
  const t = shownTask;
  const panel = $('taskPanel');
  if (!t) { panel.hidden = true; return; }
  panel.hidden = false;
  // Deletes report per-item results only after the final verification pass,
  // so while deleting, count by the helper's progress instead.
  const processed = Math.max(t.done + t.failed, t.kind === 'delete' && t.phaseIndex != null ? t.phaseIndex + 1 : 0);
  if (!t.finished) {
    clearTimeout(taskHideTimer);
    const pct = t.total ? Math.min(100, (processed + (t.curSize ? Math.min(1, (t.curBytes || 0) / t.curSize) : 0)) / t.total * 100) : 0;
    let eta = '';
    if (t.samples.length > 3) {
      const [t0, n0] = t.samples[0], [t1, n1] = t.samples[t.samples.length - 1];
      const rate = (n1 - n0) / Math.max(1, t1 - t0);
      if (rate > 0) eta = '剩余约 ' + fmtDuration((t.total - processed) / rate);
    }
    panel.innerHTML = `
      <div class="task-head"><div class="task-icon">${ico(t.kind === 'delete' ? 'trash' : t.kind === 'export' ? 'folder' : 'import')}</div>
        <div class="task-title">${escapeHtml(t.title)}</div></div>
      <div class="task-bar${processed === 0 && !t.curBytes ? ' indet' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="task-meta tabular"><span>${!t.started ? waitingText() : fmtN(processed) + ' / ' + fmtN(t.total)}${t.failed ? ` · <span style="color:var(--danger)">${fmtN(t.failed)} 失败</span>` : ''}</span><span>${eta}</span></div>
      <div class="task-actions"><button class="btn btn-sm" id="taskCancel">${t.cancelled ? '正在取消…' : '取消'}</button></div>`;
    const c = $('taskCancel'); c.disabled = !!t.cancelled;
    c.onclick = () => { if (t.cancel) t.cancel(); renderTask(true); };
    return;
  }
  const verb = { import: '导入', export: '导出', delete: '删除' }[t.kind];
  const allBad = t.done === 0 && (t.failed > 0 || t.error);
  const head = t.cancelled ? `${verb}已取消` : allBad ? `${verb}失败` : `${verb}完成`;
  let sum = `<span class="ok">${fmtN(t.done)}</span> 项成功`;
  if (t.skipped) sum += `，${fmtN(t.skipped)} 项已导入过（跳过）`;
  if (t.failed) sum += `，<span class="bad">${fmtN(t.failed)}</span> 项失败`;
  const leftover = t.total - t.done - t.failed;
  if (leftover > 0 && (t.cancelled || t.error)) sum += `，${fmtN(leftover)} 项未处理`;
  if (t.error) sum += `<br>${escapeHtml(explain(t.error).title)}：${escapeHtml(explain(t.error).detail)}`;
  panel.innerHTML = `
    <div class="task-head"><div class="task-icon ${allBad ? 'bad' : 'ok'}">${ico(allBad ? 'alert' : 'ok')}</div>
      <div class="task-title">${head}</div><button class="task-x" id="taskClose" title="关闭">✕</button></div>
    <div class="task-summary">${sum}</div>
    <div class="task-actions" id="taskActs"></div>`;
  $('taskClose').onclick = () => { shownTask = null; panel.hidden = true; };
  const acts = $('taskActs');
  const addBtn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn btn-sm ' + cls; b.textContent = label; b.onclick = fn; acts.appendChild(b); };
  if (t.failed) addBtn('查看失败原因', '', () => showFailures(t));
  if (t.kind === 'import' && t.okIds.length && state.device) {
    addBtn(`从手机删除这 ${fmtN(t.okIds.length)} 项…`, 'btn-danger', () => {
      const its = t.okIds.map((id) => state.byId.get(id)).filter(Boolean);
      shownTask = null; panel.hidden = true;
      doDelete(its);
    });
  }
  if (t.kind === 'export' && t.done && t.dest) addBtn('打开文件夹', 'btn-primary', () => openPath(t.dest));
  if (!t.failed && !t.error) taskHideTimer = setTimeout(() => { if (shownTask === t && !state.task) { shownTask = null; panel.hidden = true; } }, t.kind === 'import' ? 15000 : 8000);
}
function showFailures(t) {
  const groups = new Map();
  for (const e of t.errors) {
    const ex = explain(e);
    const g = groups.get(ex.title) || { ex, names: [] };
    if (g.names.length < 8) g.names.push(e.name || '');
    g.count = (g.count || 0) + 1;
    groups.set(ex.title, g);
  }
  const lines = [];
  for (const [, g] of groups) {
    lines.push(`【${g.ex.title}】${g.count} 项`);
    if (g.ex.detail) lines.push(g.ex.detail);
    lines.push('例如：' + g.names.filter(Boolean).join('、') + (g.count > g.names.length ? ' …' : ''));
    lines.push('');
  }
  confirmBox({ icon: 'alert', title: `${fmtN(t.failed)} 项失败`, message: '按原因分组如下：', detail: lines.join('\n').trim(), ok: '好', cancel: null });
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.round(s / 60) + ' 分钟';
  return (s / 3600).toFixed(1) + ' 小时';
}

// ---------------------------------------------------------------------------
// Stall banner: the helper reports when the phone stops answering (locked,
// screen off) long before anything times out.
// ---------------------------------------------------------------------------
let stallIds = new Set();
// The helper never aborts a slow call (aborting wedges some phones until
// replug); it reports level 1 = slow, level 2 = very long. Most slowness is a
// cold first read or a locked screen and clears by itself.
function onStall(m) {
  stallIds.add(m.id);
  const ios = state.device && state.device.kind === 'ios';
  $('stallText').textContent = (m.level || 1) >= 2
    ? '手机很久没有响应了。请确认手机已解锁' + (ios ? '' : '、USB 用途是「文件传输」') + '；仍没反应的话，请拔掉数据线重新插上'
    : '手机响应较慢，正在等待…（请保持手机解锁' + (state.listing ? '，第一次读取照片多时会慢一些' : '') + '）';
  $('stallBanner').hidden = false;
}
function onUnstall(m) { stallIds.delete(m.id); if (!stallIds.size) $('stallBanner').hidden = true; }
function hideStall() { stallIds.clear(); $('stallBanner').hidden = true; }

// ---------------------------------------------------------------------------
// Phases → device pill + guidance screen
// ---------------------------------------------------------------------------
function setPhase(p, info) {
  state.phase = p; state.phaseInfo = info || {};
  if (p === 'error' || p === 'bridgeFailed') state.lastError = { phase: p, ...state.phaseInfo, at: new Date().toISOString() };
  renderDevice(); renderEmpty(); updateSelectionUI();
}

function fmtBytes(b) {
  if (!(b >= 0)) return '';
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function renderDevice() {
  const pill = $('devicePill'), d = state.device;
  pill.className = 'device';
  $('deviceIco').innerHTML = ico(d && d.kind === 'other' ? 'camera' : 'phone');
  let name = '未连接手机', sub = '插上数据线即可自动识别';
  if (state.phase === 'starting') { name = '正在启动…'; sub = '请稍候'; pill.classList.add('busy'); }
  else if (state.phase === 'bridgeFailed') { name = '后台组件未能启动'; sub = '点击右上角 ⋯ 复制诊断信息'; pill.classList.add('err'); }
  else if (d) {
    name = d.name;
    if (state.phase === 'loading' || state.listing) { sub = state.listCount ? `正在读取… 已找到 ${fmtN(state.listCount)} 项` : '正在读取…'; pill.classList.add('busy'); }
    else if (state.phase === 'needAccess') { sub = d.kind === 'ios' ? '等待在 iPhone 上点「信任」' : '等待切换到「文件传输」'; pill.classList.add('warn'); }
    else if (state.phase === 'error') { sub = '读取出错'; pill.classList.add('err'); }
    else {
      const free = state.storages.reduce((s, x) => s + (x.free || 0), 0);
      sub = `已连接 · ${fmtN(state.items.length)} 项` + (free > 0 ? ` · 剩余 ${fmtBytes(free)}` : '');
      pill.classList.add('ok');
    }
  } else if (state.phase === 'appleNoDriver') { name = '检测到 iPhone'; sub = '需要授权或安装驱动'; pill.classList.add('warn'); }
  $('deviceName').textContent = name;
  $('deviceSubText').textContent = sub;
  // device switcher
  const sel = $('deviceSelect');
  const sig = state.devices.map((x) => x.id).join('|') + '#' + (d ? d.id : '');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    state.devices.forEach((x) => { const o = document.createElement('option'); o.value = x.id; o.textContent = x.name + (x.kind === 'other' ? '（非手机设备）' : ''); sel.appendChild(o); });
    if (d) sel.value = d.id;
    else if (state.devices.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '选择设备…'; o.disabled = true; sel.prepend(o); sel.value = ''; }
  }
  sel.disabled = state.devices.length === 0 || (state.devices.length === 1 && d && state.devices[0].id === d.id);
  pill.classList.toggle('multi', !sel.disabled);
  $('refreshBtn').disabled = state.phase === 'bridgeFailed' || state.phase === 'starting';
  $('refreshBtn').classList.toggle('spinning', !!state.listing);
}

function renderEmpty() {
  const box = $('emptyState');
  const show = state.view.length === 0;
  box.hidden = !show;
  if (!show) return;
  const p = state.phase, info = state.phaseInfo || {};
  const d = state.device;
  let html = '';
  const card = (icon, iconCls, title, lead, extra = '') =>
    `<div class="empty-card"><div class="empty-icon ${iconCls}">${icon}</div><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}${extra}</div>`;
  const stepsBoth = `
    <div class="steps">
      <div class="step-card"><h3>${ico('phone')} iPhone / iPad</h3><ol>
        <li>用数据线连接电脑，<b>解锁</b>手机</li>
        <li>弹出「要信任此电脑吗？」时点 <b>信任</b>，输入锁屏密码</li>
        <li>照片会自动出现在这里</li></ol></div>
      <div class="step-card"><h3>${ico('phone')} 安卓手机</h3><ol>
        <li>用数据线连接电脑，<b>解锁</b>手机</li>
        <li>下拉通知栏，点「USB 已连接 / 正在充电」</li>
        <li>把 USB 用途改为 <b>文件传输（MTP）</b></li></ol></div>
    </div>`;
  if (p === 'starting') html = card('<div class="spinner lg"></div>', '', '正在启动…', '');
  else if (p === 'bridgeFailed') {
    html = card(ico('alert'), 'err', '后台组件无法启动',
      '插件用来读取手机的后台组件被系统阻止了，常见原因是杀毒软件（如 360、火绒、电脑管家）拦截。请把 Eagle 的插件文件夹加入信任/白名单，然后重新打开插件。',
      `<div class="actions"><button class="btn btn-primary" id="emRetry">重试</button><button class="btn" id="emDiag">复制诊断信息</button></div>
       <div class="code">${escapeHtml(info.error || '')}</div>`);
  } else if (!d && p === 'appleNoDriver') {
    const noDriver = info.problem === 28 || info.problem === 1 || info.problem === 10;
    html = card(ico('lock'), 'warn', '已检测到 iPhone，但还不能读取照片',
      noDriver ? 'Windows 还没有为 iPhone 装好驱动。' : '请解锁 iPhone，并在弹出的「要信任此电脑吗？」中点「信任」。',
      `<div class="steps">
        <div class="step-card"><h3>1. 在手机上授权</h3><ol><li>解锁 iPhone</li><li>点 <b>信任</b> 并输入锁屏密码</li><li>没看到弹窗？拔下数据线再插一次</li></ol></div>
        <div class="step-card"><h3>2. 仍然不行？安装驱动</h3><ol><li>从 Microsoft Store 安装 <b>Apple Devices</b>（或 iTunes），它会安装 iPhone 驱动</li><li>装好后重新插拔数据线</li></ol></div>
      </div>
      <div class="actions"><button class="btn btn-primary" id="emStore">打开 Microsoft Store</button></div>
      <div class="hint"><span class="spinner sm"></span>正在等待手机…</div>`);
  } else if (!d) {
    const others = info.others ? `<div class="hint">已连接 ${info.others} 个非手机设备，可以点左上角选择它。</div>` : '';
    html = card(ico('plug'), 'blue', '连接手机以开始', '插上数据线后会自动识别，不用点刷新。', stepsBoth + others + '<div class="hint"><span class="spinner sm"></span>正在等待手机连接…</div>');
  } else if (p === 'needAccess') {
    const ios = d.kind === 'ios';
    html = card(ico('lock'), 'warn', ios ? '请在 iPhone 上点「信任」' : '请在手机上允许传输文件',
      ios ? `「${escapeHtml(d.name)}」已连接，但还没有授权这台电脑读取照片。请解锁 iPhone，在弹窗中点 <b>信任</b> 并输入锁屏密码。没有弹窗的话，拔下数据线重新插一次。`
          : `「${escapeHtml(d.name)}」已连接，但现在是「仅充电」模式。请下拉通知栏，点「USB 已连接 / 正在充电」，选择 <b>文件传输（MTP）</b>。`,
      '<div class="hint"><span class="spinner sm"></span>授权后会自动继续…</div>');
  } else if (p === 'loading') {
    html = card('<div class="spinner lg"></div>', '', '正在读取照片…',
      state.listCount ? `已找到 ${fmtN(state.listCount)} 项` : `正在打开「${escapeHtml(d.name)}」…`,
      '<div class="hint">照片多时第一次读取需要一点时间，请保持手机解锁。</div>');
  } else if (p === 'error') {
    html = card(ico('alert'), 'err', escapeHtml(info.title || '读取失败'), escapeHtml(info.detail || ''),
      `<div class="actions"><button class="btn btn-primary" id="emRetry">重试</button><button class="btn" id="emDiag">复制诊断信息</button></div>
       ${info.code ? `<div class="code">${escapeHtml(info.code)}</div>` : ''}`);
  } else if (p === 'empty' || state.items.length === 0) {
    html = card(ico('image'), '', '手机上没有找到照片',
      d.kind === 'ios' ? '如果照片开启了「iCloud 照片 · 优化 iPhone 存储」，原图可能不在手机上。也请确认 iPhone 已解锁。' : '请确认手机已解锁，且 USB 用途是「文件传输」。',
      '<div class="actions"><button class="btn" id="emRetry">重新读取</button></div>');
  } else {
    const f = state.filter;
    html = card(ico(f === 'new' ? 'ok' : 'image'), f === 'new' ? 'blue' : '',
      f === 'new' ? '全部都导入过了' : f === 'video' ? '没有视频' : '没有照片', f === 'new' ? '这台设备上的照片都已经在 Eagle 里了。' : '');
  }
  box.innerHTML = html;
  const r = $('emRetry');
  if (r) r.onclick = () => {
    if (state.phase === 'bridgeFailed') { setPhase('starting'); backend.start().then(() => pollDevices()).catch((e) => setPhase('bridgeFailed', { error: e.message })); }
    else reloadDevice(true);
  };
  const dg = $('emDiag'); if (dg) dg.onclick = copyDiagnostics;
  const st = $('emStore'); if (st) st.onclick = () => openExternal('ms-windows-store://pdp/?productid=9NP83LWLPZ9K');
}

// ---------------------------------------------------------------------------
// Error explanations (codes come from the helper)
// ---------------------------------------------------------------------------
function explain(e) {
  const code = (e && (e.code || e.phase)) || 'ERROR';
  const ios = state.device && state.device.kind === 'ios';
  const T = {
    NO_DEVICE: ['手机未连接', '请用数据线连接手机。'],
    DISCONNECTED: ['手机连接断开了', '数据线可能松动，或手机休眠断开了连接。请重新插好数据线、保持手机解锁后重试。'],
    ACCESS_DENIED: ['手机拒绝了访问', ios ? '请解锁 iPhone，并在弹窗中点「信任」。' : '请解锁手机，并把 USB 用途改为「文件传输」。'],
    NO_STORAGE: ['手机还没有授权', ios ? '请解锁 iPhone，并在弹窗中点「信任」。' : '请把 USB 用途改为「文件传输」。'],
    DEVICE_BUSY: ['手机正被其他程序占用', '请关闭 Windows「照片」导入、iTunes / Apple Devices、手机助手，以及资源管理器里打开的手机窗口，然后重试。'],
    TIMEOUT: ['手机没有响应', ios ? '手机可能锁屏了。请解锁 iPhone 并保持亮屏（设置 → 显示与亮度 → 自动锁定 → 永不），然后重试。' : '手机可能锁屏或休眠了。请解锁手机并保持亮屏后重试。'],
    DISK_FULL: ['电脑磁盘空间不足', '请清理磁盘空间后重试。'],
    LOCAL_IO: ['无法写入电脑上的文件', '目标文件夹可能没有写入权限，或被安全软件拦截。'],
    NOT_FOUND: ['文件已不在手机上', '可能已在手机上被删除或移动，刷新后再试。'],
    EMPTY: ['手机没有提供原图', ios ? '开启了「优化 iPhone 存储」时原图可能只在 iCloud。请在手机上打开这张照片，等原图下载完再试。' : '文件可能已损坏或正被占用。'],
    RENDER_FAILED: ['无法预览这个文件', 'HEIC 照片需要 Windows 的「HEIF 图像扩展」与「HEVC 视频扩展」（Microsoft Store 免费安装）。导入 Eagle 不受影响。'],
    RENDER_TIMEOUT: ['图片解码卡住了', 'Windows 的图片解码器没有响应，已跳过。导入 Eagle 不受影响。'],
    UNKNOWN: ['无法确认是否已删除', '手机中途没有响应。请解锁手机后刷新，检查照片是否还在。'],
    REFUSED: ['手机拒绝删除', ios ? 'iPhone 可能锁屏了，或该照片属于「共享相簿 / iCloud」。可以在手机上手动删除。' : '手机系统拒绝了删除，可以在手机上手动删除。'],
    STILL_THERE: ['手机报告删除成功，但文件还在', '可能正被相册应用占用，稍后重试或在手机上删除。'],
    NO_STATUS: ['手机没有回报删除结果', '刷新后检查，必要时在手机上手动删除。'],
    CANCELLED: ['已取消', ''],
    EAGLE: ['Eagle 入库失败', '请确认 Eagle 资源库可写，磁盘空间充足。'],
    BRIDGE_START_FAILED: ['后台组件无法启动', '可能被杀毒软件拦截。请把插件文件夹加入白名单后重新打开插件。'],
    BRIDGE_EXIT: ['后台组件意外退出', '已自动恢复，请重试。'],
    BRIDGE_RESTART: ['连接已重置', '手机卡住后已自动重置，请重试。'],
    DEVICE_ERROR: ['读写手机时出错', '请拔插数据线、解锁手机后重试。'],
    DEVICE_RESET: ['手机连接刚刚重置', '请重试一次；如果反复出现，请拔插数据线。'],
  };
  const t = T[code] || ['出错了', (e && (e.error || e.message)) || ''];
  return { code, title: t[0], detail: t[1], raw: e && (e.error || e.message) };
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
let viewerReq = null;
const preloadReqs = new Map();   // id -> req
function previewBase(it) {
  return nodePath.join(dirs.preview, devKey(state.device), nodeCrypto.createHash('sha1').update(it.id).digest('hex').slice(0, 24));
}
// The helper names the file itself (original extension or .jpg); look for
// any finished candidate before asking the phone again.
function cachedPreview(it) {
  const c = state.previewCache.get(it.id);
  if (c && nodeFs.existsSync(c)) return c;
  const base = previewBase(it);
  for (const ext of ['.jpg', '.' + String(it.ext || '').toLowerCase()]) {
    try { if (nodeFs.statSync(base + ext).size > 0) { state.previewCache.set(it.id, base + ext); return base + ext; } } catch (_) {}
  }
  return null;
}
function requestPreview(it, prio) {
  const req = backend.preview(state.device.id, pick(it), previewBase(it), prio);
  req.promise.then((r) => { if (r.path) state.previewCache.set(it.id, r.path); if (r.date) it._date = r.date; }).catch(() => {});
  return req;
}

function openViewer(index) {
  if (index == null || index < 0 || index >= state.view.length || !state.device) return;
  hoverHide(); closeMenu();
  state.viewerIndex = index;
  state.focusId = state.view[index].id;
  $('viewer').hidden = false;
  loadViewer(index);
}
function closeViewer() {
  if (state.viewerIndex < 0) return;
  state.viewerIndex = -1;
  $('viewer').hidden = true;
  if (viewerReq) { viewerReq.cancel(); viewerReq = null; }
  preloadReqs.forEach((r) => r.cancel()); preloadReqs.clear();
  const img = $('viewerImg'); img.hidden = true; img.removeAttribute('src');
  const v = $('viewerVideo'); try { v.pause(); } catch (_) {} v.removeAttribute('src'); v.load(); v.hidden = true;
  repaintTiles();
  const i = idxOf(state.focusId); if (i >= 0) scrollIntoView(i);
}
function viewerKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); viewerNav(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); viewerNav(1); }
  else if (e.key === 'Delete') { e.preventDefault(); viewerDelete(); }
  else if (e.key === ' ') { const v = $('viewerVideo'); if (!v.hidden) { e.preventDefault(); if (v.paused) v.play().catch(() => {}); else v.pause(); } }
}
function viewerNav(d) { const n = state.viewerIndex + d; if (n >= 0 && n < state.view.length) { state.viewerIndex = n; state.focusId = state.view[n].id; loadViewer(n); } }

function setViewerMeta(it) {
  const parts = [];
  if (it._date) { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(it._date); if (m) parts.push(`${m[1]}年${+m[2]}月${+m[3]}日 ${m[4]}:${m[5]}`); }
  if (state.imported.has(it.id)) parts.push('已导入 Eagle');
  $('viewerMeta').textContent = parts.join(' · ');
}

function loadViewer(index) {
  const it = state.view[index]; if (!it) return;
  const img = $('viewerImg'), vid = $('viewerVideo'), msg = $('viewerMsg');
  $('viewerTitle').textContent = it.name;
  setViewerMeta(it);
  $('viewerCounter').textContent = `${fmtN(index + 1)} / ${fmtN(state.view.length)}`;
  $('viewerPrev').disabled = index <= 0;
  $('viewerNext').disabled = index >= state.view.length - 1;
  $('viewerAdd').disabled = false;
  $('viewerAdd').textContent = state.imported.has(it.id) ? '再次添加到 Eagle' : '添加到 Eagle';
  vResetZoom();
  msg.className = 'viewer-msg'; msg.textContent = '';
  try { vid.pause(); } catch (_) {}
  vid.removeAttribute('src'); vid.hidden = true;
  if (viewerReq) { viewerReq.cancel(); viewerReq = null; }

  const show = (path) => {
    if (state.viewerIndex !== index) return;
    if (it.kind === 'video') {
      img.hidden = true;
      vid.onerror = () => { if (state.viewerIndex === index) { msg.className = 'viewer-msg center'; msg.textContent = '这个视频格式无法在这里播放。可以先「添加到 Eagle」，再用系统播放器打开。'; } };
      vid.onloadeddata = () => {
        if (state.viewerIndex !== index) return;
        msg.textContent = vid.videoWidth === 0 ? '这是 HEVC 编码的视频，这里只能播放声音。添加到 Eagle 后可用系统播放器观看。' : '';
      };
      vid.src = fileHref(path); vid.hidden = false;
      vid.play().catch(() => {});
      return;
    }
    const big = new Image();
    big.onload = () => { if (state.viewerIndex === index) { img.src = big.src; img.hidden = false; msg.textContent = ''; } };
    big.onerror = () => { if (state.viewerIndex === index && img.hidden) { msg.className = 'viewer-msg center'; msg.textContent = '大图加载失败'; } };
    big.src = fileHref(path);
  };

  // Thumbnail first (instant), sharp preview when it lands.
  const thumb = knownThumb(it);
  if (it.kind === 'video') { img.hidden = true; if (thumb) vid.poster = fileHref(thumb); else vid.removeAttribute('poster'); }
  else if (thumb) { img.src = fileHref(thumb); img.hidden = false; }
  else img.hidden = true;

  const cached = cachedPreview(it);
  if (cached) show(cached);
  else {
    msg.textContent = it.kind === 'video' ? '正在从手机读取视频…' : '正在加载原图…';
    if (!thumb && it.kind !== 'video') msg.className = 'viewer-msg center';
    const pre = preloadReqs.get(it.id);
    const req = pre || requestPreview(it, 'high');
    preloadReqs.delete(it.id);
    viewerReq = req;
    req.promise.then((r) => {
      if (viewerReq === req) viewerReq = null;
      setViewerMeta(it);
      show(r.path);
    }).catch((e) => {
      if (viewerReq === req) viewerReq = null;
      if (e.code === 'CANCELLED' || state.viewerIndex !== index) return;
      const ex = explain(e);
      msg.className = 'viewer-msg' + (img.hidden ? ' center' : '');
      msg.textContent = `${ex.title}${ex.detail ? '\n' + ex.detail : ''}`;
    });
  }
  // Preload neighbours at normal priority; drop preloads that are no longer near.
  const keep = new Set();
  for (const d of [1, -1]) {
    const nb = state.view[index + d];
    if (!nb || nb.kind === 'video') continue;
    keep.add(nb.id);
    if (!preloadReqs.has(nb.id) && !cachedPreview(nb)) preloadReqs.set(nb.id, requestPreview(nb, 'normal'));
  }
  preloadReqs.forEach((r, id) => { if (!keep.has(id)) { r.cancel(); preloadReqs.delete(id); } });
}

async function viewerAdd() {
  const it = state.view[state.viewerIndex]; if (!it || !state.device) return;
  const dev = state.device;
  const btn = $('viewerAdd'); btn.disabled = true; btn.textContent = '正在添加…';
  const tmp = nodePath.join(backend.cacheBase(), 'import_one_' + Date.now());
  try {
    nodeFs.mkdirSync(tmp, { recursive: true });
    let path = null, code = null, errMsg = '';
    await backend.copy(dev.id, [pick(it)], tmp, { prio: 'high' }, (ev) => {
      if (ev.type === 'item') { if (ev.ok) path = ev.path; else { code = ev.code; errMsg = ev.error; } }
    }).promise;
    if (!path) throw Object.assign(new Error(errMsg || '传输失败'), { code });
    await eagle.item.addFromPath(path, {
      name: stripExt(it.name), tags: [SYNC_TAG], folders: state.targetFolder ? [state.targetFolder] : [],
      annotation: annotationFor(dev.name, it.id),
    });
    markImported(it.id);
    toast(`已添加到 Eagle「${folderLabel()}」`, 'success');
    setViewerMeta(it);
    btn.textContent = '再次添加到 Eagle';
  } catch (e) {
    toast('添加失败：' + explain(e).title, 'error');
    btn.textContent = state.imported.has(it.id) ? '再次添加到 Eagle' : '添加到 Eagle';
  } finally { btn.disabled = false; rmDir(tmp); }
}

async function viewerDelete() {
  const it = state.view[state.viewerIndex]; if (!it || !state.device) return;
  if (state.task) { toast('请等待当前任务完成'); return; }
  const yes = await confirmBox({
    icon: 'trash', danger: true, title: '从手机删除这张照片？',
    message: it.name, detail: state.imported.has(it.id) ? '这张已经导入 Eagle。' : '注意：这张还没有导入 Eagle，删除后无法恢复。', ok: '删除',
  });
  if (!yes) return;
  const idx = state.viewerIndex;
  $('viewerDelete').disabled = true;
  try {
    let res = null;
    await backend.remove(state.device.id, [pick(it)], (ev) => { if (ev.type === 'item') res = ev; }).promise;
    if (res && res.ok) {
      removeItem(it.id); applyView(false);
      if (!state.view.length) { closeViewer(); return; }
      state.viewerIndex = Math.min(idx, state.view.length - 1);
      loadViewer(state.viewerIndex);
      toast('已从手机删除', 'success');
    } else toast('删除失败：' + explain({ code: res ? res.code : 'NO_STATUS' }).title, 'error');
  } catch (e) { toast('删除失败：' + explain(e).title, 'error'); }
  finally { $('viewerDelete').disabled = false; }
}

// Zoom (wheel, cursor-centred), pan when zoomed, swipe to navigate when not.
let vZoom = 1, vPanX = 0, vPanY = 0;
function vApply() { const t = `translate(${vPanX}px, ${vPanY}px) scale(${vZoom})`; $('viewerImg').style.transform = t; $('viewerVideo').style.transform = t; }
function vResetZoom() { vZoom = 1; vPanX = 0; vPanY = 0; vApply(); }
function wireViewerZoom() {
  const stage = $('viewerStage');
  stage.addEventListener('wheel', (e) => {
    if (state.viewerIndex < 0) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2;
    const nz = Math.max(1, Math.min(8, vZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (nz <= 1) { vPanX = 0; vPanY = 0; } else { const k = nz / vZoom; vPanX = cx - (cx - vPanX) * k; vPanY = cy - (cy - vPanY) * k; }
    vZoom = nz; vApply();
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (state.viewerIndex < 0 || !$('viewerVideo').hidden) return;
    if (vZoom > 1) vResetZoom();
    else { const r = stage.getBoundingClientRect(); const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2; vZoom = 2.5; vPanX = -cx * 1.5; vPanY = -cy * 1.5; vApply(); }
  });
  let down = false, sx = 0, sy = 0, startX = 0;
  stage.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'VIDEO' && vZoom <= 1) return;   // let the video controls work
    e.preventDefault(); down = true; sx = e.clientX; sy = e.clientY; startX = e.clientX;
  });
  stage.addEventListener('dragstart', (e) => e.preventDefault());
  window.addEventListener('mousemove', (e) => { if (down && vZoom > 1) { vPanX += e.clientX - sx; vPanY += e.clientY - sy; sx = e.clientX; sy = e.clientY; vApply(); } });
  window.addEventListener('mouseup', (e) => {
    if (!down) return; down = false;
    if (vZoom <= 1 && state.viewerIndex >= 0) { const dx = e.clientX - startX; if (Math.abs(dx) > 70) viewerNav(dx < 0 ? 1 : -1); }
  });
}

// ---------------------------------------------------------------------------
// Hover preview (magnifier)
// ---------------------------------------------------------------------------
let hoverTimer = null, hoverId = null, hoverReq = null;
function hoverShow(id) {
  hoverId = id;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => doHover(id), 160);
}
function hoverHide() {
  clearTimeout(hoverTimer); hoverId = null;
  if (hoverReq) { hoverReq.cancel(); hoverReq = null; }
  $('hoverPreview').hidden = true;
}
function doHover(id) {
  if (hoverId !== id || state.viewerIndex >= 0) return;
  const it = state.byId.get(id); if (!it || !state.device) return;
  const img = $('hoverImg');
  $('hoverName').textContent = it.name + (it.kind === 'video' ? '（视频）' : '');
  const thumb = knownThumb(it);
  if (thumb) img.src = fileHref(thumb); else img.removeAttribute('src');
  $('hoverPreview').hidden = false;
  if (it.kind === 'video') return;
  const setBig = (p) => { const b = new Image(); b.onload = () => { if (hoverId === id) img.src = b.src; }; b.src = fileHref(p); };
  const c = cachedPreview(it);
  if (c) { setBig(c); return; }
  hoverReq = requestPreview(it, 'high');
  const req = hoverReq;
  req.promise.then((r) => { if (hoverReq === req) hoverReq = null; if (hoverId === id) setBig(r.path); }).catch(() => { if (hoverReq === req) hoverReq = null; });
}

// ---------------------------------------------------------------------------
// Drag to Eagle — hands Eagle the ORIGINAL file. The original must be on disk
// before the OS drag starts, so the transfer begins on a press-and-hold (a
// quick click never pays for it) and a ghost holds the gesture until the file
// lands, at which point the real drag starts if the button is still down.
// ---------------------------------------------------------------------------
const dragCache = new Map();     // id -> local path (insertion order = LRU)
const dragInflight = new Map();  // id -> Promise
let mouseIsDown = false, pressTimer = null, pressReq = null, activeDrag = null, dragToken = 0;
const DRAG_CACHE_MAX = 60;

function dragItemsFor(id) {
  return state.selected.has(id) ? selectedItems() : [state.byId.get(id)].filter(Boolean);
}
function hasDragFile(id) { const p = dragCache.get(id); if (p && nodeFs.existsSync(p)) return true; dragCache.delete(id); return false; }
function fetchOriginals(items, prio) {
  const waits = items.map((it) => dragInflight.get(it.id)).filter(Boolean);
  const todo = items.filter((it) => !hasDragFile(it.id) && !dragInflight.has(it.id));
  let req = null;
  if (todo.length && state.device) {
    try { nodeFs.mkdirSync(dirs.drag, { recursive: true }); } catch (_) {}
    req = backend.copy(state.device.id, todo.map(pick), dirs.drag, { prio, keepTimes: true }, (ev) => {
      if (ev.type === 'item' && ev.ok) dragCache.set(ev.itemId, ev.path);
    });
    const p = req.promise.catch(() => {}).then(() => todo.forEach((it) => dragInflight.delete(it.id)));
    todo.forEach((it) => dragInflight.set(it.id, p));
    waits.push(p);
  }
  const done = Promise.all(waits).then(() => {
    while (dragCache.size > DRAG_CACHE_MAX) {
      const [k, p] = dragCache.entries().next().value;
      if (items.some((it) => it.id === k)) break;
      dragCache.delete(k); try { nodeFs.unlinkSync(p); } catch (_) {}
    }
    return items.map((it) => dragCache.get(it.id)).filter(Boolean);
  });
  return { req, done };
}
function onTileMouseDown(id, e) {
  if (e.button !== 0) return;
  mouseIsDown = true;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!mouseIsDown) return;
    const items = dragItemsFor(id).filter((it) => it.kind !== 'video').slice(0, 6);
    if (items.some((it) => !hasDragFile(it.id))) pressReq = fetchOriginals(items, 'normal').req;
  }, 140);
  const up = () => {
    window.removeEventListener('mouseup', up);
    clearTimeout(pressTimer);
    // A press that never became a drag: stop pulling originals nobody needs.
    if (pressReq && !activeDrag) { pressReq.cancel(); }
    pressReq = null;
  };
  window.addEventListener('mouseup', up);
}
async function onTileDragStart(id, e) {
  e.preventDefault();
  if (!(typeof eagle !== 'undefined' && eagle.drag && eagle.drag.startDrag)) return;
  const items = dragItemsFor(id); if (!items.length) return;
  pressReq = null;   // the drag now owns any running transfer
  const ready = items.every((it) => hasDragFile(it.id)) ? items.map((it) => dragCache.get(it.id)) : null;
  if (ready) { beginOsDrag(ready); return; }
  const token = ++dragToken;
  endGhost();
  activeDrag = { token, tile: rendered.get(id), ghost: makeGhost(id, items.length, e.clientX, e.clientY) };
  if (activeDrag.tile) activeDrag.tile.classList.add('dragging');
  window.addEventListener('mousemove', moveGhost);
  setStatus(items.length > 1 ? `正在准备 ${items.length} 个原图…按住不要松开` : '正在准备原图…按住不要松开');
  try {
    const paths = await fetchOriginals(items, 'high').done;
    if (token !== dragToken) return;
    if (!paths.length) { setStatus('原图准备失败（iPhone 的原图可能只在 iCloud）', true); return; }
    if (mouseIsDown) beginOsDrag(paths);
    else setStatus(`原图已准备好（${paths.length} 个），再拖一次即可`);
  } catch (err) { setStatus('准备原图出错：' + err.message, true); }
  finally { if (token === dragToken) endGhost(); }
}
function beginOsDrag(paths) {
  mouseIsDown = false;
  setStatus(`拖拽 ${paths.length} 个原图到 Eagle`);
  try { eagle.drag.startDrag(paths); } catch (e) { setStatus('拖拽失败：' + e.message, true); }
}
function makeGhost(id, count, x, y) {
  const it = state.byId.get(id);
  const g = document.createElement('div');
  g.style.cssText = `position:fixed;z-index:9999;pointer-events:none;width:96px;height:96px;border-radius:14px;overflow:hidden;
    box-shadow:0 14px 34px rgba(0,0,0,.45),0 0 0 2px var(--primary);background:var(--tile-bg);transform:translate(-50%,-50%) rotate(-4deg);left:${x}px;top:${y}px`;
  const th = it && knownThumb(it);
  if (th) g.innerHTML = `<img src="${fileHref(th)}" style="width:100%;height:100%;object-fit:cover">`;
  g.insertAdjacentHTML('beforeend', `<div style="position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.2)"><i style="display:block;height:100%;width:30%;background:var(--primary);animation:indet 1s ease-in-out infinite"></i></div>`);
  if (count > 1) g.insertAdjacentHTML('beforeend', `<div style="position:absolute;top:6px;right:6px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:var(--primary);color:#fff;font:600 12px/22px var(--font);text-align:center">${count}</div>`);
  document.body.appendChild(g);
  return g;
}
function moveGhost(e) { if (activeDrag && activeDrag.ghost) { activeDrag.ghost.style.left = e.clientX + 'px'; activeDrag.ghost.style.top = e.clientY + 'px'; } }
function endGhost() {
  window.removeEventListener('mousemove', moveGhost);
  if (activeDrag) { if (activeDrag.ghost) activeDrag.ghost.remove(); if (activeDrag.tile) activeDrag.tile.classList.remove('dragging'); }
  activeDrag = null;
}

// ---------------------------------------------------------------------------
// Eagle folders (import target)
// ---------------------------------------------------------------------------
let foldersLoading = false;
async function loadFolders() {
  if (foldersLoading || typeof eagle === 'undefined' || !eagle.folder) return;
  foldersLoading = true;
  try {
    const all = await eagle.folder.getAll();
    const byId = new Map();
    const walk = (f, depth) => {
      if (!f || byId.has(f.id)) return;
      byId.set(f.id, { id: f.id, name: f.name, depth });
      (f.children || []).forEach((c) => walk(c, depth + 1));
    };
    (all || []).filter((f) => !f.parent).forEach((f) => walk(f, 0));
    (all || []).forEach((f) => walk(f, 0));   // anything not reachable from a root
    state.folders = Array.from(byId.values());
    const sel = $('folderSelect');
    const cur = state.targetFolder;
    sel.innerHTML = '<option value="">未分类</option>' +
      state.folders.map((f) => `<option value="${escapeHtml(f.id)}">${'　'.repeat(f.depth)}${escapeHtml(f.name)}</option>`).join('');
    if (cur && byId.has(cur)) sel.value = cur; else { sel.value = ''; if (cur) { state.targetFolder = ''; pref('folder', ''); } }
  } catch (e) { backend && backend.log('load folders failed: ' + e.message); }
  finally { foldersLoading = false; }
}

// ---------------------------------------------------------------------------
// Menus, modal, toast
// ---------------------------------------------------------------------------
let menuEl = null;
function showMenu(x, y, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'popover';
  items.forEach((it) => {
    if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); return; }
    const row = document.createElement('div');
    row.className = 'menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    row.innerHTML = `${ico(it.icon)}<span>${escapeHtml(it.label)}</span>${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}`;
    row.onclick = () => { closeMenu(); it.action(); };
    m.appendChild(row);
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  menuEl = m;
  setTimeout(() => window.addEventListener('mousedown', menuAway, true), 0);
}
function menuAway(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function closeMenu() {
  window.removeEventListener('mousedown', menuAway, true);
  if (!menuEl) return false;
  menuEl.remove(); menuEl = null; return true;
}
function showMoreMenu(btn) {
  const r = btn.getBoundingClientRect();
  showMenu(r.right - 210, r.bottom + 6, [
    { icon: 'copy', label: '复制诊断信息', action: copyDiagnostics },
    { icon: 'file', label: '打开日志文件夹', action: () => openPath(nodePath.dirname(backend.logFile())) },
    { icon: 'clean', label: '清理缓存', disabled: !!state.task, action: clearCaches },
    { sep: true },
    { icon: 'info', label: `关于 · 版本 ${PLUGIN_VERSION}`, action: showAbout },
  ]);
}

function confirmBox({ icon = 'info', title, message, detail, ok = '确定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal" role="dialog">
      <div class="modal-icon ${danger ? 'danger' : ''}">${ico(icon)}</div>
      <div class="modal-title">${escapeHtml(title || '')}</div>
      ${message ? `<div class="modal-msg">${escapeHtml(message)}</div>` : ''}
      ${detail ? `<div class="modal-detail">${escapeHtml(detail)}</div>` : ''}
      <div class="modal-btns">${cancel ? `<button class="btn" data-r="0">${escapeHtml(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-r="1">${escapeHtml(ok)}</button></div></div>`;
    let done = false;
    const close = (v) => { if (done) return; done = true; document.removeEventListener('keydown', key, true); ov.remove(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(!danger || e.target.dataset.r === '1'); }
    };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(false); const r = e.target.closest('[data-r]'); if (r) close(r.dataset.r === '1'); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(ov);
    // Destructive confirmations focus Cancel, so a stray Enter never deletes.
    const focusBtn = ov.querySelector(danger && cancel ? '[data-r="0"]' : '[data-r="1"]');
    if (focusBtn) focusBtn.focus();
  });
}

function toast(text, kind, action) {
  const host = $('toastHost');
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = text;
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); t.remove(); }; t.appendChild(b); }
  host.appendChild(t);
  while (host.children.length > 3) host.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, kind === 'error' ? 5000 : 3000);
}

function setStatus(text, isErr) { const el = $('status'); el.textContent = text || ''; el.classList.toggle('err', !!isErr); }

// ---------------------------------------------------------------------------
// Diagnostics, caches, misc
// ---------------------------------------------------------------------------
async function copyDiagnostics() {
  const lines = [];
  const info = backend ? backend.info() : {};
  lines.push(`手机照片同步 ${PLUGIN_VERSION} · 后台 ${info.mode || '未启动'} ${info.version || ''} · Eagle ${eagleApp('version')} (build ${eagleApp('build')})`);
  lines.push(`Windows ${nodeOs.release()} ${process.arch} · CLR ${info.clr || '?'} · ${info.x64 ? 'x64' : 'x86'} · 语言 ${eagleApp('locale')}`);
  lines.push(`状态：${state.phase}${state.lastError ? ' · 上次错误 ' + JSON.stringify(state.lastError) : ''}`);
  lines.push(`已读取 ${state.items.length} 项 · 已导入记录 ${state.imported.size} · 缓存 ${backend ? backend.cacheBase() : ''}`);
  if (info.startError) lines.push('启动错误：' + info.startError);
  try {
    const d = await Promise.race([backend.diag(state.device ? state.device.id : ''), new Promise((_, rej) => setTimeout(() => rej(new Error('diag timeout')), 15000))]);
    lines.push('设备：' + JSON.stringify(d.devices));
    if (d.model || d.session) lines.push(`当前设备：model=${d.model || ''} fw=${d.firmware || ''} protocol=${d.protocol || ''} bulk=${d.bulk} thumbKey=${d.thumbKey || ''} ${d.session || ''}`);
    if (d.storages) lines.push('存储：' + JSON.stringify(d.storages));
    lines.push('USB：' + JSON.stringify(d.usb));
  } catch (e) { lines.push('诊断查询失败：' + e.message); }
  lines.push('', '---- 日志（最近部分）----', backend ? backend.readLogTail(16000) : '');
  const text = lines.join('\n');
  try {
    if (eagle.clipboard && eagle.clipboard.writeText) eagle.clipboard.writeText(text);
    else await navigator.clipboard.writeText(text);
    toast('诊断信息已复制，可以直接粘贴发给开发者', 'success');
  } catch (e) { toast('复制失败：' + e.message, 'error'); }
}

function showAbout() {
  const info = backend.info();
  confirmBox({
    icon: 'phone', title: '手机照片同步',
    message: `版本 ${PLUGIN_VERSION}`,
    detail: `通过 USB 读取 iPhone / 安卓手机的照片和视频，导入 Eagle、导出备份或从手机删除。\n\n后台组件：${info.mode === 'ps' ? 'PowerShell 兼容模式' : '原生模式'} ${info.version || ''}\n缓存位置：${backend.cacheBase()}`,
    ok: '好', cancel: null,
  });
}

async function clearCaches() {
  const yes = await confirmBox({ icon: 'clean', title: '清理缓存？', message: '会删除已生成的缩略图和预览图，下次浏览时重新生成。不影响手机和 Eagle 里的照片。', ok: '清理' });
  if (!yes) return;
  if (state.thumbInflight) state.thumbInflight.req.cancel();
  rmDir(dirs.thumbs); rmDir(dirs.preview); rmDir(dirs.drag);
  dragCache.clear(); state.previewCache.clear();
  state.items.forEach((it) => { it._t = null; it._tc = false; it._tf = false; });
  layoutGrid(true);
  toast('缓存已清理', 'success');
}

function rmDir(p) { try { nodeFs.rmSync(p, { recursive: true, force: true }); } catch (_) { try { nodeFs.rmdirSync(p, { recursive: true }); } catch (__) {} } }

// Start-up housekeeping: staging folders from a crash, the old flat caches of
// earlier versions, and size caps on the persistent caches (done async).
function cleanupStartup() {
  const base = backend.cacheBase();
  rmDir(dirs.drag);
  try {
    for (const name of nodeFs.readdirSync(base)) {
      if (/^(import|one)_/.test(name)) rmDir(nodePath.join(base, name));
      else if (/^ids_.*\.json$/.test(name)) { try { nodeFs.unlinkSync(nodePath.join(base, name)); } catch (_) {} }
    }
  } catch (_) {}
  for (const d of [dirs.thumbs, dirs.preview]) {
    try { for (const f of nodeFs.readdirSync(d)) { const p = nodePath.join(d, f); if (nodeFs.statSync(p).isFile()) nodeFs.unlinkSync(p); } } catch (_) {}
  }
  setTimeout(() => { pruneDir(dirs.thumbs, 500e6, 0); pruneDir(dirs.preview, 1.5e9, 3 * 864e5); }, 8000);
}
async function pruneDir(dir, maxBytes, maxAgeMs) {
  const fsp = nodeFs.promises, files = [];
  const walk = async (d) => {
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { const st = await fsp.stat(p); files.push({ p, size: st.size, t: st.mtimeMs }); } catch (_) {} }
    }
  };
  await walk(dir);
  // Leftovers of interrupted transfers/renders are never valid cache entries.
  for (let i = files.length - 1; i >= 0; i--) {
    if (/\.part$|\.src\.[a-z0-9]+$/i.test(files[i].p)) { try { await fsp.unlink(files[i].p); } catch (_) {} files.splice(i, 1); }
  }
  const now = Date.now();
  let total = files.reduce((s, f) => s + f.size, 0);
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= maxBytes && !(maxAgeMs && now - f.t > maxAgeMs)) continue;
    try { await fsp.unlink(f.p); total -= f.size; } catch (_) {}
  }
}

function openPath(p) {
  try { if (eagle.shell && eagle.shell.openPath) { eagle.shell.openPath(p); return; } } catch (_) {}
  try { require('child_process').spawn('explorer.exe', [p], { detached: true }); } catch (_) {}
}
function openExternal(url) {
  try { if (eagle.shell && eagle.shell.openExternal) { eagle.shell.openExternal(url); return; } } catch (_) {}
  try { require('child_process').spawn('explorer.exe', [url], { detached: true }); } catch (_) {}
}
function stripExt(name) { return String(name).replace(/\.[^.]+$/, ''); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
