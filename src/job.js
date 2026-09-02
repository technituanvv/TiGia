import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VCB_API = "https://www.vietcombank.com.vn/api/exchangerates";
const TIMEZONE = "Asia/Ho_Chi_Minh";
const CURRENCY = "USD";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

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

async function fetchUsdRate(date) {
  const url = `${VCB_API}?date=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "vietcombank-tygia/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`Vietcombank API lỗi HTTP ${res.status} ${res.statusText}`);
  }

  const payload = await res.json();
  const rows = Array.isArray(payload?.Data) ? payload.Data : [];
  const usd = rows.find((row) => row.currencyCode === CURRENCY);

  if (!usd) {
    throw new Error(`Không tìm thấy tỉ giá ${CURRENCY} cho ngày ${date}`);
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
}

async function main() {
  const date = todayInVietnam();
  const result = await fetchUsdRate(date);

  await mkdir(DATA_DIR, { recursive: true });
  const outFile = join(DATA_DIR, `usd-${date}.json`);
  await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(
    `[${date}] USD/VND Vietcombank — mua TM: ${result.rates.buyCash} | mua CK: ${result.rates.buyTransfer} | bán: ${result.rates.sell}`
  );
  console.log(`Đã lưu: ${outFile}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Job thất bại:", err.message);
  process.exit(1);
});
