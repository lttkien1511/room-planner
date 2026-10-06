// Persistence: (1) autosave in this browser, (2) JSON export/import, (3) projects on the
// server (stored on the OMV NFS share by the API container).
import { Emitter, debounce, uid } from './util.js';
import { newDoc, sanitizeDoc } from './model.js';

const AUTOSAVE_KEY = 'rp:autosave';
const PREFS_KEY = 'rp:prefs';
const APP_ID = 'room-planner';

export const DEFAULT_PREFS = { grid: 10, snap: true, shadows: false, wallMode: 'full', mode: '3d', dims: true };

export function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* private mode / quota: not critical */ }
}

export const newProjectId = () => 'p-' + uid('').toLowerCase();
export const newCustomItemId = () => 'c-' + uid('').toLowerCase();

async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (method !== 'GET') opts.headers['X-Requested-With'] = 'room-planner'; // CSRF guard, checked by the API
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('api/' + path, opts);
  } catch {
    throw Object.assign(new Error('Không kết nối được máy chủ lưu trữ.'), { offline: true });
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Lỗi máy chủ (${res.status})`), { status: res.status, data });
  return data;
}

/** Holds the "current project" (id/name/rev/dirty) and all the ways to save/load it. */
export class Storage extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.project = { id: null, name: 'Dự án mới', rev: null, dirty: false, savedAt: null };
    this._autosave = debounce(() => this.writeAutosave(), 600);
    store.on((k, why) => {
      if (k === 'doc' && why !== 'live' && why !== 'reset') {
        this.project.dirty = true;
        this._autosave();
        this.emit('project');
      }
    });
    window.addEventListener('pagehide', () => this._autosave.flush());
  }

  // ---- browser autosave -----------------------------------------------------------
  writeAutosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ project: this.project, doc: this.store.doc, at: Date.now() }));
    } catch { /* quota */ }
  }

  restoreAutosave() {
    try {
      const raw = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
      if (!raw?.doc) return false;
      const { doc } = sanitizeDoc(raw.doc);
      Object.assign(this.project, { id: null, name: 'Dự án mới', rev: null, dirty: false, savedAt: null }, raw.project || {});
      this.store.reset(doc);
      this.emit('project');
      return true;
    } catch {
      return false;
    }
  }

  // ---- project lifecycle ----------------------------------------------------------
  newProject() {
    Object.assign(this.project, { id: null, name: 'Dự án mới', rev: null, dirty: false, savedAt: null });
    this.store.reset(newDoc());
    this.writeAutosave();
    this.emit('project');
  }

  rename(name) {
    name = (name || '').trim().slice(0, 80) || 'Dự án mới';
    if (name === this.project.name) return;
    this.project.name = name;
    this.project.dirty = true;
    this._autosave();
    this.emit('project');
  }

  // ---- JSON file ------------------------------------------------------------------
  exportJSON() {
    const env = { app: APP_ID, v: 1, name: this.project.name, exportedAt: new Date().toISOString(), doc: this.store.doc };
    const blob = new Blob([JSON.stringify(env, null, 1)], { type: 'application/json' });
    const slug = this.project.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'room';
    return { blob, filename: `${slug}.room.json` };
  }

  async importJSON(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error('File quá lớn (giới hạn 8 MB).');
    let raw;
    try { raw = JSON.parse(await file.text()); } catch { throw new Error('File không phải JSON hợp lệ.'); }
    const docRaw = raw?.doc ?? raw;
    const { doc, report } = sanitizeDoc(docRaw);
    if (!report.ok || (!doc.walls.length && !doc.items.length && !doc.floors.length)) throw new Error('File không chứa dữ liệu phòng hợp lệ.');
    Object.assign(this.project, { id: null, rev: null, dirty: true, savedAt: null, name: (typeof raw?.name === 'string' && raw.name.trim().slice(0, 80)) || file.name.replace(/\.(room\.)?json$/i, '') });
    this.store.reset(doc);
    this.writeAutosave();
    this.emit('project');
    return report;
  }

  // ---- server ---------------------------------------------------------------------
  listServer() { return api('GET', 'projects'); }

  async loadServer(id) {
    const env = await api('GET', `projects/${encodeURIComponent(id)}`);
    const { doc } = sanitizeDoc(env.doc);
    Object.assign(this.project, { id: env.id, name: env.name, rev: env.rev, dirty: false, savedAt: env.updatedAt });
    this.store.reset(doc);
    this.writeAutosave();
    this.emit('project');
  }

  /** Returns {conflict:true, rev} when the server copy changed elsewhere and force is false. */
  async saveServer(force = false) {
    if (!this.project.id) this.project.id = newProjectId();
    try {
      const meta = await api('PUT', `projects/${encodeURIComponent(this.project.id)}`, {
        name: this.project.name, doc: this.store.doc, baseRev: this.project.rev ?? 0, force,
      });
      Object.assign(this.project, { rev: meta.rev, dirty: false, savedAt: meta.updatedAt });
      this.writeAutosave();
      this.emit('project');
      return { ok: true, meta };
    } catch (err) {
      if (err.status === 409) return { conflict: true, rev: err.data?.rev };
      throw err;
    }
  }

  async deleteServer(id) {
    await api('DELETE', `projects/${encodeURIComponent(id)}`);
    if (this.project.id === id) Object.assign(this.project, { id: null, rev: null, savedAt: null, dirty: true });
    this.emit('project');
  }

  async health() { return api('GET', 'health'); }

  // ---- custom item library ("Tự tạo") ---------------------------------------------------------
  // Server-only: no browser autosave, no JSON export — these are small enough that a plain
  // fetch-all at startup is cheap, and re-fetching them all after a change keeps the client simple.
  listCustomItems() { return api('GET', 'custom-items'); }

  /** rec: {id?, name, size, color, template, baseRev, force?}. Returns {ok,record} or {conflict,rev}. */
  async saveCustomItem(rec) {
    const id = rec.id || newCustomItemId();
    try {
      const record = await api('PUT', `custom-items/${encodeURIComponent(id)}`, {
        name: rec.name, size: rec.size, color: rec.color, template: rec.template, baseRev: rec.baseRev ?? 0, force: !!rec.force,
      });
      return { ok: true, record };
    } catch (err) {
      if (err.status === 409) return { conflict: true, rev: err.data?.rev };
      throw err;
    }
  }

  async deleteCustomItem(id) {
    await api('DELETE', `custom-items/${encodeURIComponent(id)}`);
  }
}
