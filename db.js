import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// Simple file-based database — trades stored as JSON
// For scaling up later, swap this for SQLite or PostgreSQL
const DB_FILE = process.env.TRADES_FILE_PATH || path.resolve("./trades.json");

async function readDB() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeDB(trades) {
  await fs.writeFile(DB_FILE, JSON.stringify(trades, null, 2), "utf8");
}

// ─── GET ALL TRADES ───────────────────────────────────────────────────────────
export async function getTrades() {
  const trades = await readDB();
  return trades.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// ─── SAVE / UPSERT A TRADE ────────────────────────────────────────────────────
export async function saveTrade(trade) {
  const trades = await readDB();
  const existing = trades.findIndex(t => t.id === trade.id);

  const normalized = {
    id:         trade.id || randomUUID(),
    date:       trade.date,
    ticker:     trade.ticker?.toUpperCase(),
    type:       trade.type,       // Call | Put
    strike:     Number(trade.strike),
    expiry:     trade.expiry,
    premium:    Number(trade.premium),
    contracts:  Number(trade.contracts) || 1,
    closePrice: trade.closePrice != null ? Number(trade.closePrice) : null,
    status:     trade.status || "Open",
    strategy:   trade.strategy || `Long ${trade.type}`,
    delta:      trade.delta   != null ? Number(trade.delta)   : null,
    gamma:      trade.gamma   != null ? Number(trade.gamma)   : null,
    theta:      trade.theta   != null ? Number(trade.theta)   : null,
    vega:       trade.vega    != null ? Number(trade.vega)    : null,
    iv:         trade.iv      != null ? Number(trade.iv)      : null,
    notes:      trade.notes   || "",
    source:     trade.source  || "manual", // "manual" | "schwab"
    updatedAt:  new Date().toISOString(),
  };

  if (existing >= 0) {
    trades[existing] = normalized;
  } else {
    trades.push(normalized);
  }

  await writeDB(trades);
  return normalized;
}

// ─── DELETE A TRADE ───────────────────────────────────────────────────────────
export async function deleteTrade(id) {
  const trades = await readDB();
  const filtered = trades.filter(t => t.id !== id);
  await writeDB(filtered);
  return { deleted: trades.length - filtered.length };
}

// ─── GET LAST SYNC TIME ───────────────────────────────────────────────────────
export async function getLastSyncTime() {
  const trades = await readDB();
  const schwabTrades = trades.filter(t => t.source === "schwab");
  if (!schwabTrades.length) return null;
  return schwabTrades
    .map(t => t.updatedAt)
    .sort()
    .reverse()[0];
}
