#!/usr/bin/env python3
"""Room Planner storage API. Python standard library only.

Layout inside --data (this is the OMV NFS share in production):
    projects/<user>/<id>.json          current version  {id,name,rev,createdAt,updatedAt,doc}
    history/<user>/<id>/<rev>-<ts>.json previous versions (last HISTORY_KEEP kept)
    trash/<user>/<id>-<ts>.json        "deleted" projects (never purged automatically)

<user> = slugify() của email xác thực qua Cloudflare Access (header Cf-Access-Authenticated-User-Email,
xem ACCESS_EMAIL_HEADER) — mỗi người chỉ thấy/sửa được project của chính mình. Không có header đó
(dev local, chưa đứng sau Cloudflare) thì coi như 1 user chung "dev-local". custom-items (thư viện
đồ tự tạo) vẫn dùng chung cho mọi user, không tách theo người — đó là "catalog" cộng đồng, không
phải dữ liệu riêng tư.

Endpoints (all under /api):
    GET    /api/health
    GET    /api/projects              -> [meta...]                      (chỉ của user gọi request)
    GET    /api/projects/<id>         -> full project
    PUT    /api/projects/<id>         body {name, doc, baseRev, force?}  -> meta (409 on rev conflict)
    DELETE /api/projects/<id>         -> moves the file to trash/

    GET    /api/custom-items          -> [record...]  (user-made furniture, "Tự tạo")
    GET    /api/custom-items/<id>     -> one record {id,name,size,color,template,rev,...}
    PUT    /api/custom-items/<id>     body {name, size, color, template, baseRev, force?} -> record (409 on rev conflict)
    DELETE /api/custom-items/<id>     -> moves the whole custom-items/<slug>/ folder to custom-items-trash/

custom-items/<slug>/item.json is the record; <slug> is a slugified version of the item's own name
(so the library is readable straight off the OMV share, e.g. in File Explorer over SMB) and is
renamed automatically whenever the name changes. A sibling custom-items/<slug>/source.<ext>, when
present, is a reference photo — only items built through the separate tree-gen photo pipeline have
one; anything made by hand in the in-app block-builder has just item.json. `id` (used in every API
path above) never changes and is resolved to its current slug internally — callers never see slugs.

Writes need the header "X-Requested-With: room-planner" (CSRF guard: a cross-site page cannot
send it without a CORS preflight, and this server answers no preflight).
With --static <dir> it also serves the web app itself (development only; nginx does that in prod).
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{4,47}$")
CUSTOM_ID_RE = re.compile(r"^c-[a-z0-9]{4,40}$")
MAX_BODY = 6 * 1024 * 1024
HISTORY_KEEP = 20
LIMITS = (("walls", 2000), ("floors", 200), ("items", 3000))
CUSTOM_MAX_PARTS = 200
CUSTOM_FRACTION_MAX = 6.0  # generous headroom for a part that pokes outside the nominal box
MESH_MAX_GRID = 8  # must match MESH_MAX_GRID in web/js/catalog.js
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
}
LOCK = threading.Lock()

ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email"  # Cloudflare Access tu dinh kem khi public
DEV_USER = "dev-local"  # khong co header tren (dev local, chua dung sau Access) -> 1 user chung
MAX_PROJECTS_PER_USER = 30  # chan 1 user chiem het dung luong OMV dung chung voi cac service khac

MAX_CONCURRENT_USERS = 10
CONCURRENT_WINDOW = 15 * 60  # giay - khong goi API nao trong 15 phut thi coi nhu da roi app, nhuong cho
ACTIVE_LOCK = threading.Lock()
_active_users = {}  # email (chua slugify) -> lan goi gan nhat (epoch giay)


def admit_user(email):
    """True neu user duoc vao (da o trong, hoac con cho trong), False neu du 10 nguoi va day la
    1 nguoi moi chua tung vao. Don dep nhung user qua CONCURRENT_WINDOW khong hoat dong truoc khi
    dem, de ho nhuong cho nguoi khac ma khong can tu dang xuat."""
    now = time.time()
    with ACTIVE_LOCK:
        for e in [e for e, t in _active_users.items() if now - t > CONCURRENT_WINDOW]:
            del _active_users[e]
        if email in _active_users or len(_active_users) < MAX_CONCURRENT_USERS:
            _active_users[email] = now
            return True
        return False


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Projects:
    """Moi project nam duoi 1 thu muc rieng theo user (xem ACCESS_EMAIL_HEADER o tren) - cac
    duong dan deu nhan `user` (da slugify, an toan lam ten thu muc) lam tham so dau tien."""

    def __init__(self, root: Path):
        self.projects, self.history, self.trash = root / "projects", root / "history", root / "trash"
        for d in (self.projects, self.history, self.trash):
            d.mkdir(parents=True, exist_ok=True)

    def _user_dir(self, base: Path, user: str) -> Path:
        d = base / user
        d.mkdir(parents=True, exist_ok=True)
        return d

    def path(self, user, pid):
        return self._user_dir(self.projects, user) / f"{pid}.json"

    def read(self, user, pid):
        try:
            return json.loads(self.path(user, pid).read_text("utf-8"))
        except FileNotFoundError:
            return None

    @staticmethod
    def write_atomic(path: Path, data: bytes):
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o644)  # mkstemp creates 0600; other users (backups, OMV) must be able to read
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def meta(env, size):
        doc = env.get("doc") or {}
        return {
            "id": env["id"], "name": env.get("name", ""), "rev": env.get("rev", 1), "createdAt": env.get("createdAt"),
            "updatedAt": env.get("updatedAt"), "size": size, "items": len(doc.get("items", [])),
        }

    def list(self, user):
        out = []
        for p in self._user_dir(self.projects, user).glob("*.json"):
            try:
                out.append(self.meta(json.loads(p.read_text("utf-8")), p.stat().st_size))
            except (OSError, ValueError, KeyError):
                continue  # unreadable file: skip, never fail the whole list
        out.sort(key=lambda m: m.get("updatedAt") or "", reverse=True)
        return out

    def put(self, user, pid, name, doc, base_rev, force):
        with LOCK:
            cur = self.read(user, pid)
            if cur is None:
                existing = sum(1 for _ in self._user_dir(self.projects, user).glob("*.json"))
                if existing >= MAX_PROJECTS_PER_USER:
                    return 403, {"error": f"Đã đạt giới hạn {MAX_PROJECTS_PER_USER} dự án cho mỗi người dùng."}
            if cur is not None and not force and cur.get("rev") != base_rev:
                return 409, {"error": "Dự án đã được thay đổi ở nơi khác.", "rev": cur.get("rev")}
            ts = now_iso()
            env = {
                "id": pid, "name": name, "rev": (cur.get("rev", 0) + 1) if cur else 1,
                "createdAt": cur.get("createdAt", ts) if cur else ts, "updatedAt": ts, "doc": doc,
            }
            data = json.dumps(env, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if cur is not None:
                self._archive(user, pid, cur)
            self.write_atomic(self.path(user, pid), data)
            return 200, self.meta(env, len(data))

    def _archive(self, user, pid, cur):
        d = self._user_dir(self.history, user) / pid
        d.mkdir(exist_ok=True)
        stamp = re.sub(r"[^0-9]", "", cur.get("updatedAt") or now_iso())
        self.write_atomic(d / f"{int(cur.get('rev', 0)):05d}-{stamp}.json", json.dumps(cur, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        for old in sorted(d.glob("*.json"))[:-HISTORY_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass

    def delete(self, user, pid):
        with LOCK:
            src = self.path(user, pid)
            if not src.exists():
                return False
            os.replace(src, self._user_dir(self.trash, user) / f"{pid}-{time.strftime('%Y%m%d-%H%M%S')}.json")
            return True


def validate_doc(doc):
    if not isinstance(doc, dict):
        raise ValueError("doc phải là một object")
    for key, cap in LIMITS:
        v = doc.get(key, [])
        if not isinstance(v, list) or len(v) > cap:
            raise ValueError(f"doc.{key} không hợp lệ hoặc quá lớn")
    return doc


def slugify(name):
    """Same convention as the web app's own `fold()` (ui.js) and tree-gen's gen_draft.py: strip
    diacritics, đ->d, lowercase, non-alphanumeric runs -> single hyphen — so a folder name on disk
    reads the same as the name shown in the app."""
    s = unicodedata.normalize("NFD", name or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.replace("đ", "d").replace("Đ", "D").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "do-vat"


class CustomItems:
    """User-made furniture ('Tự tạo'): small JSON records with the same durability pattern as
    Projects (atomic write, history, soft delete) but under their own directories — Projects'
    on-disk layout (already holding real project data by the time this feature was added) is
    never touched here, so this is deliberately a sibling class rather than a shared refactor.

    One folder per item, named after a slug of its own current name — custom-items/<slug>/item.json
    (+ an optional sibling source.<ext> reference photo, dropped in directly by the tree-gen
    pipeline; never read or written by this class) — so the library is readable straight off the
    OMV share (e.g. browsing over SMB), unlike a flat <id>.json. `id` is still the only thing every
    API caller ever sees; it's resolved to its current slug through `self._slugs`, an in-memory
    map rebuilt at startup and kept in sync on every write/delete, so a rename moves the folder
    (and its photo, if any) without the caller needing to know or care."""

    def __init__(self, root: Path):
        self.items, self.history, self.trash = root / "custom-items", root / "custom-items-history", root / "custom-items-trash"
        for d in (self.items, self.history, self.trash):
            d.mkdir(parents=True, exist_ok=True)
        self._slugs = {}  # id -> slug (== folder name under self.items)
        for d in self.items.iterdir():
            if not d.is_dir():
                continue
            try:
                rec = json.loads((d / "item.json").read_text("utf-8"))
                self._slugs[rec["id"]] = d.name
            except (OSError, ValueError, KeyError):
                continue  # not a valid item folder (stray file, half-written, etc.) — ignore it

    def _folder(self, cid):
        slug = self._slugs.get(cid)
        return (self.items / slug) if slug else None

    def _free_slug(self, base, exclude_id):
        """`base` itself if free, else `base-2`, `base-3`... — checked against every OTHER item
        (not `exclude_id`, so saving an item under its own unchanged name never "collides" with
        itself)."""
        taken = {s for i, s in self._slugs.items() if i != exclude_id}
        if base not in taken:
            return base
        n = 2
        while f"{base}-{n}" in taken:
            n += 1
        return f"{base}-{n}"

    def path(self, cid):
        d = self._folder(cid)
        return (d / "item.json") if d else None

    def read(self, cid):
        p = self.path(cid)
        if p is None:
            return None
        try:
            return json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            return None

    def list(self):
        with LOCK:  # snapshot before iterating — a concurrent put()/delete() mutates self._slugs
            slugs = list(self._slugs.values())
        out = []
        for slug in slugs:
            try:
                out.append(json.loads((self.items / slug / "item.json").read_text("utf-8")))
            except (OSError, ValueError):
                continue  # unreadable/renamed-away mid-iteration: skip, never fail the whole list
        out.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
        return out

    def put(self, cid, name, size, color, template, base_rev, force):
        with LOCK:
            cur = self.read(cid)
            if cur is not None and not force and cur.get("rev") != base_rev:
                return 409, {"error": "Đồ vật đã được thay đổi ở nơi khác.", "rev": cur.get("rev")}
            ts = now_iso()
            rec = {
                "id": cid, "name": name, "size": size, "color": color, "template": template,
                "rev": (cur.get("rev", 0) + 1) if cur else 1,
                "createdAt": cur.get("createdAt", ts) if cur else ts, "updatedAt": ts,
            }
            data = json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if cur is not None:
                self._archive(cid, cur)

            old_dir = self._folder(cid)
            new_slug = self._free_slug(slugify(name), exclude_id=cid)
            if old_dir is None:
                new_dir = self.items / new_slug
                new_dir.mkdir(parents=True, exist_ok=True)
            elif old_dir.name != new_slug:
                new_dir = self.items / new_slug
                os.replace(old_dir, new_dir)  # renames the folder — item.json AND source.* (if any) move together
            else:
                new_dir = old_dir
            self._slugs[cid] = new_dir.name

            Projects.write_atomic(new_dir / "item.json", data)
            return 200, rec

    def _archive(self, cid, cur):
        d = self.history / cid
        d.mkdir(exist_ok=True)
        stamp = re.sub(r"[^0-9]", "", cur.get("updatedAt") or now_iso())
        Projects.write_atomic(d / f"{int(cur.get('rev', 0)):05d}-{stamp}.json", json.dumps(cur, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        for old in sorted(d.glob("*.json"))[:-HISTORY_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass

    def delete(self, cid):
        with LOCK:
            src = self._folder(cid)
            if src is None or not src.exists():
                return False
            os.replace(src, self.trash / f"{src.name}-{time.strftime('%Y%m%d-%H%M%S')}")  # whole folder, photo included
            del self._slugs[cid]
            return True


def validate_custom_item(name, size, color, template):
    if not (isinstance(size, list) and len(size) == 3 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and 1 <= v <= 3000 for v in size)):
        raise ValueError("Kích thước tổng thể không hợp lệ")
    if not (isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color)):
        raise ValueError("Màu không hợp lệ")
    if not isinstance(template, list) or not (1 <= len(template) <= CUSTOM_MAX_PARTS):
        raise ValueError(f"Cần 1-{CUSTOM_MAX_PARTS} khối")
    num_fields = ("fx", "fy", "fz", "fw", "fh", "fd", "fr", "frt", "frd", "fw1", "fd1", "fry", "frz")
    angle_fields = ("froty", "ftilt")  # degrees, not a fraction of ref — own (much wider) bound
    for p in template:
        if not isinstance(p, dict) or p.get("k") not in ("b", "c", "s", "m"):
            raise ValueError("Khối không hợp lệ")
        for key in num_fields:
            if key in p:
                v = p[key]
                if not isinstance(v, (int, float)) or isinstance(v, bool) or abs(v) > CUSTOM_FRACTION_MAX:
                    raise ValueError(f"Giá trị khối vượt giới hạn: {key}")
        for key in angle_fields:
            if key in p:
                v = p[key]
                if not isinstance(v, (int, float)) or isinstance(v, bool) or abs(v) > 720:
                    raise ValueError(f"Góc xoay vượt giới hạn: {key}")
        if p.get("k") == "m":
            # Mesh part (block-builder's vertex editor) — rows/cols are plain integer grid
            # resolution (not fractions of ref like everything else), fvh is one height fraction
            # per grid vertex, length must match rows×cols exactly or geometryForPart can't build it.
            rows, cols = p.get("rows"), p.get("cols")
            if not (isinstance(rows, int) and not isinstance(rows, bool) and 1 <= rows <= MESH_MAX_GRID):
                raise ValueError("Số hàng lưới không hợp lệ")
            if not (isinstance(cols, int) and not isinstance(cols, bool) and 1 <= cols <= MESH_MAX_GRID):
                raise ValueError("Số cột lưới không hợp lệ")
            n_verts = (rows + 1) * (cols + 1)
            for key in ("fvh", "fvx", "fvz"):  # height + 2D in-plane offset, one triple per vertex
                fv = p.get(key)
                if not (isinstance(fv, list) and len(fv) == n_verts
                        and all(isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) <= CUSTOM_FRACTION_MAX for v in fv)):
                    raise ValueError(f"Danh sách đỉnh lưới không hợp lệ: {key}")
        c = p.get("c")
        if c is not None and not (isinstance(c, str) and (c in ("main", "dark", "darker", "light") or re.fullmatch(r"#[0-9a-fA-F]{6}", c))):
            raise ValueError("Màu khối không hợp lệ")
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "RoomPlannerAPI/1"
    protocol_version = "HTTP/1.1"
    store: Projects = None
    custom_store: "CustomItems" = None
    static: Path = None
    _body_read = False

    def handle_one_request(self):
        self._body_read = False  # per request (the handler object lives as long as the connection)
        super().handle_one_request()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ---- helpers ----
    def body_pending(self):
        """True when the request carries a body we did not read (must not be left on a keep-alive socket)."""
        try:
            return self.command in ("PUT", "POST", "DELETE") and int(self.headers.get("Content-Length") or 0) > 0 and not self._body_read
        except ValueError:
            return True

    def send_bytes(self, status, body: bytes, ctype="application/json; charset=utf-8", headers=None):
        self.send_response(status)
        if self.body_pending():
            self.send_header("Connection", "close")
            self.close_connection = True
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if ctype.startswith("application/json") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, payload):
        self.send_bytes(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def fail(self, status, msg):
        self.send_json(status, {"error": msg})

    def guard_write(self):
        if self.headers.get("X-Requested-With") != "room-planner":
            self.fail(403, "Thiếu header X-Requested-With.")
            return False
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
            self.fail(403, "Origin không khớp.")
            return False
        return True

    def user_email(self):
        """Email xac thuc qua Cloudflare Access (header do Cloudflare tu dinh kem, khong the gia
        mao tu ben ngoai vi chi Access moi set duoc no truoc khi toi origin). Khong co header (dev
        local, chua dung sau Access) -> 1 user chung DEV_USER."""
        email = self.headers.get(ACCESS_EMAIL_HEADER)
        return (email or "").strip().lower() or DEV_USER

    def admit_or_fail(self):
        """Dang ky user hien tai vao danh sach dang hoat dong; bao 503 va tra False neu da du
        MAX_CONCURRENT_USERS nguoi khac dang dung va day la 1 nguoi moi."""
        email = self.user_email()
        if admit_user(email):
            return email
        self.fail(503, f"Hệ thống đang giới hạn tối đa {MAX_CONCURRENT_USERS} người dùng cùng lúc. Vui lòng thử lại sau.")
        return None

    def read_json(self):
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.fail(411, "Thiếu Content-Length.")
            return None
        if n < 0 or n > MAX_BODY:
            self.fail(413, "Dữ liệu quá lớn (giới hạn 6 MB).")
            return None
        raw = self.rfile.read(n)
        self._body_read = True
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.fail(400, "Body không phải JSON hợp lệ.")
            return None

    # ---- routing ----
    def route(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            parts = [unquote(p) for p in path[5:].strip("/").split("/") if p]
            return "api", parts
        return "static", path

    def do_GET(self):
        kind, arg = self.route()
        if kind == "static":
            return self.serve_static(arg)
        try:
            if arg == ["health"]:
                probe = self.store.projects / ".health"
                probe.write_text(now_iso())
                return self.send_json(200, {"ok": True, "time": now_iso()})
            email = self.admit_or_fail()
            if email is None:
                return
            user = slugify(email)
            if arg == ["projects"]:
                return self.send_json(200, self.store.list(user))
            if len(arg) == 2 and arg[0] == "projects" and ID_RE.match(arg[1]):
                env = self.store.read(user, arg[1])
                return self.send_json(200, env) if env else self.fail(404, "Không tìm thấy dự án.")
            if arg == ["custom-items"]:
                return self.send_json(200, self.custom_store.list())
            if len(arg) == 2 and arg[0] == "custom-items" and CUSTOM_ID_RE.match(arg[1]):
                rec = self.custom_store.read(arg[1])
                return self.send_json(200, rec) if rec else self.fail(404, "Không tìm thấy đồ vật.")
        except OSError as e:
            return self.fail(503, f"Không đọc/ghi được kho lưu trữ: {e.strerror or e}")
        self.fail(404, "Không tìm thấy.")

    def do_PUT(self):
        kind, arg = self.route()
        is_project = len(arg) == 2 and arg[0] == "projects" and ID_RE.match(arg[1])
        is_custom = len(arg) == 2 and arg[0] == "custom-items" and CUSTOM_ID_RE.match(arg[1])
        if kind != "api" or not (is_project or is_custom):
            return self.fail(404, "Không tìm thấy.")
        if not self.guard_write():
            return
        email = self.admit_or_fail()
        if email is None:
            return
        body = self.read_json()
        if body is None:
            return
        try:
            if not isinstance(body, dict):
                raise ValueError("body phải là object")
            base = body.get("baseRev", 0)
            base = base if isinstance(base, int) and not isinstance(base, bool) else 0
            force = body.get("force") is True
            if is_project:
                name = str(body.get("name", "")).strip()[:80] or "Dự án"
                doc = validate_doc(body.get("doc"))
                status, payload = self.store.put(slugify(email), arg[1], name, doc, base, force)
            else:
                name = str(body.get("name", "")).strip()[:60] or "Đồ vật"
                size, color, template = body.get("size"), body.get("color"), body.get("template")
                validate_custom_item(name, size, color, template)
                status, payload = self.custom_store.put(arg[1], name, size, color, template, base, force)
        except ValueError as e:
            return self.fail(400, str(e))
        except OSError as e:
            return self.fail(503, f"Không ghi được vào kho lưu trữ: {e.strerror or e}")
        self.send_json(status, payload)

    def do_DELETE(self):
        kind, arg = self.route()
        is_project = kind == "api" and len(arg) == 2 and arg[0] == "projects" and ID_RE.match(arg[1])
        is_custom = kind == "api" and len(arg) == 2 and arg[0] == "custom-items" and CUSTOM_ID_RE.match(arg[1])
        if not (is_project or is_custom):
            return self.fail(404, "Không tìm thấy.")
        not_found = "Không tìm thấy dự án." if is_project else "Không tìm thấy đồ vật."
        if not self.guard_write():
            return
        email = self.admit_or_fail()
        if email is None:
            return
        try:
            ok = self.store.delete(slugify(email), arg[1]) if is_project else self.custom_store.delete(arg[1])
        except OSError as e:
            return self.fail(503, f"Không xoá được: {e.strerror or e}")
        self.send_json(200, {"ok": True}) if ok else self.fail(404, not_found)

    def do_HEAD(self):
        self.do_GET()

    def serve_static(self, rel):
        if not self.static:
            return self.fail(404, "Không tìm thấy.")
        rel = unquote(rel).lstrip("/") or "index.html"
        target = (self.static / rel).resolve()
        if self.static.resolve() not in target.parents and target != self.static.resolve():
            return self.fail(403, "Cấm truy cập.")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self.fail(404, "Không tìm thấy.")
        ctype = MIME.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_bytes(200, target.read_bytes(), ctype)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", required=True, help="storage directory (created if missing)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--static", help="also serve this directory (development only)")
    args = ap.parse_args()
    Handler.store = Projects(Path(args.data))
    Handler.custom_store = CustomItems(Path(args.data))
    Handler.static = Path(args.static) if args.static else None
    # Mac dinh socketserver.BaseServer.request_queue_size = 5 — qua nho, dong ket noi moi
    # don vao hang doi TCP bi day gay timeout o client khi nhieu nguoi dung cung luc (do kiem
    # chung bang tai thu 2026-10-05: ~150 user dong thoi bat dau timeout dich vu ngay ca khi
    # CPU/RAM homeserver van con rat nhieu — nut that la hang doi nay, khong phai phan cung).
    ThreadingHTTPServer.request_queue_size = 256
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print(f"Room Planner API on {args.host}:{args.port}, data={args.data}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
