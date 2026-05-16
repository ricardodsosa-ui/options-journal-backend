import axios from "axios";
import { encrypt, decrypt } from "./encryption.js";
import fs from "fs/promises";
import path from "path";

const SCHWAB_BASE   = "https://api.schwabapi.com";
const TOKEN_FILE = process.env.TOKEN_FILE_PATH || path.resolve("./tokens.enc");
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
  await storeTokens(data);
  return data;
}

// ─── TOKEN STORAGE (AES-256 encrypted) ───────────────────────────────────────
async function storeTokens(tokens) {
  const payload = JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + tokens.expires_in * 1000,
    refresh_expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
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

  // Check if refresh token is expired (7 days)
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
    await storeTokens({ ...data, refresh_token: tokens.refresh_token });
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
export async function getOptionsOrders(accountId, fromDate) {
  const token = await getValidAccessToken();
  const from = fromDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
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
      params: { symbol, includeQuotes: true },
    }
  );
  return data;
}

// Fetch quote for a symbol (price, IV)
export async function getQuote(symbol) {
  const token = await getValidAccessToken();
  const { data } = await axios.get(
    `${SCHWAB_BASE}/marketdata/v1/${symbol}/quotes`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data;
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

  const isBuy = action.includes("BUY");
  return {
    orderId:    order.orderId,
    date:       order.enteredTime?.slice(0, 10),
    ticker,
    type,
    strike,
    expiry,
    price,
    contracts:  leg.quantity,
    action:     isBuy ? "BUY" : "SELL",
    notes:      "",
  };
}
