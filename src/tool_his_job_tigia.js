import pg from "pg";

const { Pool } = pg;

const VCB_API = "https://www.vietcombank.com.vn/api/exchangerates";
const CURRENCY = "USD";
const TIMEZONE = "Asia/Ho_Chi_Minh";

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "TTT",
  password: "123456",
  port: 5432,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function todayInVietnam() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "vietcombank-tygia/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchUsdRateWithRetry(date, retries = 2) {
  const url = `${VCB_API}?date=${encodeURIComponent(date)}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const payload = await fetchJson(url);
      const rows = Array.isArray(payload?.Data) ? payload.Data : [];
      const usd = rows.find((row) => row.currencyCode === CURRENCY);

      if (!usd) {
        throw new Error(`Không tìm thấy tỉ giá ${CURRENCY} trong dữ liệu trả về`);
      }

      return {
        bank: "Vietcombank",
        currency: CURRENCY,
        currencyName: usd.currencyName,
        date: payload.Date ?? `${date}T00:00:00`,
        updatedAt: payload.UpdatedDate ?? null,
        fetchedAt: new Date().toISOString(),
        rates: {
          buyCash: parseNumber(usd.cash),
          buyTransfer: parseNumber(usd.transfer),
          sell: parseNumber(usd.sell),
        },
        source: url,
      };
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      console.warn(`[Cảnh báo] Lỗi khi lấy tỉ giá ngày ${date} (Lần thử ${attempt}/${retries}): ${err.message}. Đang thử lại...`);
      await sleep(1000);
    }
  }
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "tTiGia" (
      id SERIAL PRIMARY KEY,
      bank TEXT NOT NULL,
      currency TEXT NOT NULL,
      "currencyName" TEXT,
      date TIMESTAMPTZ,
      "updatedAt" TEXT,
      "fetchedAt" TIMESTAMPTZ,
      "buyCash" NUMERIC,
      "buyTransfer" NUMERIC,
      sell NUMERIC,
      source TEXT,
      UNIQUE (currency, date)
    )
  `);
}

function generateDateRange() {
  const dates = [];
  const today = new Date(todayInVietnam());
  // Lấy 365 ngày trở về trước (tổng cộng 366 ngày bao gồm cả ngày hiện tại)
  for (let i = 0; i <= 365; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates.reverse(); // Sắp xếp từ cũ nhất đến mới nhất
}

async function insertRate(result) {
  const values = [
    result.bank,
    result.currency,
    result.currencyName,
    result.date,
    result.updatedAt,
    result.fetchedAt,
    result.rates.buyCash,
    result.rates.buyTransfer,
    result.rates.sell,
    result.source,
  ];

  const res = await pool.query(
    `INSERT INTO "tTiGia" (
       bank, currency, "currencyName", date, "updatedAt", "fetchedAt",
       "buyCash", "buyTransfer", sell, source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (currency, date) DO NOTHING
     RETURNING id`,
    values
  );
  return res.rows[0]?.id || null;
}

async function main() {
  console.log("=== BẮT ĐẦU LẤY LỊCH SỬ TỈ GIÁ USD (1 NĂM TRỞ VỀ TRƯỚC) ===");
  
  await ensureTable();

  // 1. Tạo danh sách ngày cần kiểm tra
  const allDates = generateDateRange();
  console.log(`Đã tạo dải ngày từ ${allDates[0]} đến ${allDates[allDates.length - 1]} (${allDates.length} ngày)`);

  // 2. Truy vấn các ngày đã có trong database để lọc bớt
  const existingDatesRes = await pool.query(`
    SELECT DISTINCT TO_CHAR(date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as date_str
    FROM "tTiGia"
    WHERE currency = $1
  `, [CURRENCY]);
  const existingDates = new Set(existingDatesRes.rows.map(row => row.date_str));
  console.log(`Đã tìm thấy ${existingDates.size} ngày đã có dữ liệu trong database.`);

  const missingDates = allDates.filter(d => !existingDates.has(d));
  console.log(`Số ngày cần lấy dữ liệu mới: ${missingDates.length} ngày`);

  if (missingDates.length === 0) {
    console.log("Tất cả các ngày đã có đủ dữ liệu. Hoàn thành!");
    return;
  }

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < missingDates.length; i++) {
    const dateStr = missingDates[i];
    const progress = `[${i + 1}/${missingDates.length}]`;
    
    try {
      console.log(`${progress} Đang lấy tỉ giá cho ngày ${dateStr}...`);
      const fx = await fetchUsdRateWithRetry(dateStr);
      
      const insertId = await insertRate(fx);
      if (insertId) {
        console.log(`  => Thành công! Đã INSERT vào tTiGia, id = ${insertId} (Mua TM: ${fx.rates.buyCash} | Bán: ${fx.rates.sell})`);
        successCount++;
      } else {
        console.log(`  => Ngày ${dateStr} đã tồn tại trong DB (do conflict kiểm tra muộn). Bỏ qua.`);
        skipCount++;
      }
    } catch (err) {
      console.error(`  => [Lỗi] Không lấy được tỉ giá ngày ${dateStr}: ${err.message}`);
      failCount++;
    }

    // Tránh spam API quá nhanh
    if (i < missingDates.length - 1) {
      await sleep(300);
    }
  }

  console.log("\n=== KẾT QUẢ THỰC HIỆN ===");
  console.log(`- Tổng số ngày cần lấy: ${missingDates.length}`);
  console.log(`- Thành công (đã insert): ${successCount}`);
  console.log(`- Bỏ qua (đã trùng): ${skipCount}`);
  console.log(`- Thất bại (lỗi API/mạng): ${failCount}`);
  console.log("=========================================");
}

main()
  .catch((err) => {
    console.error("Job history thất bại:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
