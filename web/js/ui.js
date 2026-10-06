// DOM side of the app: toolbar, catalogue (with drag-and-drop), properties panel, dialogs.
// Everything user-controlled (names, project titles) is inserted with textContent only.
import { h, fmtLen, fmtArea, polygonArea, clamp, dist } from './util.js';
import { CATALOG, CATEGORIES, lookupItem, customItems, registerCustomItem, unregisterCustomItem, EDITABLE_PART_KINDS, templateFromParts, MESH_MAX_GRID } from './catalog.js';
import { wallLength, wallInnerLength, floorInnerArea } from './model.js';
import { savePrefs } from './storage.js';
import { renderThumbnails } from './thumbs.js';
import { BlockSession, MAX_PARTS, resizeMeshGrid, flattenMesh } from './blockbuilder.js';
import { BlockView } from './blockeditor-view.js';
import { BlockInteract } from './blockeditor-interact.js';

const $ = (id) => document.getElementById(id);
const SWATCHES = ['#e4e0d8', '#c9b79c', '#a67c5b', '#7f9bb8', '#6f7f91', '#9bb38a', '#b07a4f', '#3c4650', '#c0504d', '#e5b25d'];
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const num1 = (v) => String(Math.round(v * 10) / 10);
const PART_LABEL = Object.fromEntries(EDITABLE_PART_KINDS.map((k) => [k.k, k.label]));

export class UI {
  constructor({ store, view, interact, storage, prefs }) {
    Object.assign(this, { store, view, interact, storage, prefs });
    this.refreshers = [];
    this.thumbs = new Map(); // catalogue id -> <img>
    this.customThumbs = new Map();
    this._toastTimer = 0;
    this.initToolbar();
    this.initCustomSection();
    this.initCatalog();
    this.initDialogs();
    store.on((k) => {
      if (k === 'select' || k === 'reset') this.renderProps();
      if (k === 'doc') this.onDoc();
    });
    interact.on((k, v) => {
      if (k === 'tool') this.markTool(v);
      else if (k === 'hint') $('hint').textContent = v;
      else if (k === 'toast') this.toast(v);
      else if (k === 'save') this.save();
    });
    view.on((k) => k === 'mode' && this.markMode());
    storage.on(() => this.updateSaveState());
    this.markTool('select');
    $('hint').textContent = interact.hint || '';
    this.markMode();
    this.renderProps();
    this.onDoc();
    this.updateSaveState();
    (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(() => renderThumbnails(CATALOG, (id, url) => this.thumbs.get(id) && (this.thumbs.get(id).src = url)));
  }

  // ------------------------------------------------------------------------------
  toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show ' + kind;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (t.className = ''), kind === 'err' ? 6000 : 2600);
  }

  // ---------- generic right-click context menu ---------------------------------------
  closeContextMenu() {
    if (!this._ctxMenu) return;
    this._ctxMenu.remove();
    this._ctxMenu = null;
    document.removeEventListener('pointerdown', this._ctxOutside, true);
    document.removeEventListener('keydown', this._ctxEsc, true);
    document.removeEventListener('contextmenu', this._ctxOutside, true);
  }

  /** `items`: [{label, onClick}]. Closes on Escape, an outside click, or another right-click.
   * Position is set via the CSSOM (`el.style.prop = …`), never a `style="…"` string/attribute —
   * the app's CSP is `style-src 'self'` (no `unsafe-inline`), which silently drops inline-style
   * *attributes* but does not affect script-driven CSSOM writes. */
  showContextMenu(x, y, items) {
    this.closeContextMenu();
    const menu = h('div', { class: 'menu-pop ctxmenu' },
      ...items.map((it) => h('button', { type: 'button', text: it.label, on: { click: () => { this.closeContextMenu(); it.onClick(); } } })));
    menu.style.position = 'fixed';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.append(menu);
    this._ctxMenu = menu;
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = Math.max(4, innerWidth - r.width - 4) + 'px';
    if (r.bottom > innerHeight) menu.style.top = Math.max(4, innerHeight - r.height - 4) + 'px';
    this._ctxOutside = (e) => { if (!menu.contains(e.target)) this.closeContextMenu(); };
    this._ctxEsc = (e) => { if (e.key === 'Escape') this.closeContextMenu(); };
    // deferred so the very pointerdown/contextmenu that opened the menu doesn't also close it
    setTimeout(() => {
      document.addEventListener('pointerdown', this._ctxOutside, true);
      document.addEventListener('contextmenu', this._ctxOutside, true);
      document.addEventListener('keydown', this._ctxEsc, true);
    }, 0);
  }

  onDoc() {
    $('btnUndo').disabled = !this.store.canUndo;
    $('btnRedo').disabled = !this.store.canRedo;
    const d = this.store.doc;
    $('empty').hidden = !!(d.walls.length || d.floors.length || d.items.length);
    this.refreshers.forEach((fn) => fn());
  }

  // ---------- toolbar ---------------------------------------------------------------
  initToolbar() {
    const { store, view, interact, storage, prefs } = this;
    const name = $('projName');
    name.addEventListener('change', () => storage.rename(name.value));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());

    document.querySelectorAll('#toolSeg [data-tool]').forEach((b) => b.addEventListener('click', () => interact.setTool(b.dataset.tool)));
    document.querySelectorAll('#modeSeg [data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        prefs.mode = b.dataset.mode;
        savePrefs(prefs);
        view.setMode(prefs.mode);
      })
    );
    $('btnUndo').addEventListener('click', () => store.undo());
    $('btnRedo').addEventListener('click', () => store.redo());
    $('btnFit').addEventListener('click', () => view.fit());
    $('btnSave').addEventListener('click', () => this.save());

    const wm = $('wallMode');
    wm.value = prefs.wallMode;
    wm.addEventListener('change', () => {
      prefs.wallMode = wm.value;
      savePrefs(prefs);
      view._applyWallMode();
      view.syncOverlay();
    });
    const snap = $('optSnap'), grid = $('optGrid'), dims = $('optDims'), sh = $('optShadows');
    snap.checked = prefs.snap;
    grid.value = String(prefs.grid);
    dims.checked = prefs.dims;
    sh.checked = prefs.shadows;
    snap.addEventListener('change', () => { prefs.snap = snap.checked; savePrefs(prefs); });
    grid.addEventListener('change', () => { prefs.grid = Number(grid.value); savePrefs(prefs); });
    dims.addEventListener('change', () => { prefs.dims = dims.checked; savePrefs(prefs); view.requestRender(); });
    sh.addEventListener('change', () => { prefs.shadows = sh.checked; savePrefs(prefs); view.applyPrefs(); });

    // file menu
    const menu = $('fileMenu');
    document.addEventListener('pointerdown', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    menu.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        menu.open = false;
        this.fileAction(b.dataset.act);
      })
    );
    $('fileInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const rep = await storage.importJSON(f);
        view.fit();
        this.toast(rep.droppedItems ? `Đã nhập (bỏ qua ${rep.droppedItems} đồ vật không nhận ra)` : 'Đã nhập file');
      } catch (err) {
        this.toast(err.message, 'err');
      }
    });

    $('btnLeft').addEventListener('click', () => document.body.classList.toggle('show-left'));
    $('btnRight').addEventListener('click', () => document.body.classList.toggle('show-right'));
    $('emptyRoom').addEventListener('click', () => this.openRoomDialog());
    $('emptyDraw').addEventListener('click', () => interact.setTool('draw-room'));
  }

  markTool(tool) {
    document.querySelectorAll('#toolSeg [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    document.body.classList.remove('show-left');
  }

  markMode() {
    document.querySelectorAll('#modeSeg [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.view.mode));
  }

  updateSaveState() {
    const p = this.storage.project;
    const pill = $('saveState');
    if ($('projName').value !== p.name && document.activeElement !== $('projName')) $('projName').value = p.name;
    document.title = `${p.name} · Room Planner`;
    if (!p.id) {
      pill.textContent = 'Chưa lưu lên máy chủ';
      pill.className = 'pill warn';
    } else if (p.dirty) {
      pill.textContent = '● Thay đổi chưa lưu';
      pill.className = 'pill warn';
    } else {
      const t = p.savedAt ? new Date(p.savedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
      pill.textContent = `✓ Đã lưu ${t}`;
      pill.className = 'pill ok';
    }
    pill.title = p.id ? `ID: ${p.id} · rev ${p.rev ?? '-'}` : 'Bấm Lưu để lưu dự án lên máy chủ (OMV).';
  }

  async fileAction(act) {
    const { storage, view } = this;
    if (act === 'new') {
      if (storage.project.dirty && !confirm('Dự án hiện tại có thay đổi chưa lưu lên máy chủ. Vẫn tạo dự án mới?')) return;
      storage.newProject();
      view.fit();
    } else if (act === 'open') this.openProjects();
    else if (act === 'save') this.save();
    else if (act === 'export') {
      const { blob, filename } = storage.exportJSON();
      this.download(URL.createObjectURL(blob), filename);
    } else if (act === 'import') $('fileInput').click();
    else if (act === 'png') {
      const slug = storage.exportJSON().filename.replace('.room.json', '');
      this.download(view.screenshot(), `${slug}.png`);
    }
  }

  download(url, filename) {
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async save() {
    const { storage } = this;
    try {
      let r = await storage.saveServer(false);
      if (r.conflict) {
        const ok = confirm(`Bản trên máy chủ đã bị thay đổi ở nơi khác (rev ${r.rev}).\n\nOK = ghi đè bằng bản đang mở\nHuỷ = giữ nguyên, không lưu`);
        if (!ok) return;
        r = await storage.saveServer(true);
      }
      if (r.ok) this.toast('Đã lưu lên máy chủ');
    } catch (err) {
      this.toast(err.message + ' Dùng Tệp → Xuất file JSON để giữ bản sao.', 'err');
    }
  }

  // ---------- catalogue --------------------------------------------------------------
  initCatalog() {
    const root = $('catalog');
    const sections = [];
    for (const cat of CATEGORIES) {
      const grid = h('div', { class: 'cards' });
      const det = h('details', { open: true, class: 'cat' }, h('summary', { text: cat.name }), grid);
      const cards = [];
      for (const entry of CATALOG.filter((c) => c.cat === cat.id)) {
        const img = h('img', { class: 'thumb', alt: '', width: 60, height: 60 });
        this.thumbs.set(entry.id, img);
        const card = h('button', { class: 'card', type: 'button', title: `${entry.name} — ${entry.size.join(' × ')} cm` },
          img, h('span', { class: 'cname', text: entry.name }), h('span', { class: 'csize', text: entry.size.join('×') }));
        this.bindCard(card, entry, img);
        card._q = fold(entry.name + ' ' + entry.id);
        cards.push(card);
        grid.append(card);
      }
      sections.push({ det, cards });
      root.append(det);
    }
    $('catSearch').addEventListener('input', (e) => {
      const q = fold(e.target.value.trim());
      for (const s of sections) {
        let any = false;
        for (const c of s.cards) {
          const show = !q || c._q.includes(q);
          c.hidden = !show;
          any ||= show;
        }
        s.det.hidden = !any;
        if (q) s.det.open = true;
      }
    });
  }

  /** Drag a card into the viewport (mouse/pen) or tap it, then tap the floor (touch). */
  bindCard(card, entry, img) {
    let suppressClick = false;
    card.addEventListener('click', () => {
      if (suppressClick) return void (suppressClick = false);
      this.interact.beginPlace(entry);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY, [
        { label: 'Nhân bản để chỉnh sửa…', onClick: () => this.duplicateToCustom(entry) },
      ]);
    });
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      const sx = e.clientX, sy = e.clientY;
      let ghost = null;
      const move = (ev) => {
        if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
          ghost = h('div', { class: 'ghost' }, h('img', { src: img.src, alt: '' }));
          document.body.append(ghost);
          this.interact.palette = true;
          this.interact.beginPlace(entry);
        }
        if (ghost) {
          ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -60%)`;
          ghost.classList.toggle('hidden', this.interact.updatePlaceAt(ev.clientX, ev.clientY));
        }
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!ghost) return;
        suppressClick = true;
        ghost.remove();
        this.interact.palette = false;
        this.interact.dropPlace(ev.clientX, ev.clientY, ev.shiftKey);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // ---------- "Tự tạo" (user-made items) ------------------------------------------------------
  initCustomSection() {
    const grid = h('div', { class: 'cards' });
    const det = h('details', { open: true, class: 'cat' },
      h('summary', {},
        h('span', { text: 'Tự tạo' }),
        h('button', { type: 'button', class: 'mini addcustom', text: '+ Mới', on: { click: (e) => { e.preventDefault(); this.openBlockEditor(null); } } })),
      grid);
    $('catalog').prepend(det);
    this.customGrid = grid;
    this.renderCustomGrid();
  }

  renderCustomGrid() {
    this.customGrid.replaceChildren();
    const items = [...customItems.values()];
    if (!items.length) {
      this.customGrid.append(h('div', { class: 'muted small custom-empty', text: 'Chưa có đồ tự tạo. Bấm “+ Mới” để bắt đầu.' }));
      return;
    }
    for (const entry of items) {
      const img = h('img', { class: 'thumb', alt: '', width: 60, height: 60 });
      this.customThumbs.set(entry.id, img);
      const main = h('button', { class: 'cardmain', type: 'button', title: `${entry.name} — ${entry.size.map(Math.round).join(' × ')} cm` },
        img, h('span', { class: 'cname', text: entry.name }), h('span', { class: 'csize', text: entry.size.map(Math.round).join('×') }));
      this.bindCard(main, entry, img);
      const card = h('div', { class: 'card customcard' }, main,
        h('div', { class: 'cardops' },
          h('button', { type: 'button', class: 'iconbtn', title: 'Sửa', text: '✎', on: { click: () => this.openBlockEditor(entry.id) } }),
          h('button', { type: 'button', class: 'iconbtn', title: 'Xoá', text: '🗑', on: { click: () => this.deleteCustomItem(entry) } })));
      this.customGrid.append(card);
    }
    renderThumbnails(items, (id, url) => this.customThumbs.get(id) && (this.customThumbs.get(id).src = url));
  }

  async deleteCustomItem(entry) {
    if (!confirm(`Xoá “${entry.name}” khỏi thư viện?\n\nĐồ đã đặt trong phòng dùng mẫu này sẽ không hiển thị được nếu mở lại dự án sau khi xoá.`)) return;
    try {
      await this.storage.deleteCustomItem(entry.id);
      unregisterCustomItem(entry.id);
      this.renderCustomGrid();
      this.toast('Đã xoá khỏi thư viện');
    } catch (err) {
      this.toast(err.message, 'err');
    }
  }

  // ---------- block-builder dialog ("Tự tạo đồ vật") ------------------------------------------
  ensureBlockEditor() {
    if (this.blockSession) return;
    this.blockSession = new BlockSession();
    this.blockView = new BlockView($('blockViewport'), this.blockSession);
    this.blockInteract = new BlockInteract(this.blockView, this.blockSession);
    this.blockRefreshers = [];
    this.blockSession.on((reason) => {
      if (reason === 'select' || reason === 'structure') {
        this.renderBlockList();
        this.renderBlockRight();
      } else {
        this.blockRefreshers.forEach((fn) => fn());
      }
    });
    $('blockAdd').append(...EDITABLE_PART_KINDS.map(({ k, label }) =>
      h('button', { type: 'button', class: 'mini', text: `+ ${label}`, on: { click: () => {
        if (!this.blockSession.addPart(k)) this.toast(`Tối đa ${MAX_PARTS} khối mỗi món.`, 'err');
      } } })
    ));
    $('blockCancel').addEventListener('click', () => $('dlgBlock').close());
    $('blockClose').addEventListener('click', () => $('dlgBlock').close());
    $('blockSave').addEventListener('click', () => this.saveBlockEditor());
    $('dlgBlock').addEventListener('click', (e) => e.target === $('dlgBlock') && $('dlgBlock').close());
  }

  /**
   * "Nhân bản để chỉnh sửa" (right-click on a catalogue or "Tự tạo" card): open the block-builder
   * pre-filled with a snapshot of `entry`'s current shape, as a brand-new unsaved item — Lưu always
   * creates a separate library entry, so the source (built-in or already-saved custom) never changes.
   * Parts the block-builder can't edit (the lying-cylinder 'z' kind, used by a couple of built-in
   * parts) are dropped with a toast rather than silently mis-rendered.
   */
  duplicateToCustom(entry) {
    const [w, d, hh] = entry.size;
    let raw;
    try {
      raw = entry.parts(w, d, hh) || [];
    } catch (err) {
      this.toast('Không thể nhân bản món này.', 'err');
      return;
    }
    const supported = raw.filter((p) => p.k === 'b' || p.k === 'c' || p.k === 's' || p.k === 'm');
    const dropped = raw.length - supported.length;
    const overflow = Math.max(0, supported.length - MAX_PARTS);
    const template = templateFromParts(overflow ? supported.slice(0, MAX_PARTS) : supported, w, d, hh);

    this.ensureBlockEditor();
    this.blockSession.startFrom(`${entry.name} (bản sao)`, entry.size, entry.color, template);
    $('blockTitle').textContent = 'Tạo đồ vật mới';
    $('dlgBlock').showModal();
    this.blockView.resize();

    if (dropped || overflow) {
      const bits = [];
      if (dropped) bits.push(`${dropped} chi tiết đặc biệt không chỉnh được`);
      if (overflow) bits.push(`${overflow} khối vượt giới hạn ${MAX_PARTS}`);
      this.toast(`Đã bỏ qua ${bits.join(', ')}.`, 'err');
    }
  }

  openBlockEditor(id) {
    this.ensureBlockEditor();
    this.blockSession.reset(id ? customItems.get(id) : null);
    $('blockTitle').textContent = id ? 'Sửa đồ vật' : 'Tạo đồ vật mới';
    $('dlgBlock').showModal();
    this.blockView.resize(); // the mini canvas had 0×0 size while the dialog was closed
  }

  async saveBlockEditor() {
    const s = this.blockSession;
    if (!s.parts.length) {
      this.toast('Cần ít nhất 1 khối.', 'err');
      return;
    }
    try {
      let r = await this.storage.saveCustomItem({ id: s.editingId, ...s.toRecord(), baseRev: s.baseRev });
      if (r.conflict) {
        const ok = confirm(`Đồ vật này đã được sửa ở nơi khác (rev ${r.rev}).\n\nOK = ghi đè bằng bản đang sửa\nHuỷ = giữ nguyên, không lưu`);
        if (!ok) return;
        r = await this.storage.saveCustomItem({ id: s.editingId, ...s.toRecord(), baseRev: s.baseRev, force: true });
      }
      const wasEditing = !!s.editingId;
      registerCustomItem(r.record);
      this.view.invalidateType(r.record.id); // items already placed with the old shape pick up the edit immediately
      this.renderCustomGrid();
      $('dlgBlock').close();
      this.toast(wasEditing ? 'Đã lưu thay đổi' : 'Đã thêm vào thư viện');
    } catch (err) {
      this.toast(err.message, 'err');
    }
  }

  renderBlockList() {
    const root = $('blockList');
    root.replaceChildren();
    this.blockSession.parts.forEach((p, i) => {
      root.append(h('button', {
        type: 'button', class: 'blockrow' + (p.id === this.blockSession.selectedId ? ' on' : ''), text: `${PART_LABEL[p.k] || p.k} ${i + 1}`,
        on: { click: () => this.blockSession.select(p.id) },
      }));
    });
    root.append(h('div', { class: 'muted small blockcount', text: `${this.blockSession.parts.length}/${MAX_PARTS} khối` }));
  }

  renderBlockRight() {
    const root = $('blockRight');
    root.replaceChildren();
    this.blockRefreshers = [];
    const s = this.blockSession;
    const p = s.selectedPart;
    if (p) this.blockPartFields(root, p);
    else root.append(h('div', { class: 'muted small', text: 'Chọn một khối bên trái để chỉnh, hoặc bấm “+ Hộp / Trụ / Cầu” để thêm.' }));
    this.section(root, 'Đồ vật');
    root.append(
      this.row('Tên', this.bText({ get: () => s.name, set: (v) => s.setName(v) })),
      this.row('Rộng · Sâu · Cao',
        this.bNum({ get: () => s.box[0], set: (v) => s.setBox(v, s.box[1], s.box[2]), min: 5, max: 600 }),
        this.bNum({ get: () => s.box[1], set: (v) => s.setBox(s.box[0], v, s.box[2]), min: 5, max: 600 }),
        this.bNum({ get: () => s.box[2], set: (v) => s.setBox(s.box[0], s.box[1], v), min: 5, max: 600 })),
    );
    this.section(root, 'Màu mặc định');
    root.append(this.bColor({ get: () => s.color, set: (v) => s.setColor(v) }));
    this.blockRefreshers.forEach((fn) => fn());
  }

  blockPartFields(root, p) {
    const s = this.blockSession;
    this.section(root, `Khối đang chọn: ${PART_LABEL[p.k] || p.k}`);
    root.append(
      this.row('Vị trí X · Z (cm)',
        this.bNum({ get: () => p.x, set: (v) => s.replacePart(p.id, { ...p, x: v }), min: -500, max: 500 }),
        this.bNum({ get: () => p.z, set: (v) => s.replacePart(p.id, { ...p, z: v }), min: -500, max: 500 })),
      this.row('Cao đáy (cm)', this.bNum({ get: () => p.y, set: (v) => s.replacePart(p.id, { ...p, y: v }), min: -300, max: 900 })),
    );
    if (p.k === 'b') {
      root.append(this.row('Rộng · Sâu · Cao',
        this.bNum({ get: () => p.w, set: (v) => s.replacePart(p.id, { ...p, w: v }), min: 1, max: 600 }),
        this.bNum({ get: () => p.d, set: (v) => s.replacePart(p.id, { ...p, d: v }), min: 1, max: 600 }),
        this.bNum({ get: () => p.h, set: (v) => s.replacePart(p.id, { ...p, h: v }), min: 1, max: 600 })));
      root.append(this.row('Bo góc (cm)',
        this.bNum({ get: () => p.rd || 0, set: (v) => s.replacePart(p.id, { ...p, rd: v }), min: 0, max: 300, step: 0.5 })));
      root.append(h('div', { class: 'muted small', text: '0 = vuông. Số càng lớn góc càng bo tròn (tự giới hạn ở nửa cạnh ngắn nhất của khối).' }));
      root.append(this.row('Rộng đỉnh · Sâu đỉnh (cm)',
        this.bNum({ get: () => p.w1 ?? p.w, set: (v) => s.replacePart(p.id, { ...p, w1: v }), min: 0.1, max: 600 }),
        this.bNum({ get: () => p.d1 ?? p.d, set: (v) => s.replacePart(p.id, { ...p, d1: v }), min: 0.1, max: 600 })));
      root.append(h('div', { class: 'muted small', text: 'Bằng Rộng/Sâu ở trên = khối thẳng đứng như cũ. Nhỏ hơn = thon dần lên đỉnh (cánh hoa, lá); lớn hơn = loe ra.' }));
    } else if (p.k === 'c') {
      root.append(this.row('Bán kính · Cao',
        this.bNum({ get: () => p.r, set: (v) => s.replacePart(p.id, { ...p, r: v, rt: v }), min: 1, max: 300 }),
        this.bNum({ get: () => p.h, set: (v) => s.replacePart(p.id, { ...p, h: v }), min: 1, max: 600 })));
    } else if (p.k === 'm') {
      root.append(this.row('Rộng · Sâu (cm)',
        this.bNum({ get: () => p.w, set: (v) => s.replacePart(p.id, { ...p, w: v }), min: 1, max: 600 }),
        this.bNum({ get: () => p.d, set: (v) => s.replacePart(p.id, { ...p, d: v }), min: 1, max: 600 })));
      root.append(this.row('Số ô ngang · dọc',
        this.bNum({ get: () => p.cols, set: (v) => { s.replacePart(p.id, resizeMeshGrid(p, p.rows, v)); s.clearVertexSelection(); }, min: 1, max: MESH_MAX_GRID, step: 1 }),
        this.bNum({ get: () => p.rows, set: (v) => { s.replacePart(p.id, resizeMeshGrid(p, v, p.cols)); s.clearVertexSelection(); }, min: 1, max: MESH_MAX_GRID, step: 1 })));
      root.append(h('div', {
        class: 'muted small',
        text: 'Bấm một chấm để chọn; giữ Ctrl/Cmd và bấm để thêm/bớt chấm khỏi vùng chọn; kéo chuột trên khoảng trống của lưới để quét chọn nhiều chấm cùng lúc. Kéo chấm (hoặc cả nhóm đang chọn) để di chuyển tự do trong mặt phẳng lưới (đổi biên dạng 2D) — giữ Shift khi kéo để chỉ nâng/hạ theo chiều vuông góc (đổi độ cong). Chấm đang chọn sáng màu cam. Đổi số ô sẽ làm phẳng lại lưới.',
      }));
      const selCount = h('div', { class: 'muted small' });
      const showSelCount = () => { selCount.textContent = s.selectedVertices.size ? `${s.selectedVertices.size} chấm đang chọn` : 'Chưa chọn chấm nào'; };
      this.blockRefreshers.push(showSelCount);
      root.append(selCount);
      root.append(h('div', { class: 'btnrow' },
        h('button', { text: 'San phẳng lưới', on: { click: () => s.replacePart(p.id, flattenMesh(p)) } }),
        h('button', { text: 'Bỏ chọn tất cả', on: { click: () => s.clearVertexSelection() } })));
    } else {
      root.append(this.row('Bán kính X · Y · Z (cm)',
        this.bNum({ get: () => p.r, set: (v) => s.replacePart(p.id, { ...p, r: v }), min: 0.5, max: 300 }),
        this.bNum({ get: () => p.ry ?? p.r, set: (v) => s.replacePart(p.id, { ...p, ry: v }), min: 0.5, max: 300 }),
        this.bNum({ get: () => p.rz ?? p.r, set: (v) => s.replacePart(p.id, { ...p, rz: v }), min: 0.5, max: 300 })));
      root.append(h('div', { class: 'muted small', text: 'Bằng nhau = hình cầu tròn như cũ. Khác nhau = bóp méo thành khối trứng/dẹt (cánh hoa, quả...).' }));
    }
    root.append(this.row('Nghiêng · Xoay quanh Y (°)',
      this.bNum({ get: () => p.tilt || 0, set: (v) => s.replacePart(p.id, { ...p, tilt: v }), min: -90, max: 90, step: 5 }),
      this.bNum({ get: () => p.roty || 0, set: (v) => s.replacePart(p.id, { ...p, roty: v }), min: -360, max: 360, step: 5 })));
    root.append(h('div', { class: 'muted small', text: 'Nghiêng = ngả khối ra khỏi phương thẳng đứng (0 = đứng thẳng). Xoay = hướng ngả tới (như kim la bàn) — đổi Xoay ở nhiều khối cùng độ Nghiêng để chúng xoè ra như cánh hoa/tán lá.' }));
    this.section(root, 'Màu khối');
    root.append(this.bPartColor({ get: () => p.c, set: (v) => s.replacePart(p.id, { ...p, c: v }) }));
    root.append(h('div', { class: 'btnrow' },
      h('button', { text: 'Nhân bản', on: { click: () => s.duplicateSelected() } }),
      h('button', { class: 'danger', text: 'Xoá khối', on: { click: () => s.removeSelected() } })));
  }

  /** Value-only field bound to get()/set() — refreshes in place, never rebuilds the panel
   * (dragging a handle in the mini 3D view fires these dozens of times a second). */
  bNum({ get, set, min, max, step = 1 }) {
    const inp = h('input', { type: 'number', min, max, step, inputmode: 'decimal' });
    const show = () => { if (document.activeElement !== inp) inp.value = num1(get()); };
    inp.addEventListener('input', () => {
      const v = parseFloat(String(inp.value).replace(',', '.'));
      if (Number.isFinite(v)) set(clamp(v, min, max));
    });
    this.blockRefreshers.push(show);
    return inp;
  }

  bText({ get, set, max = 60 }) {
    const inp = h('input', { type: 'text', maxlength: max, spellcheck: 'false' });
    const show = () => { if (document.activeElement !== inp) inp.value = get(); };
    inp.addEventListener('input', () => set(inp.value));
    this.blockRefreshers.push(show);
    return inp;
  }

  bColor({ get, set }) {
    const inp = h('input', { type: 'color', class: 'color' });
    const show = () => (inp.value = get());
    inp.addEventListener('input', () => set(inp.value));
    this.blockRefreshers.push(show);
    return inp;
  }

  /** Part colour: a shade-of-main segmented control (same shading a built-in item's parts use) plus a literal-hex fallback. */
  bPartColor({ get, set }) {
    const tones = [['main', 'Chính'], ['light', 'Nhạt'], ['dark', 'Đậm'], ['darker', 'Rất đậm']];
    const seg = h('div', { class: 'seg tonepick' }, tones.map(([v, label]) => h('button', { type: 'button', text: label, on: { click: () => set(v) } })));
    const custom = h('input', { type: 'color', class: 'color', title: 'Màu riêng cho khối này' });
    custom.addEventListener('input', () => set(custom.value));
    const show = () => {
      const v = get();
      [...seg.children].forEach((b, i) => b.classList.toggle('on', tones[i][0] === v));
      if (v.startsWith('#')) custom.value = v;
    };
    this.blockRefreshers.push(show);
    return h('div', { class: 'colorrow' }, seg, custom);
  }

  // ---------- properties panel ---------------------------------------------------------
  renderProps() {
    const root = $('props');
    root.replaceChildren();
    this.refreshers = [];
    const sel = this.store.sel;
    const obj = this.store.selected;
    if (!sel || !obj) this.propsScene(root);
    else if (sel.kind === 'item') this.propsItem(root, obj);
    else if (sel.kind === 'wall') this.propsWall(root, obj);
    else this.propsFloor(root, obj);
    this.refreshers.forEach((fn) => fn());
  }

  /** Numeric input bound to get()/set(); live while typing, one undo step on change. */
  num({ get, set, min, max, step = 1, disabled = false }) {
    const inp = h('input', { type: 'number', min, max, step, inputmode: 'decimal', disabled });
    const show = () => { if (document.activeElement !== inp) inp.value = num1(get()); };
    inp.addEventListener('input', () => {
      const v = parseFloat(String(inp.value).replace(',', '.'));
      if (!Number.isFinite(v)) return;
      set(clamp(v, min, max));
      this.store.touch();
    });
    inp.addEventListener('change', () => {
      this.store.commit();
      inp.value = num1(get());
    });
    this.refreshers.push(show);
    return inp;
  }

  text({ get, set, max = 60 }) {
    const inp = h('input', { type: 'text', maxlength: max, spellcheck: 'false' });
    const show = () => { if (document.activeElement !== inp) inp.value = get(); };
    inp.addEventListener('input', () => { set(inp.value); this.store.touch(); });
    inp.addEventListener('change', () => this.store.commit());
    this.refreshers.push(show);
    return inp;
  }

  color({ get, set }) {
    const inp = h('input', { type: 'color', class: 'color' });
    const show = () => { inp.value = get(); };
    inp.addEventListener('input', () => { set(inp.value); this.store.touch(); });
    inp.addEventListener('change', () => this.store.commit());
    this.refreshers.push(show);
    const sw = h('div', { class: 'swatches' }, SWATCHES.map((c) =>
      h('button', {
        type: 'button', class: 'swatch', title: c, 'aria-label': c,
        on: { click: () => { set(c); this.store.touch(); this.store.commit(); } },
      })
    ));
    sw.querySelectorAll('.swatch').forEach((b) => (b.style.background = b.title));
    return h('div', { class: 'colorrow' }, inp, sw);
  }

  row(label, ...inputs) {
    return h('div', { class: 'field' }, h('span', { class: 'lbl', text: label }), h('div', { class: 'ctl' }, inputs));
  }

  section(root, title) {
    root.append(h('h3', { text: title }));
  }

  propsItem(root, it) {
    const e = lookupItem(it.type);
    const s = this.store;
    this.section(root, 'Đồ vật');
    root.append(
      this.row('Tên', this.text({ get: () => it.name, set: (v) => (it.name = v) })),
      h('div', { class: 'muted small', text: `Loại: ${e?.name ?? it.type}` }),
    );
    this.section(root, 'Vị trí');
    root.append(
      this.row('X · Z (cm)', this.num({ get: () => it.x, set: (v) => (it.x = v), min: -100000, max: 100000, step: 1, disabled: it.locked }), this.num({ get: () => it.z, set: (v) => (it.z = v), min: -100000, max: 100000, step: 1, disabled: it.locked })),
      this.row('Nâng cao (cm)', this.num({ get: () => it.y || 0, set: (v) => (it.y = v), min: 0, max: 1000, disabled: it.locked })),
      this.row('Xoay (°)', this.num({ get: () => it.rot, set: (v) => (it.rot = ((v % 360) + 360) % 360), min: 0, max: 360, step: 5, disabled: it.locked }),
        h('button', { class: 'mini', title: 'Xoay −90° (Shift+R)', text: '⟲ 90°', on: { click: () => this.interact.rotateSelected(-90) } }),
        h('button', { class: 'mini', title: 'Xoay +90° (R)', text: '⟳ 90°', on: { click: () => this.interact.rotateSelected(90) } })),
    );
    this.section(root, 'Kích thước (cm)');
    root.append(
      this.row('Rộng · Sâu · Cao',
        this.num({ get: () => it.w, set: (v) => (it.w = v), min: 2, max: 3000 }),
        this.num({ get: () => it.d, set: (v) => (it.d = v), min: 2, max: 3000 }),
        this.num({ get: () => it.h, set: (v) => (it.h = v), min: 0.5, max: 1000 })),
    );
    this.section(root, 'Màu');
    root.append(this.color({ get: () => it.color, set: (v) => (it.color = v) }));
    const lock = h('input', { type: 'checkbox' });
    lock.checked = it.locked;
    lock.addEventListener('change', () => {
      it.locked = lock.checked;
      s.touch();
      s.commit();
      s.emit('select'); // rebuild the panel + overlay (locked items lose the rotate handle)
    });
    root.append(
      h('label', { class: 'chk pad' }, lock, ' Khoá (không kéo/xoay được)'),
      h('div', { class: 'btnrow' },
        h('button', { text: 'Nhân bản', title: 'Ctrl+D', on: { click: () => s.duplicateSelected() } }),
        h('button', { class: 'danger', text: 'Xoá', title: 'Del', on: { click: () => s.removeSelected() } })),
    );
  }

  propsWall(root, w) {
    const s = this.store;
    this.section(root, 'Tường');
    const inner = h('div', { class: 'stat' });
    this.refreshers.push(() => (inner.textContent = `Thông thuỷ: ${fmtLen(wallInnerLength(s.doc, w))}`));
    root.append(
      inner,
      this.row('Dài tim (cm)', this.num({
        get: () => wallLength(w),
        set: (v) => {
          const len = wallLength(w);
          if (len < 0.5) return;
          const nb = [w.a[0] + ((w.b[0] - w.a[0]) / len) * v, w.a[1] + ((w.b[1] - w.a[1]) / len) * v];
          s.moveCorner([...w.b], nb.map((n) => Math.round(n * 10) / 10));
        },
        min: 5, max: 20000,
      })),
      this.row('Dày (cm)', this.num({ get: () => w.t ?? s.doc.settings.wallThickness, set: (v) => (w.t = v), min: 2, max: 100 })),
      this.row('Cao (cm)', this.num({ get: () => w.h ?? s.doc.settings.wallHeight, set: (v) => (w.h = v), min: 20, max: 600 })),
      h('div', { class: 'muted small', text: 'Kéo chấm xanh ở hai đầu tường để dời góc — các tường và sàn nối chung góc đi theo.' }),
      h('div', { class: 'btnrow' },
        h('button', { text: 'Dùng chiều cao chung', on: { click: () => { delete w.h; s.touch(); s.commit(); this.renderProps(); } } }),
        h('button', { class: 'danger', text: 'Xoá tường', on: { click: () => s.removeSelected() } })),
    );
  }

  propsFloor(root, f) {
    const s = this.store;
    this.section(root, 'Sàn');
    const area = h('div', { class: 'stat' });
    this.refreshers.push(() => (area.textContent = `Diện tích thông thuỷ: ${fmtArea(floorInnerArea(s.doc, f))}`));
    root.append(
      this.color({ get: () => f.color, set: (v) => (f.color = v) }),
      area,
      h('div', { class: 'muted small', text: `${f.pts.length} góc · tính đến mép trong của tường` }),
      h('div', { class: 'btnrow' }, h('button', { class: 'danger', text: 'Xoá sàn', on: { click: () => s.removeSelected() } })),
    );
  }

  propsScene(root) {
    const s = this.store, set = () => s.doc.settings;
    this.section(root, 'Cảnh');
    const stats = h('div', { class: 'stat' });
    const upd = () => {
      const d = s.doc;
      const area = d.floors.reduce((a, f) => a + floorInnerArea(d, f), 0);
      stats.textContent = `${d.items.length} đồ vật · ${d.walls.length} tường · sàn ${fmtArea(area)}`;
    };
    this.refreshers.push(upd);
    root.append(
      stats,
      this.row('Cao tường (cm)', this.num({ get: () => set().wallHeight, set: (v) => (set().wallHeight = v), min: 50, max: 600 })),
      this.row('Dày tường mới', this.num({ get: () => set().wallThickness, set: (v) => (set().wallThickness = v), min: 2, max: 100 })),
    );
    this.section(root, 'Màu tường');
    root.append(this.color({ get: () => set().wallColor, set: (v) => (set().wallColor = v) }));
    this.section(root, 'Màu sàn mới');
    root.append(this.color({ get: () => set().floorColor, set: (v) => (set().floorColor = v) }));
    root.append(
      h('div', { class: 'btnrow' },
        h('button', { class: 'danger', text: 'Xoá toàn bộ cảnh', on: { click: () => {
          if (!confirm('Xoá toàn bộ tường, sàn và đồ vật? (Có thể hoàn tác bằng Ctrl+Z)')) return;
          Object.assign(s.doc, { walls: [], floors: [], items: [] });
          s.touch();
          s.commit();
        } } })),
      h('details', { class: 'help' }, h('summary', { text: 'Phím tắt & mẹo' }), h('ul', {},
        ...['Kéo đồ từ thư viện vào cảnh; hoặc bấm đồ rồi bấm lên sàn.',
          'R / Shift+R: xoay 90° · Del: xoá · Ctrl+D: nhân bản · Ctrl+Z / Ctrl+Y: hoàn tác / làm lại · Ctrl+S: lưu.',
          'Mũi tên: dịch đồ theo bước lưới (Shift = 1 cm).',
          'Đồ tự áp sát tường và ngay góc khi kéo gần tường; giữ Alt để tắt snap.',
          '3D: chuột trái xoay, phải dịch, lăn để zoom. 2D: chuột trái dịch, lăn để zoom.',
          'Bấm ô “Nâng cao” để treo đồ lên tường (tủ bếp trên, TV...).'].map((t) => h('li', { text: t })))),
    );
  }

  // ---------- dialogs ------------------------------------------------------------------
  initDialogs() {
    const dlg = $('dlgRoom');
    $('btnRoom').addEventListener('click', () => this.openRoomDialog());
    $('formRoom').addEventListener('submit', (e) => {
      const ok = e.submitter?.value === 'ok';
      if (!ok) return;
      const f = new FormData(e.target);
      const n = (k, d, lo, hi) => clamp(parseFloat(String(f.get(k)).replace(',', '.')) || d, lo, hi);
      const replace = f.get('replace') === 'on';
      this.store.addRoomRect(n('w', 400, 60, 5000), n('d', 350, 60, 5000), n('t', 10, 2, 60), n('h', 270, 100, 600), replace);
      this.view.fit();
    });
    dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
    const open = $('dlgOpen');
    $('dlgOpenClose').addEventListener('click', () => open.close());
    open.addEventListener('click', (e) => e.target === open && open.close());
  }

  openRoomDialog() {
    const f = $('formRoom');
    const d = this.store.doc;
    f.elements.replace.checked = d.walls.length > 0 || d.floors.length > 0;
    f.elements.t.value = d.settings.wallThickness;
    f.elements.h.value = d.settings.wallHeight;
    $('dlgRoom').showModal();
    f.elements.w.focus();
  }

  async openProjects() {
    const dlg = $('dlgOpen'), list = $('projList'), msg = $('projMsg');
    list.replaceChildren();
    msg.textContent = 'Đang tải…';
    msg.className = 'muted';
    dlg.showModal();
    try {
      const items = await this.storage.listServer();
      msg.textContent = items.length ? '' : 'Chưa có dự án nào trên máy chủ. Bấm Lưu để tạo dự án đầu tiên.';
      for (const p of items) {
        const when = new Date(p.updatedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
        const row = h('div', { class: 'proj' },
          h('div', { class: 'pinfo' },
            h('strong', { text: p.name }),
            h('span', { class: 'muted small', text: `${when} · ${Math.max(1, Math.round(p.size / 1024))} KB · ${p.items} đồ vật · rev ${p.rev}` })),
          h('button', { class: 'primary', text: 'Mở', on: { click: () => this.openOne(p) } }),
          h('button', { class: 'danger', text: 'Xoá', title: 'Chuyển vào thùng rác trên máy chủ', on: { click: () => this.deleteOne(p, row) } }));
        if (p.id === this.storage.project.id) row.classList.add('current');
        list.append(row);
      }
    } catch (err) {
      msg.textContent = err.message + ' Bạn vẫn dùng được Xuất/Nhập file JSON.';
      msg.className = 'err';
    }
  }

  async openOne(p) {
    if (this.storage.project.dirty && p.id !== this.storage.project.id && !confirm('Dự án hiện tại có thay đổi chưa lưu lên máy chủ. Vẫn mở dự án khác?')) return;
    try {
      await this.storage.loadServer(p.id);
      this.view.fit();
      $('dlgOpen').close();
      this.toast(`Đã mở “${p.name}”`);
    } catch (err) {
      this.toast(err.message, 'err');
    }
  }

  async deleteOne(p, row) {
    if (!confirm(`Xoá “${p.name}” khỏi danh sách?\n(File được chuyển vào thư mục trash trên máy chủ, không mất hẳn.)`)) return;
    try {
      await this.storage.deleteServer(p.id);
      row.remove();
    } catch (err) {
      this.toast(err.message, 'err');
    }
  }
}
