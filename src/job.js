import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const VCB_API = "https://www.vietcombank.com.vn/api/exchangerates";
const GOLD_API = "https://api.goldprice.dev/v1/prices?symbol=XAU-USD-SPOT";
const GOLD_API_FALLBACK = "https://xaus.com/api/v1/spot";
const DOMESTIC_GOLD_API = "https://giavang.now/api/prices";
const TIMEZONE = "Asia/Ho_Chi_Minh";
const CURRENCY = "USD";
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const GRAMS_PER_LUONG = 37.5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "TTT",
  password: "123456",
  port: 5432,
});

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

function round(value, digits) {
  if (value == null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "vietcombank-tygia/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }

  return res.json();
}

async function fetchUsdRate(date) {
  const url = `${VCB_API}?date=${encodeURIComponent(date)}`;
  const payload = await fetchJson(url);
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

async function fetchGoldSpotUsdOz() {
  try {
    const payload = await fetchJson(GOLD_API);
    const spot = Array.isArray(payload?.symbols) ? payload.symbols[0] : null;
    const priceUsdOz = parseNumber(spot?.price);

    if (priceUsdOz == null) {
      throw new Error("goldprice.dev không trả price");
    }

    return {
      priceUsdOz,
      bidUsdOz: parseNumber(spot.bid),
      askUsdOz: parseNumber(spot.ask),
      updatedAt: spot.computed_at ?? null,
      source: GOLD_API,
    };
  } catch (err) {
    const payload = await fetchJson(GOLD_API_FALLBACK);
    const priceUsdOz = parseNumber(payload?.spot_usd_oz ?? payload?.xau?.price);

    if (priceUsdOz == null) {
      throw new Error(`Không lấy được giá vàng thế giới: ${err.message}`);
    }

    return {
      priceUsdOz,
      bidUsdOz: null,
      askUsdOz: null,
      updatedAt: payload.updated_at ?? null,
      source: GOLD_API_FALLBACK,
    };
  }
}

function pickDealer(prices, codes) {
  for (const code of codes) {
    const row = prices?.[code];
    const buy = parseNumber(row?.buy);
    const sell = parseNumber(row?.sell);
    if (buy != null || sell != null) {
      return {
        code,
        name: row.name ?? code,
        buy,
        sell,
      };
    }
  }
  throw new Error(`Không tìm thấy giá vàng ${codes.join("/")}`);
}

async function fetchDomesticDealers() {
  const payload = await fetchJson(DOMESTIC_GOLD_API);
  const prices = payload?.prices ?? {};

  return {
    date: payload.date ?? null,
    time: payload.time ?? null,
    source: DOMESTIC_GOLD_API,
    sjc: pickDealer(prices, ["SJL1L10", "SJ9999"]),
    doji: pickDealer(prices, ["DOHCML", "DOHNL"]),
    pnj: pickDealer(prices, ["PQHNVM", "PQHN24NTT"]),
  };
}

function buildGoldPrice(spot, usdSell, dealers, date) {
  if (usdSell == null) {
    throw new Error("Thiếu tỉ giá bán USD Vietcombank để quy đổi giá vàng");
  }

  const priceUsdPerGram = spot.priceUsdOz / GRAMS_PER_TROY_OUNCE;
  const priceUsdPerLuong = priceUsdPerGram * GRAMS_PER_LUONG;
  const priceVndPerLuong = priceUsdPerLuong * usdSell;

  const diffDojiSellAbs = dealers.doji.sell != null ? Math.round(dealers.doji.sell - priceVndPerLuong) : null;
  const diffDojiSellPct = dealers.doji.sell != null ? round((diffDojiSellAbs / priceVndPerLuong) * 100, 2) : null;

  return {
    date: `${date}T00:00:00`,
    metal: "XAU",
    unit: "luong",
    gramsPerTroyOunce: GRAMS_PER_TROY_OUNCE,
    gramsPerLuong: GRAMS_PER_LUONG,
    priceUsdOz: round(spot.priceUsdOz, 4),
    bidUsdOz: spot.bidUsdOz == null ? null : round(spot.bidUsdOz, 4),
    askUsdOz: spot.askUsdOz == null ? null : round(spot.askUsdOz, 4),
    usdSellVcb: usdSell,
    priceUsdPerGram: round(priceUsdPerGram, 6),
    priceUsdPerLuong: round(priceUsdPerLuong, 4),
    priceVndPerLuong: Math.round(priceVndPerLuong),
    sjcName: dealers.sjc.name,
    sjcBuy: dealers.sjc.buy,
    sjcSell: dealers.sjc.sell,
    dojiName: dealers.doji.name,
    dojiBuy: dealers.doji.buy,
    dojiSell: dealers.doji.sell,
    pnjName: dealers.pnj.name,
    pnjBuy: dealers.pnj.buy,
    pnjSell: dealers.pnj.sell,
    diffDojiSellAbs,
    diffDojiSellPct,
    dealersUpdatedAt: dealers.date && dealers.time ? `${dealers.date} ${dealers.time}` : dealers.date,
    updatedAt: spot.updatedAt,
    fetchedAt: new Date().toISOString(),
    source: spot.source,
    dealersSource: dealers.source,
  };
}

async function ensureTables() {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "tGiaVang" (
      id SERIAL PRIMARY KEY,
      date TIMESTAMPTZ,
      metal TEXT NOT NULL,
      unit TEXT NOT NULL,
      "gramsPerTroyOunce" NUMERIC,
      "gramsPerLuong" NUMERIC,
      "priceUsdOz" NUMERIC,
      "bidUsdOz" NUMERIC,
      "askUsdOz" NUMERIC,
      "usdSellVcb" NUMERIC,
      "priceUsdPerGram" NUMERIC,
      "priceUsdPerLuong" NUMERIC,
      "priceVndPerLuong" NUMERIC,
      "sjcName" TEXT,
      "sjcBuy" NUMERIC,
      "sjcSell" NUMERIC,
      "dojiName" TEXT,
      "dojiBuy" NUMERIC,
      "dojiSell" NUMERIC,
      "pnjName" TEXT,
      "pnjBuy" NUMERIC,
      "pnjSell" NUMERIC,
      "diffDojiSellAbs" NUMERIC,
      "diffDojiSellPct" NUMERIC,
      "dealersUpdatedAt" TEXT,
      "dealersSource" TEXT,
      "updatedAt" TEXT,
      "fetchedAt" TIMESTAMPTZ,
      source TEXT
    )
  `);

  const goldColumns = [
    ["sjcName", "TEXT"],
    ["sjcBuy", "NUMERIC"],
    ["sjcSell", "NUMERIC"],
    ["dojiName", "TEXT"],
    ["dojiBuy", "NUMERIC"],
    ["dojiSell", "NUMERIC"],
    ["pnjName", "TEXT"],
    ["pnjBuy", "NUMERIC"],
    ["pnjSell", "NUMERIC"],
    ["diffDojiSellAbs", "NUMERIC"],
    ["diffDojiSellPct", "NUMERIC"],
    ["dealersUpdatedAt", "TEXT"],
    ["dealersSource", "TEXT"],
  ];

  for (const [name, type] of goldColumns) {
    await pool.query(`ALTER TABLE "tGiaVang" ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
  }
}

async function upsertByDate(table, businessDate, extraWhere, extraParams, values, updateSql, insertSql) {
  const existing = await pool.query(
    `SELECT id
     FROM ${table}
     WHERE date::date = $1::date
       ${extraWhere}
     ORDER BY id
     LIMIT 1`,
    [businessDate, ...extraParams]
  );

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await pool.query(updateSql, [...values, id]);
    return { id, action: "update" };
  }

  const inserted = await pool.query(insertSql, values);
  return { id: inserted.rows[0].id, action: "insert" };
}

async function upsertRate(result, businessDate) {
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

  return upsertByDate(
    '"tTiGia"',
    businessDate,
    "AND currency = $2",
    [result.currency],
    values,
    `UPDATE "tTiGia" SET
       bank = $1,
       currency = $2,
       "currencyName" = $3,
       date = $4,
       "updatedAt" = $5,
       "fetchedAt" = $6,
       "buyCash" = $7,
       "buyTransfer" = $8,
       sell = $9,
       source = $10
     WHERE id = $11`,
    `INSERT INTO "tTiGia" (
       bank, currency, "currencyName", date, "updatedAt", "fetchedAt",
       "buyCash", "buyTransfer", sell, source
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`
  );
}

async function upsertGold(result, businessDate) {
  const values = [
    result.date,
    result.metal,
    result.unit,
    result.gramsPerTroyOunce,
    result.gramsPerLuong,
    result.priceUsdOz,
    result.bidUsdOz,
    result.askUsdOz,
    result.usdSellVcb,
    result.priceUsdPerGram,
    result.priceUsdPerLuong,
    result.priceVndPerLuong,
    result.sjcName,
    result.sjcBuy,
    result.sjcSell,
    result.dojiName,
    result.dojiBuy,
    result.dojiSell,
    result.pnjName,
    result.pnjBuy,
    result.pnjSell,
    result.diffDojiSellAbs,
    result.diffDojiSellPct,
    result.dealersUpdatedAt,
    result.dealersSource,
    result.updatedAt,
    result.fetchedAt,
    result.source,
  ];

  return upsertByDate(
    '"tGiaVang"',
    businessDate,
    "",
    [],
    values,
    `UPDATE "tGiaVang" SET
       date = $1,
       metal = $2,
       unit = $3,
       "gramsPerTroyOunce" = $4,
       "gramsPerLuong" = $5,
       "priceUsdOz" = $6,
       "bidUsdOz" = $7,
       "askUsdOz" = $8,
       "usdSellVcb" = $9,
       "priceUsdPerGram" = $10,
       "priceUsdPerLuong" = $11,
       "priceVndPerLuong" = $12,
       "sjcName" = $13,
       "sjcBuy" = $14,
       "sjcSell" = $15,
       "dojiName" = $16,
       "dojiBuy" = $17,
       "dojiSell" = $18,
       "pnjName" = $19,
       "pnjBuy" = $20,
       "pnjSell" = $21,
       "diffDojiSellAbs" = $22,
       "diffDojiSellPct" = $23,
       "dealersUpdatedAt" = $24,
       "dealersSource" = $25,
       "updatedAt" = $26,
       "fetchedAt" = $27,
       source = $28
     WHERE id = $29`,
    `INSERT INTO "tGiaVang" (
       date, metal, unit, "gramsPerTroyOunce", "gramsPerLuong",
       "priceUsdOz", "bidUsdOz", "askUsdOz", "usdSellVcb",
       "priceUsdPerGram", "priceUsdPerLuong", "priceVndPerLuong",
       "sjcName", "sjcBuy", "sjcSell",
       "dojiName", "dojiBuy", "dojiSell",
       "pnjName", "pnjBuy", "pnjSell",
       "diffDojiSellAbs", "diffDojiSellPct",
       "dealersUpdatedAt", "dealersSource",
       "updatedAt", "fetchedAt", source
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
     )
     RETURNING id`
  );
}

function logUpsert(table, date, id, action) {
  console.log(
    action === "update"
      ? `Ngày ${date} đã có dữ liệu — đã UPDATE bảng "${table}", giữ nguyên id = ${id}`
      : `Ngày ${date} chưa có dữ liệu — đã INSERT bảng "${table}", id = ${id}`
  );
}

async function main() {
  const date = todayInVietnam();
  const fx = await fetchUsdRate(date);
  const spot = await fetchGoldSpotUsdOz();
  const dealers = await fetchDomesticDealers();
  const gold = buildGoldPrice(spot, fx.rates.sell, dealers, date);

  await mkdir(DATA_DIR, { recursive: true });
  const fxFile = join(DATA_DIR, `usd-${date}.json`);
  const goldFile = join(DATA_DIR, `gold-${date}.json`);
  await writeFile(fxFile, `${JSON.stringify(fx, null, 2)}\n`, "utf8");
  await writeFile(goldFile, `${JSON.stringify(gold, null, 2)}\n`, "utf8");

  await ensureTables();
  const fxUpsert = await upsertRate(fx, date);
  const goldUpsert = await upsertGold(gold, date);

  console.log(
    `[${date}] USD/VND Vietcombank — mua TM: ${fx.rates.buyCash} | mua CK: ${fx.rates.buyTransfer} | bán: ${fx.rates.sell}`
  );
  console.log(`Đã lưu file: ${fxFile}`);
  logUpsert("tTiGia", date, fxUpsert.id, fxUpsert.action);

  console.log(
    `[${date}] Vàng thế giới — ${gold.priceUsdOz} USD/oz | bán USD VCB ${gold.usdSellVcb} | ${gold.priceVndPerLuong.toLocaleString("vi-VN")} VND/lượng (37.5g)`
  );
  console.log(
    `[${date}] SJC mua ${gold.sjcBuy?.toLocaleString("vi-VN")} / bán ${gold.sjcSell?.toLocaleString("vi-VN")} | DOJI mua ${gold.dojiBuy?.toLocaleString("vi-VN")} / bán ${gold.dojiSell?.toLocaleString("vi-VN")} | PNJ mua ${gold.pnjBuy?.toLocaleString("vi-VN")} / bán ${gold.pnjSell?.toLocaleString("vi-VN")}`
  );
  if (gold.diffDojiSellAbs != null) {
    console.log(
      `[${date}] Chênh lệch DOJI bán ra so với thế giới: ${gold.diffDojiSellAbs.toLocaleString("vi-VN")} VND/lượng (${gold.diffDojiSellPct}%)`
    );
  }
  console.log(`Đã lưu file: ${goldFile}`);
  logUpsert("tGiaVang", date, goldUpsert.id, goldUpsert.action);

  console.log(JSON.stringify({ fx, gold }, null, 2));
}

main()
  .catch((err) => {
    console.error("Job thất bại:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
