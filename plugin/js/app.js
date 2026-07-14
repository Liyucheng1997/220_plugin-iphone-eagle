/* app.js — Phone Photo Sync (Eagle plugin, iPhone + Android): virtualized grid + viewer. */

let backend = null, nodePath = null, nodeOs = null, nodeFs = null, fileUrl = null;

const SYNC_TAG = '手机照片';  // Eagle tag applied to every imported photo/video.

let TILE = 150;                 // tile size in px (adjustable via zoom bar)
const GAP = 10, PAD = 12, HEADER_H = 34, SECTION_GAP = 6;
let CELL = TILE + GAP;
const TILE_MIN = 90, TILE_MAX = 260;

let targetTile = 150;   // desired tile size (from zoom bar); actual is stretched to fill the row
function setTileSize(px) {
  targetTile = Math.max(TILE_MIN, Math.min(TILE_MAX, Math.round(px)));
  const r = $('zoomRange'); if (r && +r.value !== targetTile) r.value = targetTile;
  layoutGrid();
}

let state = {
  device: '',
  loading: false,               // guards against overlapping device reads (MTP is single-accessor)
  items: [], view: [],
  selected: new Set(), focused: null, lastClickedIndex: null, filterKind: 'all',
  thumbDir: '', previewDir: '',
  // virtualization + month grouping
  cols: 1,
  headers: [],                // [{y, label, count}]
  itemPos: [],                // parallel to view: {x, y}
  totalHeight: 0,
  renderedHeaders: new Map(), // headerIndex -> element
  renderedTiles: new Map(),   // index -> element
  thumbCache: new Map(),      // id -> thumb path
  thumbReq: new Set(),        // ids already requested
  thumbQueue: new Map(),      // id -> {id, oid}
  thumbBusy: false,
  previewCache: new Map(),    // id -> preview path
  // viewer
  viewerIndex: -1,
  folders: [],
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
function rmDir(p) {
  try { nodeFs.rmSync(p, { recursive: true, force: true }); }
  catch (_) { try { nodeFs.rmdirSync(p, { recursive: true }); } catch (__) {} }
}
// Remove all of the plugin's temp caches (thumbnails, previews, drag originals,
// import staging). Called on startup (clears crash leftovers) and on close.
function cleanupTempDirs() {
  if (!nodeOs || !backend) return;
  const base = backend.cacheBase();
  ['thumbs', 'preview', 'drag'].forEach((d) => rmDir(nodePath.join(base, d)));
  try {
    nodeFs.readdirSync(base).forEach((name) => {
      if (/^(import|one)_/.test(name)) rmDir(nodePath.join(base, name));
      if (/^ids_.*\.json$/.test(name)) { try { nodeFs.unlinkSync(nodePath.join(base, name)); } catch (_) {} }
    });
  } catch (_) {}
}

function boot(pluginPath) {
  nodePath = require('path'); nodeOs = require('os'); nodeFs = require('fs'); fileUrl = require('url');
  const base = pluginPath || nodePath.dirname(document.location.pathname.replace(/^\//, ''));
  backend = require(nodePath.join(base, 'js', 'backend.js'));
  backend.setBase(base);            // prefer an ASCII path next to the plugin, else C:\Users\Public
  const cb = backend.cacheBase();
  cleanupTempDirs();                // start fresh; also clears anything left from a crash
  state.thumbDir = nodePath.join(cb, 'thumbs');
  state.previewDir = nodePath.join(cb, 'preview');
  try { nodeFs.mkdirSync(state.thumbDir, { recursive: true }); } catch (_) {}
  try { nodeFs.mkdirSync(state.previewDir, { recursive: true }); } catch (_) {}
  wireEvents();
  detectAndLoad();
}

if (typeof eagle !== 'undefined') {
  eagle.onPluginCreate((plugin) => boot(plugin.path));
  if (eagle.onPluginBeforeExit) eagle.onPluginBeforeExit(() => cleanupTempDirs());
} else {
  window.addEventListener('load', () => setStatus('未检测到 Eagle 环境。请在 Eagle 中作为插件运行。', true));
}

// ---------------------------------------------------------------
// Events
// ---------------------------------------------------------------
let scrollScheduled = false, resizeTimer = null;
function wireEvents() {
  $('refreshBtn').onclick = detectAndLoad;
  $('deviceSelect').onchange = (e) => { state.device = e.target.value; loadPhotos(); };
  $('filterSeg').querySelectorAll('.seg').forEach((b) => {
    b.onclick = () => {
      state.filterKind = b.dataset.kind;
      $('filterSeg').querySelectorAll('.seg').forEach((x) => x.classList.toggle('active', x === b));
      applyView();
    };
  });
  $('sortBy').onchange = applyView;
  $('selectAll').onchange = (e) => toggleSelectAll(e.target.checked);
  $('zoomRange').oninput = (e) => setTileSize(+e.target.value);
  $('zoomOut').onclick = () => setTileSize(TILE - 20);
  $('zoomIn').onclick = () => setTileSize(TILE + 20);
  $('importBtn').onclick = doImport;
  $('deleteBtn').onclick = doDelete;

  $('grid').addEventListener('scroll', () => {
    if (!scrollScheduled) { scrollScheduled = true; requestAnimationFrame(() => { scrollScheduled = false; updateVisible(); }); }
  });
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layoutGrid, 100); });

  // Delete key on the grid deletes the selected photos from the phone.
  document.addEventListener('keydown', (e) => {
    if (state.viewerIndex >= 0) return;               // viewer handles its own keys
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.key === 'Delete') && state.selected.size > 0) { e.preventDefault(); doDelete(); }
  });

  // viewer
  $('viewerClose').onclick = closeViewer;
  $('viewerPrev').onclick = () => viewerNav(-1);
  $('viewerNext').onclick = () => viewerNav(1);
  $('viewerAdd').onclick = viewerAdd;
  $('viewerDelete').onclick = viewerDelete;
  wireViewerZoom();
}

// ---------------------------------------------------------------
// Device detection + load
// ---------------------------------------------------------------
async function detectAndLoad() {
  setStatus('正在检测设备…');
  try {
    const res = await backend.listDevices();
    const devices = (res && res.devices) || [];
    const sel = $('deviceSelect'); sel.innerHTML = '';
    if (devices.length === 0) {
      state.device = ''; state.items = []; applyView();
      showEmpty('未检测到手机。用数据线连接手机后点“刷新”。iPhone：在手机上点“信任此电脑”；安卓：下拉通知栏，把 USB 用途改为“传输文件 / MTP”（默认“仅充电”读不到照片）。');
      setStatus('无设备', true); return;
    }
    devices.forEach((d) => { const o = document.createElement('option'); o.value = d.name; o.textContent = d.name; sel.appendChild(o); });
    // Auto-select a phone: the backend flags phone-like devices; fall back to a
    // name match (iPhone or a known Android brand), else the first device.
    const brandRe = /iphone|ipad|ipod|apple|android|phone|galaxy|samsung|xiaomi|redmi|poco|huawei|honor|oppo|vivo|oneplus|pixel|google|moto|nokia|xperia|realme|asus|meizu|lenovo|tecno|infinix|nothing/i;
    const phone = devices.find((d) => d.phone) || devices.find((d) => brandRe.test(d.name || '') || brandRe.test(d.mfr || ''));
    state.device = phone ? phone.name : devices[0].name;
    sel.value = state.device;
    await loadPhotos();
  } catch (e) { setStatus('检测失败：' + e.message, true); showEmpty('检测设备出错：' + e.message); }
}

async function loadPhotos() {
  if (!state.device) return;
  // MTP allows only ONE accessor at a time. Never let two reads (e.g. a double
  // "刷新") overlap, and serialize the read behind any in-flight thumb/preview/
  // delete via deviceOp — otherwise the concurrent WPD sessions deadlock and the
  // read hangs until the cable is replugged.
  if (state.loading) return;
  state.loading = true;
  setBusy(true); setStatus(`正在读取「${state.device}」的照片…`); showEmpty('正在快速读取照片列表…'); showProgress(null);
  try {
    const onProgress = (n) => {
      const msg = `正在读取照片…已找到 ${n} 张`;
      setStatus(`「${state.device}」${msg}`);
      const p = document.querySelector('.empty p'); if (p) p.textContent = msg;
    };
    const res = await deviceOp(() => backend.listPhotos(state.device, 0, onProgress));
    if (!res.ok) { setStatus('读取失败：' + res.error, true); showEmpty(res.error); return; }
    state.items = res.items || [];
    state.selected.clear(); state.lastClickedIndex = null;
    state.thumbCache.clear(); state.thumbReq.clear(); state.previewCache.clear();
    thumbFailed.clear();   // a reload/refresh must retry thumbs (earlier failures may be stale)
    setStatus(`「${state.device}」共 ${state.items.length} 张照片/视频`);
    applyView();
  } catch (e) {
    if (e && e.code === 'IDLE_TIMEOUT') {
      setStatus('读取超时：设备无响应', true);
      showEmpty('读取卡住了——手机存储没有响应。请：拔插数据线、保持手机解锁（iPhone：设置→显示与亮度→自动锁定→永不；安卓：确认 USB 用途是“传输文件 / MTP”）、关掉占用手机的其它程序，然后点“刷新”。');
    } else { setStatus('读取失败：' + e.message, true); showEmpty('读取照片出错：' + e.message); }
  } finally { hideProgress(); setBusy(false); state.loading = false; }
}

// ---------------------------------------------------------------
// Filter / sort
// ---------------------------------------------------------------
function applyView() {
  const kind = state.filterKind;
  const sort = $('sortBy').value;
  let v = state.items.filter((it) => (kind === 'all' || it.kind === kind));
  const num = { numeric: true, sensitivity: 'base' };
  v.sort((a, b) => {
    switch (sort) {
      case 'order-asc': return a.id.localeCompare(b.id, undefined, num);
      case 'name-asc': return a.name.localeCompare(b.name, undefined, num);
      case 'order-desc': default: return b.id.localeCompare(a.id, undefined, num);
    }
  });
  state.view = v;
  layoutGrid();
  updateSelectionUI();
  $('footerInfo').textContent = state.items.length
    ? `显示 ${state.view.length} / ${state.items.length} 项　·　左键查看，右键选中，双击看大图`
    : '';
}

// ---------------------------------------------------------------
// Virtualized grid with month sections. iPhone folders are YYYYMM (e.g.
// 202506_a), so grouping is free from the folder name. Android puts everything
// under Camera/Screenshots/etc, so we fall back to a date embedded in the
// filename (IMG_20250131_..., PXL_20250131..., Screenshot_2025-01-31-...).
// ---------------------------------------------------------------
function monthOf(it) {
  const f = /^(\d{4})(0[1-9]|1[0-2])/.exec(it.folder || '');
  if (f) return { key: f[1] + f[2], label: `${f[1]}年${+f[2]}月` };
  const n = /(20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?[0-3]\d/.exec(it.name || '');
  if (n) return { key: n[1] + n[2], label: `${n[1]}年${+n[2]}月` };
  return { key: '000000', label: '未知日期' };
}

function buildLayout() {
  const cols = state.cols;
  state.headers = []; state.itemPos = new Array(state.view.length);
  let y = PAD, i = 0;
  while (i < state.view.length) {
    const mon = monthOf(state.view[i]);
    const headerIndex = state.headers.length;
    const headerY = y; y += HEADER_H;
    let k = 0, j = i;
    const rowStartY = y;
    while (j < state.view.length && monthOf(state.view[j]).key === mon.key) {
      const c = k % cols, r = Math.floor(k / cols);
      state.itemPos[j] = { x: PAD + c * CELL, y: rowStartY + r * CELL };
      k++; j++;
    }
    const rows = Math.ceil(k / cols);
    y = rowStartY + rows * CELL + SECTION_GAP;
    state.headers.push({ y: headerY, label: mon.label, count: k });
    i = j;
  }
  state.totalHeight = y;
}

function layoutGrid() {
  const grid = $('grid'), inner = $('gridInner');
  const width = grid.clientWidth || 800;
  // How many columns fit at the target size, then stretch tiles to fill the row.
  const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (targetTile + GAP)));
  const actual = Math.max(40, Math.floor((width - PAD * 2 - GAP * (cols - 1)) / cols));
  TILE = actual; CELL = actual + GAP;
  document.documentElement.style.setProperty('--tile', actual + 'px');
  state.cols = cols;
  buildLayout();
  inner.style.height = state.totalHeight + 'px';
  state.renderedTiles.forEach((el) => el.remove()); state.renderedTiles.clear();
  state.renderedHeaders.forEach((el) => el.remove()); state.renderedHeaders.clear();
  $('emptyState').style.display = state.view.length ? 'none' : '';
  updateVisible();
}

function updateVisible() {
  if (!state.view.length) return;
  const grid = $('grid'), inner = $('gridInner');
  const top = grid.scrollTop - 240, bot = grid.scrollTop + grid.clientHeight + 240;
  const frag = document.createDocumentFragment();
  // headers
  const needH = new Set();
  state.headers.forEach((h, hi) => { if (h.y + HEADER_H >= top && h.y <= bot) needH.add(hi); });
  state.renderedHeaders.forEach((el, hi) => { if (!needH.has(hi)) { el.remove(); state.renderedHeaders.delete(hi); } });
  needH.forEach((hi) => { if (!state.renderedHeaders.has(hi)) { const el = makeHeader(hi); state.renderedHeaders.set(hi, el); frag.appendChild(el); } });
  // tiles
  const needT = new Set();
  for (let i = 0; i < state.view.length; i++) { const p = state.itemPos[i]; if (p && p.y + TILE >= top && p.y <= bot) needT.add(i); }
  state.renderedTiles.forEach((el, idx) => { if (!needT.has(idx)) { el.remove(); state.renderedTiles.delete(idx); } });
  needT.forEach((i) => { if (!state.renderedTiles.has(i)) { const el = makeTile(i); state.renderedTiles.set(i, el); frag.appendChild(el); } });
  inner.appendChild(frag);
  scheduleThumbFlush(); // load thumbnails for whatever is now on screen
}

function makeHeader(hi) {
  const h = state.headers[hi];
  const el = document.createElement('div');
  el.className = 'date-header'; el.style.top = h.y + 'px';
  el.innerHTML = escapeHtml(h.label) + ' <span class="count">' + h.count + ' 张</span>';
  return el;
}

function makeTile(index) {
  const it = state.view[index];
  const el = document.createElement('div');
  el.className = 'tile' + (state.selected.has(it.id) ? ' selected' : '') + (state.focused === it.id ? ' focused' : '');
  // dataset.oid is REQUIRED: flushThumbs reads it to fetch the WPD thumbnail.
  // Without it every thumb request carries an empty oid and the backend skips
  // it, so no thumbnails are ever produced (blank tiles).
  el.dataset.id = it.id; el.dataset.index = index; el.dataset.oid = it.oid || '';
  const p = state.itemPos[index] || { x: PAD, y: PAD };
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';

  const cached = state.thumbCache.get(it.id);
  if (cached) {
    const img = document.createElement('img');
    img.draggable = false;
    img.src = fileUrl.pathToFileURL(cached).href;
    el.appendChild(img);
  } else {
    const ph = document.createElement('div'); ph.className = 'placeholder';
    ph.innerHTML = `<div class="ext">${escapeHtml(it.ext || '')}</div><div class="fname">${escapeHtml(it.name)}</div>`;
    el.appendChild(ph);
    scheduleThumbFlush();
  }
  const ck = document.createElement('div'); ck.className = 'check'; ck.textContent = '✓'; el.appendChild(ck);
  if (it.kind === 'video') { const b = document.createElement('div'); b.className = 'badge'; b.textContent = '▶ 视频'; el.appendChild(b); }
  const cap = document.createElement('div'); cap.className = 'caption'; cap.textContent = it.name; el.appendChild(cap);
  // Magnifier: hover it for a large preview; click it to open the full viewer.
  const zoom = document.createElement('div'); zoom.className = 'zoom'; zoom.textContent = '🔍';
  zoom.onmouseenter = () => hoverShow(index);
  zoom.onmouseleave = hoverHide;
  zoom.onclick = (e) => { e.stopPropagation(); hoverHide(); openViewer(index); };
  el.appendChild(zoom);

  el.onclick = (e) => onTileClick(index, e);
  el.oncontextmenu = (e) => onTileContext(index, e);
  el.ondblclick = () => openViewer(index);
  el.draggable = true;
  el.addEventListener('dragstart', (e) => onTileDragStart(index, e));
  return el;
}

// ---------------------------------------------------------------
// Hover preview (Eagle-style, bottom-right). Thumbnail instantly, then the
// sharp preview after a short dwell (cached, so re-hovers are instant).
// ---------------------------------------------------------------
let hoverTimer = null, hoverIndex = -1;
function hoverShow(index) {
  hoverIndex = index;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => doHover(index), 180);
}
function hoverHide() { clearTimeout(hoverTimer); hoverIndex = -1; $('hoverPreview').style.display = 'none'; }
function doHover(index) {
  if (hoverIndex !== index || state.viewerIndex >= 0) return;
  const it = state.view[index]; if (!it) return;
  const box = $('hoverPreview'), img = $('hoverImg');
  $('hoverName').textContent = it.name + (it.kind === 'video' ? '（视频）' : '');
  const thumb = state.thumbCache.get(it.id);
  if (thumb) { img.src = fileUrl.pathToFileURL(thumb).href; }
  box.style.display = '';
  if (it.kind === 'video') return;
  const setBig = (path) => { const bi = new Image(); bi.onload = () => { if (hoverIndex === index) img.src = bi.src; }; bi.src = fileUrl.pathToFileURL(path).href; };
  const cached = state.previewCache.get(it.id);
  if (cached) { setBig(cached); return; }
  if (state._hoverFetching) return;   // one hover fetch at a time (avoid device pile-up)
  state._hoverFetching = true;
  queuedPreview(pick(it))
    .then((r) => { if (r.ok && r.path) { state.previewCache.set(it.id, r.path); if (r.date) it._date = fmtDate(r.date); if (hoverIndex === index) setBig(r.path); } })
    .catch(() => {}).then(() => { state._hoverFetching = false; });
}

// ---------------------------------------------------------------
// Lazy thumbnails (WPD). Each batch is built from the tiles that are ON SCREEN
// RIGHT NOW — so a fast scroll to the bottom loads what you're looking at, not
// the photos you scrolled past. Loaded thumbs are cached, so scroll-back is
// instant.
// ---------------------------------------------------------------
const THUMB_BATCH = 24;
const thumbFailed = new Set();
let flushTimer = null;
function scheduleThumbFlush() { if (!flushTimer) flushTimer = setTimeout(flushThumbs, 60); }
async function flushThumbs() {
  flushTimer = null;
  if (state.thumbBusy) { scheduleThumbFlush(); return; }
  // Collect currently-rendered tiles (top-to-bottom) that still need a thumbnail.
  const pending = [];
  const entries = Array.from(state.renderedTiles.entries()).sort((a, b) => a[0] - b[0]);
  for (const [idx, el] of entries) {
    const id = el.dataset.id;
    if (state.thumbCache.has(id) || state.thumbReq.has(id) || thumbFailed.has(id)) continue;
    if (!el.querySelector('.placeholder')) continue;
    // oid comes from the item (robust); dataset.oid is a fallback. A missing oid
    // makes the backend skip the item, so never send an empty one.
    const it = state.view[idx];
    const oid = (it && it.oid) || el.dataset.oid;
    if (!oid) continue;
    pending.push({ id, oid });
    if (pending.length >= THUMB_BATCH) break;
  }
  if (pending.length === 0) return;
  state.thumbBusy = true;
  pending.forEach((x) => state.thumbReq.add(x.id));
  try {
    const res = await deviceOp(() => backend.thumbs(state.device, pending, state.thumbDir, 256));
    (res.results || []).forEach((r) => {
      state.thumbReq.delete(r.id);
      if (r.thumb) { state.thumbCache.set(r.id, r.thumb); applyThumb(r.id, r.thumb); }
      else thumbFailed.add(r.id);   // don't retry forever
    });
  } catch (_) {
    pending.forEach((x) => state.thumbReq.delete(x.id));
  } finally {
    state.thumbBusy = false;
    scheduleThumbFlush(); // keep going while visible tiles still need thumbs
  }
}
function applyThumb(id, path) {
  state.renderedTiles.forEach((el) => {
    if (el.dataset.id === id) {
      const ph = el.querySelector('.placeholder');
      if (ph) { const img = document.createElement('img'); img.draggable = false; img.src = fileUrl.pathToFileURL(path).href; img.onload = () => { if (ph.parentNode) ph.replaceWith(img); }; }
    }
  });
}

// ---------------------------------------------------------------
// Selection
// ---------------------------------------------------------------
// Left-click: just focus this one for viewing (does NOT check/select it).
function onTileClick(index, e) {
  const it = state.view[index]; if (!it) return;
  state.focused = it.id;
  state.lastClickedIndex = index;
  syncTileSelection();
}
// Right-click: toggle batch selection (the checkmark; used for import/delete/backup).
// Shift + right-click selects a range.
function onTileContext(index, e) {
  e.preventDefault();
  const it = state.view[index]; if (!it) return;
  if (e.shiftKey && state.lastClickedIndex !== null) {
    const [a, b] = [state.lastClickedIndex, index].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) state.selected.add(state.view[i].id);
  } else {
    if (state.selected.has(it.id)) state.selected.delete(it.id); else state.selected.add(it.id);
  }
  state.lastClickedIndex = index;
  syncTileSelection(); updateSelectionUI();
}
function toggleSelectAll(checked) {
  if (checked) state.view.forEach((it) => state.selected.add(it.id));
  else state.view.forEach((it) => state.selected.delete(it.id));
  syncTileSelection(); updateSelectionUI();
}
function syncTileSelection() {
  state.renderedTiles.forEach((el) => {
    el.classList.toggle('selected', state.selected.has(el.dataset.id));
    el.classList.toggle('focused', state.focused === el.dataset.id);
  });
}
function updateSelectionUI() {
  const n = state.selected.size;
  $('selCount').textContent = `已选 ${n} 项`;
  $('importBtn').disabled = n === 0; $('deleteBtn').disabled = n === 0;
  $('selectAll').checked = state.view.length > 0 && state.view.every((it) => state.selected.has(it.id));
}
function selectedItems() { return state.view.filter((it) => state.selected.has(it.id)).map(pick); }
function pick(it) { return { id: it.id, oid: it.oid, name: it.name }; }

// ---------------------------------------------------------------
// "Already imported" memory (per device) for 仅导入新增
// ---------------------------------------------------------------
function importedStorePath(device) {
  const dir = nodePath.join(nodeOs.homedir(), '.eagle-iphone-sync');
  try { nodeFs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return nodePath.join(dir, 'imported_' + String(device || 'device').replace(/[^\w.-]+/g, '_') + '.json');
}
function loadImported(device) { try { return new Set(JSON.parse(nodeFs.readFileSync(importedStorePath(device), 'utf8'))); } catch (_) { return new Set(); } }
function saveImported(device, set) { try { nodeFs.writeFileSync(importedStorePath(device), JSON.stringify(Array.from(set))); } catch (_) {} }
function markImported(id) { const s = loadImported(state.device); s.add(id); saveImported(state.device, s); }
async function ensureListed() { if (state.items.length) return true; await loadPhotos(); return state.items.length > 0; }

// ---------------------------------------------------------------
// Import to Eagle
// ---------------------------------------------------------------
async function importItems(items, { offerDelete = false, folderId = '' } = {}) {
  if (!items || items.length === 0) { setStatus('没有需要导入的照片'); return { imported: 0, failed: 0 }; }
  const tempDir = nodePath.join(backend.cacheBase(), 'import_' + Date.now());
  nodeFs.mkdirSync(tempDir, { recursive: true });
  const importedSet = loadImported(state.device);
  const okIds = [];
  setBusy(true); showProgress(0);
  let imported = 0, failed = 0; const batchSize = 12;
  try {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      setStatus(`正在导入 ${i + 1}–${Math.min(i + batch.length, items.length)} / ${items.length}…`);
      const res = await deviceOp(() => backend.copy(state.device, batch, tempDir));
      for (const r of (res.results || [])) {
        if (r.ok && r.path) {
          try {
            await eagle.item.addFromPath(r.path, {
              name: stripExt(r.name || nodePath.basename(r.path)),
              tags: [SYNC_TAG], folders: folderId ? [folderId] : [], annotation: `来自手机「${state.device}」：` + r.id,
            });
            imported++; importedSet.add(r.id); okIds.push(r.id);
          } catch (e) { failed++; }
          try { nodeFs.unlinkSync(r.path); } catch (_) {}
        } else failed++;
      }
      saveImported(state.device, importedSet);
      showProgress(Math.round(((i + batch.length) / items.length) * 100));
    }
  } finally { try { nodeFs.rmdirSync(tempDir, { recursive: true }); } catch (_) {} hideProgress(); setBusy(false); }
  setStatus(`导入完成：成功 ${imported}${failed ? `，失败 ${failed}` : ''}`);
  if (offerDelete && okIds.length > 0) {
    const resp = await showConfirm({
      title: '导入完成', message: `已成功导入 ${okIds.length} 张到 Eagle。`,
      detail: '是否从手机删除这些已导入的照片以释放空间？此操作不可撤销。', buttons: ['保留在手机', '从手机删除'], danger: true,
    });
    if (resp === 1) await removeItems(state.items.filter((it) => okIds.includes(it.id)).map(pick), true);
  }
  return { imported, failed };
}

async function doImport() { const items = selectedItems(); if (items.length) await importItems(items, { offerDelete: true }); }

async function doImportAll() {
  if (!state.device) { setStatus('未检测到设备', true); return; }
  if (!(await ensureListed())) return;
  const items = state.view.map(pick);
  const resp = await showConfirm({
    title: '导入全部', message: `将把设备上全部 ${items.length} 张照片/视频导入 Eagle。`,
    detail: '数量大时会花些时间（受 USB 速度限制）。期间请保持手机解锁、不要拔线。', buttons: ['取消', '开始导入'],
  });
  if (resp === 1) await importItems(items, { offerDelete: false });
}

async function doImportNew() {
  if (!state.device) { setStatus('未检测到设备', true); return; }
  if (!(await ensureListed())) return;
  const done = loadImported(state.device);
  const items = state.view.filter((it) => !done.has(it.id)).map(pick);
  if (items.length === 0) {
    await showInfo('没有新增', '没有发现新增照片。', '当前设备上的照片都已经导入过了。');
    setStatus('没有新增照片'); return;
  }
  const resp = await showConfirm({
    title: '导入新增', message: `发现 ${items.length} 张未导入的新照片（设备共 ${state.view.length} 张）。`,
    detail: '将把这些新照片导入 Eagle。期间请保持手机解锁、不要拔线。', buttons: ['取消', '开始导入'],
  });
  if (resp === 1) await importItems(items, { offerDelete: false });
}

// ---------------------------------------------------------------
// Backup to a folder
// ---------------------------------------------------------------
async function doBackup() {
  const items = selectedItems(); if (items.length === 0) return;
  const dlg = await eagle.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (dlg.canceled || !dlg.filePaths || !dlg.filePaths.length) return;
  const dest = dlg.filePaths[0];
  setBusy(true); showProgress(0);
  let ok = 0, failed = 0; const batchSize = 12;
  try {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      setStatus(`正在备份 ${i + 1}–${Math.min(i + batch.length, items.length)} / ${items.length}…`);
      const res = await deviceOp(() => backend.copy(state.device, batch, dest));
      for (const r of (res.results || [])) { if (r.ok) ok++; else failed++; }
      showProgress(Math.round(((i + batch.length) / items.length) * 100));
    }
  } finally { hideProgress(); setBusy(false); }
  setStatus(`备份完成：成功 ${ok}${failed ? `，失败 ${failed}` : ''} → ${dest}`);
  await showInfo('备份完成', `已备份 ${ok} 个文件到：`, dest);
}

// ---------------------------------------------------------------
// Delete from phone
// ---------------------------------------------------------------
async function doDelete() { const items = selectedItems(); if (items.length) await removeItems(items, false); }

async function removeItems(items, confirmed) {
  if (!items.length) return;
  if (!confirmed) {
    const resp = await showConfirm({
      title: '确认删除', message: `确定要从手机删除选中的 ${items.length} 张照片/视频吗？`,
      detail: '此操作会直接从手机相机胶卷删除，且不可撤销。建议先备份或导入。', buttons: ['取消', '删除'], danger: true,
    });
    if (resp !== 1) return;
  }
  setBusy(true); showProgress(null); setStatus(`正在从手机删除 ${items.length} 项…`);
  let ok = 0, failed = 0; let firstErr = '';
  try {
    const res = await deviceOp(() => backend.remove(state.device, items));
    for (const r of (res.results || [])) {
      if (r.ok) { ok++; removeItemFromState(r.id); }
      else { failed++; if (!firstErr && r.error) firstErr = r.error; }
    }
  } catch (e) { setStatus('删除出错：' + e.message, true); }
  finally { hideProgress(); setBusy(false); }
  state.selected.clear(); applyView();
  setStatus(`删除完成：成功 ${ok}${failed ? `，失败 ${failed}` : ''}`);
  if (failed > 0) {
    await showInfo('部分删除失败', `${failed} 个文件删除失败。`,
      (firstErr ? ('原因：' + firstErr + '\n') : '') + '可重试，或在手机上手动删除。');
  }
}
function removeItemFromState(id) {
  const i = state.items.findIndex((x) => x.id === id); if (i >= 0) state.items.splice(i, 1);
  state.selected.delete(id);
}

// ---------------------------------------------------------------
// Viewer (lightbox)
// ---------------------------------------------------------------
async function openViewer(index) {
  if (index < 0 || index >= state.view.length) return;
  state.viewerIndex = index;
  $('viewer').style.display = '';
  document.addEventListener('keydown', viewerKey);
  await loadPreview(index);
  preload(index + 1); preload(index - 1);
}
function closeViewer() {
  $('viewer').style.display = 'none'; state.viewerIndex = -1;
  document.removeEventListener('keydown', viewerKey);
  $('viewerImg').style.display = 'none'; $('viewerImg').src = '';
  const v = $('viewerVideo'); try { v.pause(); } catch (_) {} v.removeAttribute('src'); v.style.display = 'none';
}
function viewerKey(e) {
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') viewerNav(-1);
  else if (e.key === 'ArrowRight') viewerNav(1);
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); viewerDelete(); }
}
function viewerNav(d) { const n = state.viewerIndex + d; if (n >= 0 && n < state.view.length) openViewer(n); }

function fmtDate(raw) {
  const m = /(\d{4})\/(\d{2})\/(\d{2})[:\s]+(\d{2}):(\d{2})/.exec(raw || '');
  return m ? `${m[1]}年${+m[2]}月${+m[3]}日 ${m[4]}:${m[5]}` : (raw || '');
}
function setViewerTitle(index) {
  const it = state.view[index]; if (!it) return;
  $('viewerTitle').textContent = it.name + (it._date ? '　·　' + it._date : '');
}

// Serialize ALL device operations (thumbnails, previews, copies, deletes) through
// one queue — concurrent WPD operations step on each other and can hang, which is
// what left thumbnails stuck after re-sorting/hovering.
let deviceChain = Promise.resolve();
function deviceOp(fn) {
  const p = deviceChain.then(fn, fn);
  deviceChain = p.catch(() => {});
  return p;
}
function queuedPreview(item) { return deviceOp(() => backend.preview(state.device, item, state.previewDir)); }

// --- Drag-to-Eagle: hand Eagle the ORIGINAL file, not the thumbnail. ---
const dragCache = new Map();  // id -> local original path
async function transferOriginalsForDrag(items) {
  const dir = nodePath.join(backend.cacheBase(), 'drag');
  try { nodeFs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const paths = [], toFetch = [];
  for (const it of items) {
    const c = dragCache.get(it.id);
    if (c && nodeFs.existsSync(c)) paths.push(c); else toFetch.push(it);
  }
  if (toFetch.length) {
    const res = await deviceOp(() => backend.copy(state.device, toFetch.map(pick), dir));
    for (const r of (res.results || [])) if (r.ok && r.path) { dragCache.set(r.id, r.path); paths.push(r.path); }
  }
  return paths;
}
async function onTileDragStart(index, e) {
  e.preventDefault();  // block the default thumbnail-image drag
  if (!(typeof eagle !== 'undefined' && eagle.drag && eagle.drag.startDrag)) return;
  const it = state.view[index]; if (!it) return;
  const items = state.selected.has(it.id) && state.selected.size > 0 ? selectedItems() : [pick(it)];
  setStatus(items.length > 1 ? `正在准备 ${items.length} 张原图…拖住不放` : '正在准备原图…拖住不放');
  try {
    const paths = await transferOriginalsForDrag(items);
    if (paths.length) { setStatus(`拖拽 ${paths.length} 个原图到 Eagle`); await eagle.drag.startDrag(paths); }
    else setStatus('原图准备失败（iPhone 可能在 iCloud 未下载到本机；或文件已被移动）', true);
  } catch (err) { setStatus('准备原图出错：' + (err && err.message), true); }
}

async function loadPreview(index) {
  const it = state.view[index]; if (!it) return;
  const img = $('viewerImg'), vid = $('viewerVideo'), msg = $('viewerMsg');
  $('viewerCounter').textContent = (index + 1) + ' / ' + state.view.length;
  setViewerTitle(index);
  vResetZoom();
  try { vid.pause(); } catch (_) {} vid.removeAttribute('src'); vid.style.display = 'none';

  if (it.kind === 'video') {
    img.style.display = 'none';
    const vthumb = state.thumbCache.get(it.id);
    if (vthumb) vid.poster = fileUrl.pathToFileURL(vthumb).href; else vid.removeAttribute('poster');
    msg.textContent = '正在加载视频…（视频较大，可能需要几秒）';
    try {
      let path = state.previewCache.get(it.id);
      if (!path) {
        const r = await queuedPreview(pick(it));
        if (r.ok && r.path) { path = r.path; state.previewCache.set(it.id, path); if (r.date) { it._date = fmtDate(r.date); if (state.viewerIndex === index) setViewerTitle(index); } }
        else { if (state.viewerIndex === index) msg.textContent = '无法加载视频：' + (r.error || '未知错误'); return; }
      }
      if (state.viewerIndex !== index) return;
      vid.onerror = () => { if (state.viewerIndex === index) msg.textContent = '此视频浏览器无法直接播放。可先“添加到 Eagle”，再用系统播放器打开。'; };
      vid.onloadeddata = () => {
        if (state.viewerIndex !== index) return;
        msg.textContent = (vid.videoWidth === 0)
          ? '此视频为 HEVC 编码，浏览器只能出声音、显示不了画面（已显示封面帧）。可“添加到 Eagle”后用系统播放器观看。'
          : '';
      };
      vid.src = fileUrl.pathToFileURL(path).href;
      vid.style.display = 'block';
      if (vid.play) vid.play().catch(() => {});
    } catch (e) { if (state.viewerIndex === index) msg.textContent = '加载出错：' + e.message; }
    return;
  }

  // image: show cached thumbnail instantly, then swap in the sharp preview.
  const thumb = state.thumbCache.get(it.id);
  if (thumb) { img.src = fileUrl.pathToFileURL(thumb).href; img.style.display = 'block'; }
  else { img.style.display = 'none'; }
  msg.textContent = thumb ? '正在加载高清大图…' : '正在加载大图…';
  try {
    let path = state.previewCache.get(it.id);
    if (!path) {
      const r = await queuedPreview(pick(it));
      if (r.ok && r.path) {
        path = r.path; state.previewCache.set(it.id, path);
        if (r.date) { it._date = fmtDate(r.date); if (state.viewerIndex === index) setViewerTitle(index); }
      } else { if (state.viewerIndex === index && !thumb) msg.textContent = '无法加载大图：' + (r.error || '未知错误'); return; }
    }
    if (state.viewerIndex !== index) return;   // user navigated away
    const big = new Image();
    big.onload = () => { if (state.viewerIndex === index) { img.src = big.src; img.style.display = 'block'; msg.textContent = ''; } };
    big.onerror = () => { if (state.viewerIndex === index && !thumb) msg.textContent = '大图加载失败'; };
    big.src = fileUrl.pathToFileURL(path).href;
  } catch (e) { if (state.viewerIndex === index && !thumb) msg.textContent = '加载出错：' + e.message; }
}
function preload(index) {
  if (index < 0 || index >= state.view.length) return;
  const it = state.view[index];
  if (it.kind === 'video' || state.previewCache.has(it.id)) return;
  queuedPreview(pick(it)).then((r) => { if (r.ok && r.path) { state.previewCache.set(it.id, r.path); if (r.date) it._date = fmtDate(r.date); } }).catch(() => {});
}

async function viewerAdd() {
  const it = state.view[state.viewerIndex]; if (!it) return;
  $('viewerAdd').disabled = true;
  try {
    const tempDir = nodePath.join(backend.cacheBase(), 'one_' + Date.now());
    nodeFs.mkdirSync(tempDir, { recursive: true });
    const res = await deviceOp(() => backend.copy(state.device, [pick(it)], tempDir));
    const r = res.results && res.results[0];
    if (r && r.ok && r.path) {
      // Import to the library root (unclassified); the user files it by dragging.
      await eagle.item.addFromPath(r.path, { name: stripExt(it.name), tags: [SYNC_TAG], folders: [], annotation: `来自手机「${state.device}」：` + it.id });
      markImported(it.id);
      try { nodeFs.unlinkSync(r.path); } catch (_) {}
      viewerToast('已添加到 Eagle（未分类）');
    } else viewerToast('添加失败：' + ((r && r.error) || ''));
    try { nodeFs.rmdirSync(tempDir, { recursive: true }); } catch (_) {}
  } catch (e) { viewerToast('添加出错：' + e.message); }
  finally { $('viewerAdd').disabled = false; }
}

async function viewerDelete() {
  const it = state.view[state.viewerIndex]; if (!it) return;
  const resp = await showConfirm({
    title: '从手机删除', message: '确定从手机删除这张照片吗？',
    detail: it.name + '\n删除后无法恢复，会释放手机空间。', buttons: ['取消', '删除'], danger: true,
  });
  if (resp !== 1) return;
  $('viewerDelete').disabled = true;
  try {
    const res = await deviceOp(() => backend.remove(state.device, [pick(it)]));
    const r0 = res.results && res.results[0];
    if (r0 && r0.ok) {
      const idx = state.viewerIndex;
      removeItemFromState(it.id); applyView();
      if (state.view.length === 0) { closeViewer(); return; }
      openViewer(Math.min(idx, state.view.length - 1));
      viewerToast('已从手机删除');
    } else viewerToast('删除失败' + (r0 && r0.error ? '：' + r0.error : ''));
  } catch (e) { viewerToast('删除出错：' + e.message); }
  finally { $('viewerDelete').disabled = false; }
}

let toastTimer = null;
function viewerToast(text) {
  let t = $('viewerToast');
  if (!t) { t = document.createElement('div'); t.id = 'viewerToast'; t.className = 'viewer-toast'; $('viewer').appendChild(t); }
  t.textContent = text; t.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
}

// Viewer zoom (mouse wheel, cursor-centered) + pan (drag when zoomed) +
// swipe navigation (drag when not zoomed) + double-click to toggle zoom.
let vZoom = 1, vPanX = 0, vPanY = 0;
function vApplyTransform() {
  const t = `translate(${vPanX}px, ${vPanY}px) scale(${vZoom})`;
  $('viewerImg').style.transform = t; $('viewerVideo').style.transform = t;
}
function vResetZoom() { vZoom = 1; vPanX = 0; vPanY = 0; vApplyTransform(); }

function wireViewerZoom() {
  const stage = $('viewerStage');
  stage.addEventListener('wheel', (e) => {
    if (state.viewerIndex < 0) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nz = Math.max(1, Math.min(8, vZoom * f));
    const ratio = nz / vZoom;
    if (nz <= 1) { vPanX = 0; vPanY = 0; }
    else { vPanX = cx - (cx - vPanX) * ratio; vPanY = cy - (cy - vPanY) * ratio; }
    vZoom = nz; vApplyTransform();
  }, { passive: false });

  stage.addEventListener('dblclick', (e) => {
    if (state.viewerIndex < 0) return;
    if (vZoom > 1) vResetZoom();
    else {
      const rect = stage.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2, cy = e.clientY - rect.top - rect.height / 2;
      vZoom = 2.5; vPanX = -cx * (vZoom - 1); vPanY = -cy * (vZoom - 1); vApplyTransform();
    }
  });

  let down = false, sx = 0, sy = 0, startX = 0;
  const onDown = (x, y) => { down = true; sx = x; sy = y; startX = x; };
  const onMove = (x, y) => { if (down && vZoom > 1) { vPanX += x - sx; vPanY += y - sy; sx = x; sy = y; vApplyTransform(); } };
  const onUp = (x) => { if (!down) return; down = false; if (vZoom <= 1) { const dx = x - startX; if (Math.abs(dx) > 60) viewerNav(dx < 0 ? 1 : -1); } };
  stage.addEventListener('mousedown', (e) => { e.preventDefault(); onDown(e.clientX, e.clientY); });
  stage.addEventListener('dragstart', (e) => e.preventDefault());   // kill native image drag
  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', (e) => onUp(e.clientX));
  stage.addEventListener('touchstart', (e) => onDown(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  stage.addEventListener('touchmove', (e) => { if (vZoom > 1) e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  stage.addEventListener('touchend', (e) => onUp((e.changedTouches[0] || {}).clientX || 0), { passive: true });
}

// ---------------------------------------------------------------
// Custom modal (replaces native eagle.dialog.showMessageBox — no Windows sound,
// matches the plugin theme). Returns the clicked button index (0-based).
// ---------------------------------------------------------------
function showConfirm(opts) {
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    const box = document.createElement('div'); box.className = 'modal-box';
    let html = `<div class="modal-title">${escapeHtml(opts.title || '')}</div>`;
    if (opts.message) html += `<div class="modal-msg">${escapeHtml(opts.message)}</div>`;
    if (opts.detail) html += `<div class="modal-detail">${escapeHtml(opts.detail)}</div>`;
    html += `<div class="modal-btns"></div>`;
    box.innerHTML = html;
    const btns = opts.buttons || ['确定'];
    const wrap = box.querySelector('.modal-btns');
    let closed = false;
    const done = (i) => { if (closed) return; closed = true; document.removeEventListener('keydown', onkey); ov.remove(); resolve(i); };
    btns.forEach((label, i) => {
      const b = document.createElement('button');
      const primary = i === btns.length - 1;
      b.className = 'btn' + (primary ? (opts.danger ? ' btn-danger' : ' btn-primary') : '');
      b.textContent = label; b.onclick = () => done(i); wrap.appendChild(b);
    });
    const onkey = (e) => { if (e.key === 'Escape') done(opts.cancelId != null ? opts.cancelId : 0); };
    document.addEventListener('keydown', onkey);
    ov.addEventListener('click', (e) => { if (e.target === ov) done(opts.cancelId != null ? opts.cancelId : 0); });
    ov.appendChild(box); document.body.appendChild(ov);
    (wrap.lastChild || box).focus && wrap.lastChild.focus();
  });
}
function showInfo(title, message, detail) { return showConfirm({ title, message, detail, buttons: ['好'] }); }

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------
function showEmpty(text) {
  const p = document.querySelector('#emptyState p'); if (p) p.textContent = text;
  $('emptyState').style.display = state.view && state.view.length ? 'none' : '';
}
function setStatus(text, isError) { const el = $('status'); el.textContent = text; el.style.color = isError ? 'var(--danger)' : 'var(--text-dim)'; }
function setBusy(b) {
  ['refreshBtn', 'importBtn', 'deleteBtn', 'deviceSelect', 'selectAll']
    .forEach((id) => { if ($(id)) $(id).disabled = b; });
  if (!b) updateSelectionUI();
}
function showProgress(v) { const p = $('progress'); p.style.display = ''; if (v === null || v === undefined) p.removeAttribute('value'); else p.value = v; }
function hideProgress() { $('progress').style.display = 'none'; }
function stripExt(name) { return String(name).replace(/\.[^.]+$/, ''); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
