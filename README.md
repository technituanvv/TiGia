# vietcombank-tygia

Job Node.js lấy tỉ giá **USD** ngày hiện tại (múi giờ `Asia/Ho_Chi_Minh`) từ API công khai của Vietcombank.

## Yêu cầu

- Node.js 18 trở lên (dùng `fetch` có sẵn)

## Chạy job

```bash
npm start
```

Kết quả in ra console và lưu file `data/usd-YYYY-MM-DD.json`.

## Lịch chạy (Windows Task Scheduler)

Ví dụ chạy mỗi ngày lúc 09:00:

```powershell
schtasks /Create /TN "VCB-USD-Rate" /SC DAILY /ST 09:00 /TR "node C:\Users\Admin\vietcombank-tygia\src\job.js" /F
```

## Nguồn dữ liệu

`https://www.vietcombank.com.vn/api/exchangerates?date=YYYY-MM-DD`
