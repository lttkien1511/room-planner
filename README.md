# Room Planner

Web mô phỏng phòng ốc bằng kéo thả (three.js), chạy nhẹ trên homeserver: **toàn bộ dựng hình chạy ở trình duyệt**,
server chỉ phát file tĩnh và lưu file JSON của dự án.

Đây là tài liệu kỹ thuật/vận hành (kiến trúc, triển khai, cập nhật). Muốn biết cách **dùng app**, xem
[HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md) (bản Word: [Room-Planner-Huong-Dan-Su-Dung.docx](Room-Planner-Huong-Dan-Su-Dung.docx)).
Muốn biết **quá trình xây dựng** app này, xem [NHAT-KY-XAY-DUNG.md](NHAT-KY-XAY-DUNG.md).

- Truy cập: `https://room.kienhomeserver.lab` (khuyên dùng — Ingress + DNS nội bộ đã bật). Dự phòng:
  `http://192.168.50.10:5080` (LAN/Tailscale, dùng khi thiết bị chưa phân giải được tên miền).
- Không đưa lên Funnel/Internet (chưa có đăng nhập).

## Kiến trúc

```
Trình duyệt ──► nginx (web, :5080) ──► /            file tĩnh  (web/)
                                   └─► /api/*       ──► api (Python stdlib, :8000) ──► DATA_DIR
                                                          └─ ./data (ổ Homeserver)  hoặc  /mnt/omv/room-planner (NFS trên OMV)
```

| Thư mục/file | Vai trò |
|---|---|
| `web/` | Ứng dụng (ES modules thuần, **không cần build**). `web/vendor/three.bundle.js` = three.js đã tree-shake + minify |
| `web/js/blockbuilder.js`, `blockeditor-view.js`, `blockeditor-interact.js` | Trình "Tự tạo đồ vật" — ghép khối hộp/trụ/cầu bằng tay cầm kéo trong khung nhìn 3D riêng |
| `api/server.py` | API lưu dự án + thư viện "Tự tạo" (chỉ thư viện chuẩn Python) |
| `nginx/` | Cấu hình nginx + header bảo mật (CSP…) |
| `docker-compose.yml` | 2 container: `web` (nginx-unprivileged) và `api` (python:3.12-alpine), read-only rootfs, cap_drop ALL |
| `deploy.sh` / `verify.sh` | Khởi động/cập nhật; kiểm tra nhanh toàn bộ |
| `setup-mount.sh`, `use-omv.sh` | Gắn NFS OMV và chuyển nơi lưu sang OMV |
| `k8s-ingress.yaml`, `apply-ingress.sh`, `add-dns.sh` | HTTPS `room.kienhomeserver.lab` qua Traefik + bản ghi DNS trên Bastion |
| `tools/build-vendor.sh` | Dựng lại `three.bundle.js` bằng Docker (esbuild) khi cần thêm class three.js |

## Lưu trữ dự án

3 lớp, độc lập nhau:

1. **Tự lưu trong trình duyệt** (localStorage): luôn bật, khôi phục cảnh khi mở lại trang.
2. **File JSON**: Tệp → *Xuất file JSON* / *Nhập file JSON…*
3. **Máy chủ (OMV)**: nút **Lưu** / Ctrl+S, Tệp → *Mở từ máy chủ…*.
   - Mỗi dự án là một file `projects/<id>.json`; bản cũ được giữ trong `history/<id>/` (20 bản gần nhất).
   - Có `rev` để phát hiện xung đột: nếu dự án đã bị sửa ở thiết bị khác, app hỏi trước khi ghi đè.
   - *Xoá* dự án chỉ chuyển file sang `trash/` — không mất hẳn. Khôi phục = chép file về `projects/`.

## Tự tạo đồ vật

Nút **+ Mới** ở đầu mục "Tự tạo" (thư viện bên trái) mở trình ghép khối: thêm khối Hộp/Trụ/Cầu, kéo trực tiếp
trong khung nhìn 3D riêng để dời/đổi kích thước (tay cầm chấm xanh), hoặc gõ số ở panel bên phải. Không có
hoàn tác riêng trong hộp thoại — Huỷ bỏ hết, Lưu ghi một lần.

- Lưu trên máy chủ (`custom-items/<tên-slug>/item.json`, cùng kiểu `rev`/lịch sử/thùng rác như dự án
  nhưng thư mục riêng — xem `CustomItems` trong `api/server.py`), dùng chung cho mọi dự án và mọi thiết
  bị. Tên thư mục tự đổi theo tên món (đổi tên món thì thư mục đổi theo) — chỉ để tiện xem trực tiếp qua
  SMB/SFTP trên OMV, không phải khoá định danh (`id` trong URL API không bao giờ đổi). Món nào có ảnh
  gốc (dựng qua pipeline AI ở `tree-gen/`, xem `NHAT-KY-XAY-DUNG.md`) thì có thêm `source.<ext>` cùng
  thư mục; món ghép tay trong app thì không có ảnh, chỉ `item.json` — bình thường.
- Mỗi món chỉ vài trăm byte đến vài KB (chỉ là số liệu khối, không phải file hình ảnh) — không cần giới hạn
  dung lượng riêng, không cần thêm bộ đọc file nào vào three.js.
- Sửa một món đã dùng trong phòng thì các đồ đã đặt cập nhật hình dạng ngay (không cần tải lại trang);
  xoá thì các đồ *đã đặt* vẫn hiện tới khi tải lại dự án, lúc đó sẽ bị bỏ qua (báo trong hộp thoại xoá).
- Tối đa 40 khối/món, khối luôn đứng thẳng (không xoay nghiêng) — đủ cho hầu hết đồ nội thất hình khối đơn giản.
- Màu từng khối dùng chung cơ chế tô theo sắc độ của đồ có sẵn (Chính/Nhạt/Đậm/Rất đậm, hoặc màu riêng), nên đổi màu cả món vẫn tự đổi tông từng khối.

## Triển khai / cập nhật

```bash
cd /home/room-planner
./deploy.sh          # kéo image, chạy compose, đợi healthy, chạy verify.sh
```

Sửa code trong `web/` có hiệu lực ngay (chỉ cần tải lại trang, nginx gửi ETag). Sửa `api/server.py` → `docker compose restart api`.

### Chuyển nơi lưu sang OMV (một lần)

1. **OMV web UI (192.168.50.15)**
   - Storage → Shared Folders → *Create*: tên `room-planner`, chọn ổ dữ liệu, quyền *Everyone: read/write*.
   - Services → NFS → Shares → *Create*: Shared folder `room-planner`, Client `192.168.50.10`, Privilege *Read/write*,
     Extra options `all_squash,anonuid=8890,anongid=8890` (giống export `actual-budget`, dùng uid riêng 8890). Save → **Apply**.
   - (Tuỳ chọn, để đặt quota) trên OMV chạy `useradd -M -u 8890 -s /usr/sbin/nologin roomplanner`, rồi Storage → File Systems → Quota: user `roomplanner`, ví dụ 5 GiB.
2. **Homeserver** (cần sudo): `sudo bash /home/room-planner/setup-mount.sh`
3. **Homeserver** (không sudo): `cd /home/room-planner && ./use-omv.sh` — chép dự án hiện có sang OMV, đổi `DATA_DIR` trong `.env`, khởi động lại.

`deploy.sh` từ chối chạy nếu `DATA_DIR` nằm dưới `/mnt/omv/` mà chưa phải mount NFS, tránh việc ghi nhầm vào ổ cục bộ.

### HTTPS `https://room.kienhomeserver.lab`

- Homeserver (không sudo): `./apply-ingress.sh`
- Bastion (sudo): chép `add-dns.sh` sang và chạy `sudo bash add-dns.sh` (tự backup zone, kiểm tra bằng `named-checkzone`, rollback nếu lỗi).
- Tile Homepage: đã thêm vào nhóm `Personal` (`/home/homepage/config/services.yaml` trên Bastion), icon SVG riêng
  `/home/homepage/images/room-planner.svg`, `siteMonitor` trỏ thẳng `http://192.168.50.10:5080`.

## Phát triển

Không cần Node. Máy dev chỉ cần Python 3:

```bash
python api/server.py --data ./devdata --static ./web --port 8099   # web + API tại http://localhost:8099
```

Thêm class three.js mới: sửa `tools/vendor-entry.js` rồi `./tools/build-vendor.sh` (cần Docker).

## Mô hình dữ liệu (đơn vị cm)

```
doc = { v, settings:{wallHeight,wallThickness,wallColor,floorColor},
        walls:[{id,a:[x,z],b:[x,z],t,h?}],       # đoạn tường theo tim tường
        floors:[{id,pts:[[x,z]...],color}],      # sàn dùng chung góc với tim tường
        items:[{id,type,name,x,z,y,rot,w,d,h,color,locked}] }
```
`rot` = độ, chiều kim đồng hồ khi nhìn từ trên xuống; mặt trước của đồ là +z, lưng là −z.

## Phím tắt

`R`/`Shift+R` xoay 90° · `Del` xoá · `Ctrl+D` nhân bản · `Ctrl+Z`/`Ctrl+Y` hoàn tác/làm lại · `Ctrl+S` lưu ·
mũi tên dịch đồ (Shift = 1 cm) · `Esc` huỷ công cụ · giữ `Alt` để tắt snap.
