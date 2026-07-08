import axios from "axios";
import { encrypt, decrypt } from "./encryption.js";
import fs from "fs/promises";
import path from "path";

const SCHWAB_BASE   = "https://api.schwabapi.com";
const TOKEN_FILE    = process.env.TOKEN_FILE_PATH || path.resolve("./tokens.enc");
const REDIRECT_URI  = process.env.REDIRECT_URI || "http://localhost:3001/callback";
const CLIENT_ID     = process.env.SCHWAB_CLIENT_ID;
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET;

// ─── AUTH URL ─────────────────────────────────────────────────────────────────
export function getSchwabAuthUrl() {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         "readonly",
  });
  return `${SCHWAB_BASE}/v1/oauth/authorize?${params}`;
}

// ─── EXCHANGE CODE FOR TOKENS ─────────────────────────────────────────────────
export async function exchangeCodeForTokens(code) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const { data } = await axios.post(
    `${SCHWAB_BASE}/v1/oauth/token`,
    new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
    {
      headers: {
        Authorization:  `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  // Fresh authorization — start a new 7-day refresh window
  await storeTokens(data);
  return data;
}

// ─── TOKEN STORAGE (AES-256 encrypted) ───────────────────────────────────────
// FIX: existingRefreshExpiry is passed through on access-token refreshes so the
// 7-day refresh window is NOT reset every 30 minutes. Only a fresh OAuth
// authorization (exchangeCodeForTokens) starts a new 7-day window.
async function storeTokens(tokens, existingRefreshExpiry = null) {
  const payload = JSON.stringify({
    access_token:       tokens.access_token,
    refresh_token:      tokens.refresh_token,
    expires_at:         Date.now() + tokens.expires_in * 1000,
    refresh_expires_at: existingRefreshExpiry ?? Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  const encrypted = encrypt(payload);
  await fs.writeFile(TOKEN_FILE, encrypted, "utf8");
}

export async function getStoredTokens() {
  try {
    const encrypted = await fs.readFile(TOKEN_FILE, "utf8");
    const decrypted = decrypt(encrypted);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// ─── GET VALID ACCESS TOKEN (auto-refresh if expired) ────────────────────────
export async function getValidAccessToken() {
  const tokens = await getStoredTokens();
  if (!tokens) throw new Error("Schwab not connected. Visit /api/schwab/auth-url to authorize.");

  // Check if refresh token is expired (7 days from original authorization)
  if (Date.now() > tokens.refresh_expires_at) {
    throw new Error("Schwab refresh token expired. Please re-authorize at /api/schwab/auth-url");
  }

  // Refresh access token if expired (30 min)
  if (Date.now() > tokens.expires_at - 60000) {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const { data } = await axios.post(
      `${SCHWAB_BASE}/v1/oauth/token`,
      new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: tokens.refresh_token,
      }),
      {
        headers: {
          Authorization:  `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    // FIX: preserve the original refresh window instead of resetting it
    await storeTokens(
      { ...data, refresh_token: tokens.refresh_token },
      tokens.refresh_expires_at
    );
    return data.access_token;
  }

  return tokens.access_token;
}

// ─── SCHWAB API CALLS ─────────────────────────────────────────────────────────

// Fetch all accounts
export async function getAccounts() {
  const token = await getValidAccessToken();
  const { data } = await axios.get(`${SCHWAB_BASE}/trader/v1/accounts/accountNumbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

// Fetch orders for an account, filtered to options only
// FIX: Schwab's orders endpoint only accepts dates within 60 days of today,
// so the default lookback is now 59 days (was 90 — that caused 400 errors).
export async function getOptionsOrders(accountId, fromDate) {
  const token = await getValidAccessToken();
  const from = fromDate || new Date(Date.now() - 59 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await axios.get(
    `${SCHWAB_BASE}/trader/v1/accounts/${accountId}/orders`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        fromEnteredTime: from,
        toEnteredTime:   new Date().toISOString(),
        status:          "FILLED",
        maxResults:      500,
      },
    }
  );
  // Filter for options orders only
  return (data || []).filter(order =>
    order.orderLegCollection?.some(leg => leg.instrument?.assetType === "OPTION")
  );
}

// Fetch options chain (includes Greeks + IV)
export async function getOptionsChain(symbol) {
  const token = await getValidAccessToken();
  const { data } = await axios.get(
    `${SCHWAB_BASE}/marketdata/v1/chains`,
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { symbol },
    }
  );
  return data;
}

// ─── NEW: DAILY PRICE HISTORY (real candles for RSI/SMA) ─────────────────────
// Returns [{ date: "2026-07-07", close: 560.12 }, ...] — newest last.
export async function getPriceHistory(symbol, months = 3) {
  const token = await getValidAccessToken();
  const { data } = await axios.get(`${SCHWAB_BASE}/marketdata/v1/pricehistory`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      symbol:        symbol.toUpperCase(),
      periodType:    "month",
      period:        months,        // 1, 2, 3, or 6
      frequencyType: "daily",
      frequency:     1,
    },
  });

  return (data?.candles || []).map(c => ({
    date:  new Date(c.datetime).toISOString().slice(0, 10),
    close: c.close,
  }));
}

// ─── NEW: REAL-TIME QUOTE (fixed endpoint) ───────────────────────────────────
// Uses the bulk quotes endpoint, which handles all symbol types safely.
// Returns { symbol, price, change, changePercent, high, low, volume } or null.
export async function getQuote(symbol) {
  const token = await getValidAccessToken();
  const sym = symbol.toUpperCase();
  const { data } = await axios.get(`${SCHWAB_BASE}/marketdata/v1/quotes`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { symbols: sym },
  });

  const q = data?.[sym]?.quote;
  if (!q) return null;

  return {
    symbol:        sym,
    price:         q.lastPrice,
    change:        q.netChange,
    changePercent: q.netPercentChange,
    high:          q.highPrice,
    low:           q.lowPrice,
    volume:        q.totalVolume,
  };
}

// ─── PARSE SCHWAB ORDER → TRADE OBJECT ───────────────────────────────────────
export function parseOrderToTrade(order) {
  const leg = order.orderLegCollection?.[0];
  if (!leg) return null;
  const instrument = leg.instrument;
  const symbol = instrument?.symbol || "";

  // Parse OCC option symbol: e.g. SPY   250117C00590000
  const match = symbol.match(/^([A-Z]+)\s+(\d{6})([CP])(\d{8})$/);
  if (!match) return null;

  const [, ticker, dateStr, typeChar, strikeRaw] = match;
  const expiry = `20${dateStr.slice(0,2)}-${dateStr.slice(2,4)}-${dateStr.slice(4,6)}`;
  const strike = parseInt(strikeRaw) / 1000;
  const type   = typeChar === "C" ? "Call" : "Put";
  const action = leg.instruction; // BUY_TO_OPEN, SELL_TO_CLOSE, etc.
  const price  = order.price || order.orderActivityCollection?.[0]?.executionLegs?.[0]?.price || 0;

  return {
    id:        order.orderId,
    date:      order.enteredTime?.slice(0, 10),
    ticker,
    type,
    strike,
    expiry,
    premium:   action.includes("BUY") ? price : null,
    closePrice: action.includes("SELL") ? price : null,
    contracts: leg.quantity,
    status:    action.includes("BUY") ? "Open" : "Closed",
    strategy:  `Long ${type}`,
    notes:     "",
    // Greeks populated separately via getOptionsChain
    delta: null, gamma: null, theta: null, vega: null, iv: null,
  };
}
