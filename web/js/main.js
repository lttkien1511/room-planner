import { Store } from './model.js';
import { View } from './view.js';
import { Interact } from './interact.js';
import { Storage, loadPrefs } from './storage.js';
import { UI } from './ui.js';
import { registerCustomItem } from './catalog.js';

const fail = (msg) => {
  const box = document.getElementById('fatal');
  box.textContent = msg;
  box.hidden = false;
};

async function boot() {
  const prefs = loadPrefs();
  const store = new Store();
  const storage = new Storage(store);
  // Custom ("Tự tạo") items must be registered before any document is loaded/sanitised, or
  // items referencing them would look unknown and get dropped. A slow/offline server just means
  // an empty library for this load — restoreAutosave() etc. below still proceed normally.
  try {
    for (const rec of await storage.listCustomItems()) registerCustomItem(rec);
  } catch (err) {
    console.warn('Không tải được thư viện "Tự tạo":', err);
  }
  storage.restoreAutosave();
  const view = new View(document.getElementById('viewport'), store, prefs);
  const interact = new Interact(view, store, prefs);
  const ui = new UI({ store, view, interact, storage, prefs });
  view.fit();
  window.app = { store, view, interact, storage, ui, prefs }; // handy for debugging in the console
}

boot().catch((err) => {
  console.error(err);
  fail(/webgl/i.test(String(err?.message)) ? 'Trình duyệt/GPU này không hỗ trợ WebGL nên không dựng được cảnh 3D.' : `Không khởi động được: ${err?.message || err}`);
});
