# Tra cứu mã vận đơn — bản deploy Vercel

Bản deploy công khai của web **Tra cứu mã vận đơn**, tách từ artifact Muse
cùng tên. Lý do tách: máy chủ của artifact trên Muse không có cách nào đặt
biến môi trường, nên API key không cài được vào đó; trên Vercel, key nằm
trong Environment Variables phía server — đúng chỗ của nó — và web có link
công khai cho mọi người dùng.

## Stack

- **Framework:** Vite + React 19 + TypeScript (đúng stack client của artifact),
  Tailwind CSS v4, TanStack Query.
- **Build command:** `npm run build` (= `tsc --noEmit && vite build`), output `dist/`
  (đã khai trong `vercel.json`, Vercel tự nhận framework "Vite").
- **Server:** Vercel Serverless Functions trong `api/`:
  - `POST /api/track` — tra một mã: mã dạng GHTK → API chính thức của GHTK;
    mã khác → 17TRACK Tracking API v2.4 (tự nhận diện hãng, đăng ký mã lần
    đầu qua `/register`); API chưa có kết quả → fallback lấy trực tiếp từ
    trang tra cứu công khai của hãng (mã SPX tra được KHÔNG cần key qua
    endpoint get_order_info của SPX, đã kiểm chứng live; nếu endpoint đó
    không có kết quả thì thử qua API LastScanned khi đã cấu hình
    `LASTSCANNED_API_KEY`, rồi mới gọi trực tiếp sang SPX; SPX có hạ nhiệt
    60 phút sau khi bị
    Shopee chặn chống bot; GHN cần xác thực SĐT, VNPost có captcha, Viettel
    Post/DHL/UPS/FedEx có tường bot, J&T/Ninja Van/BEST không có endpoint
    công khai — tất cả đều báo rõ lý do bằng tiếng Việt kèm link trang hãng,
    không bịa dữ liệu).
  - `GET /api/config-status` — chỉ trả các boolean "đã cấu hình key chưa".
  - Logic tra cứu nằm ở `api/_lib/tracking.ts`, port nguyên từ
    `server/src/actions.ts` của artifact.

## Biến môi trường (bắt buộc để tra cứu thật)

Đặt trong **Vercel → Project → Settings → Environment Variables**
(môi trường Production), **không** dùng tiền tố `VITE_`:

| Biến | Ý nghĩa | Lấy ở đâu |
|---|---|---|
| `TRACK17_API_KEY` | API key 17TRACK (3.598 hãng, trừ GHTK) | Tài khoản miễn phí 17track.net → trang API → Settings → Security Key |
| `GHTK_API_TOKEN` | Token API của tài khoản shop GHTK | khachhang.giaohangtietkiem.vn → Thông tin shop → Cấu hình API (tick quyền "Trạng thái đơn hàng", đặt ngày hết hạn) |
| `GHTK_CLIENT_SOURCE` | Mã shop GHTK của cùng tài khoản (ví dụ `S123456`) | Hiện cạnh lời chào sau khi đăng nhập trang khách hàng GHTK |
| `LASTSCANNED_API_KEY` | API key LastScanned — chỉ dùng cho mã SPX khi 17TRACK chưa có kết quả (không bắt buộc) | Tài khoản miễn phí tại app.lastscanned.com (5 lượt/ngày) hoặc gói Pro $4.99/tháng (1.000 lượt) |

Key chỉ được đọc bằng `process.env` trong code server (`api/_lib/tracking.ts`),
không hardcode, không gửi xuống trình duyệt. Chưa đặt key thì web vẫn chạy:
dải "Nguồn dữ liệu tra cứu" báo "chưa cấu hình", mã GHTK báo rõ thiếu
`GHTK_API_TOKEN`, mã lạ không tra trực tiếp được báo rõ thiếu `TRACK17_API_KEY`.

Lưu ý thật của hai API: tài khoản 17TRACK miễn phí có hạn mức số mã đăng ký;
API GHTK chỉ tra được đơn thuộc đúng shop đã cấp token và chỉ trả trạng thái
hiện tại (không có danh sách hành trình) — giao diện đã ghi rõ hai điểm này.

## Cách deploy

1. Tạo project trên Vercel (Import Git Repository, hoặc kéo thả / `vercel`
   CLI ngay trong thư mục này). Nếu import từ repo chứa cả artifact, đặt
   **Root Directory** trỏ vào thư mục `vercel-app` này.
2. Vercel tự nhận: Framework Preset **Vite**, Build Command `npm run build`,
   Output Directory `dist` (đã có trong `vercel.json` — không cần sửa).
3. Vào **Settings → Environment Variables**, thêm các biến ở bảng trên cho
   môi trường Production.
4. **Deploy** (lần đầu), rồi nếu vừa thêm/sửa biến môi trường thì
   **Redeploy** (Deployments → ⋯ → Redeploy) vì biến môi trường chỉ áp dụng
   cho bản build/deploy mới.
5. Mở link `*.vercel.app` được cấp, kiểm tra dải "Nguồn dữ liệu tra cứu"
   hiện "đã cấu hình" cho cả 17TRACK và GHTK (và LastScanned nếu có key),
   rồi thử một mã vận đơn thật.

Chạy thử ở máy local: `npm install`, tạo `.env.local` từ mẫu `.env.example`
(điền key thật, file này đã được .gitignore), `npm run dev` — lưu ý bản dev
của Vite không chạy được thư mục `api/`; muốn test cả API ở local thì dùng
`vercel dev`.

## Khác biệt so với bản artifact (do bản chất serverless)

- **Danh sách đơn đã lưu + ghi chú** nằm ở `localStorage` của trình duyệt
  từng người dùng (sản phẩm không có đăng nhập; mỗi người thấy danh sách
  của mình trên thiết bị của mình) thay vì database phía server như bản
  artifact. Tính năng giữ nguyên: tự lưu khi tra thành công, ghi chú, xóa,
  cập nhật từng đơn / tất cả.
- **Hạ nhiệt SPX 60 phút** giữ trong bộ nhớ của function instance nên là
  best-effort theo từng instance serverless (bản artifact lưu vào DB nên
  chặt hơn). Hành vi bề mặt không đổi: bị Shopee chặn thì ngừng gọi SPX
  một thời gian và báo số phút còn lại kèm link spx.vn/track.
