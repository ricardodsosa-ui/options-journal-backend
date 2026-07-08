import { getAccounts, getOptionsOrders, getOptionsChain, parseOrderToTrade, getStoredTokens } from "./schwab.js";
import { saveTrade, getLastSyncTime, getTrades } from "./db.js";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // Every 10 minutes

// ─── SYNC TRADES FROM SCHWAB ──────────────────────────────────────────────────
export async function syncTrades() {
  const tokens = await getStoredTokens();
  if (!tokens) {
    console.log("⚠ Schwab not connected — skipping sync");
    return 0;
  }

  console.log(`[${new Date().toISOString()}] Starting Schwab sync...`);

  try {
    // 1. Get account(s)
    const accounts = await getAccounts();
    if (!accounts?.length) {
      console.log("No accounts found");
      return 0;
    }

    // Use first account (most users have one)
    const accountId = accounts[0]?.hashValue;
    const lastSync  = await getLastSyncTime();

    // 2. Fetch filled options orders since last sync
    const orders = await getOptionsOrders(accountId, lastSync);
    console.log(`Found ${orders.length} options orders`);

    let saved = 0;
    const chainCache = {}; // one chain fetch per ticker per sync

    for (const order of orders) {
      const trade = parseOrderToTrade(order);
      if (!trade) continue;

      // 3. Try to enrich with Greeks from options chain
      try {
        if (!chainCache[trade.ticker]) {
          chainCache[trade.ticker] = await getOptionsChain(trade.ticker);
        }
        const greeks = extractGreeks(chainCache[trade.ticker], trade);
        if (greeks) {
          trade.delta = greeks.delta;
          trade.gamma = greeks.gamma;
          trade.theta = greeks.theta;
          trade.vega  = greeks.vega;
          trade.iv    = greeks.volatility;
        }
      } catch {
        // Greeks enrichment is best-effort — don't fail the sync
      }

      trade.source = "schwab";
      await saveTrade(trade);
      saved++;
    }

    console.log(`✓ Sync complete — saved ${saved} trades`);
    return saved;

  } catch (err) {
    console.error("Sync error:", err.message);
    console.error("Status:", err.response?.status);
    console.error("Schwab response:", JSON.stringify(err.response?.data));
    console.error("Failed URL:", err.config?.url);
    throw err;
  }
}

// ─── NEW: REFRESH GREEKS ON ALL OPEN POSITIONS ───────────────────────────────
// Called from POST /api/greeks/refresh. Works for BOTH schwab-synced and
// manually logged trades, as long as ticker/type/strike/expiry are filled in.
// Greeks change constantly, so this lets you pull current values on demand.
export async function refreshGreeks() {
  const tokens = await getStoredTokens();
  if (!tokens) throw new Error("Schwab not connected");

  const trades = await getTrades();
  const open = trades.filter(t => t.status === "Open" && t.ticker && t.expiry);

  const chainCache = {}; // one chain fetch per ticker
  let updated = 0;

  for (const trade of open) {
    try {
      if (!chainCache[trade.ticker]) {
        chainCache[trade.ticker] = await getOptionsChain(trade.ticker);
      }
      const greeks = extractGreeks(chainCache[trade.ticker], trade);
      if (greeks) {
        trade.delta = greeks.delta;
        trade.gamma = greeks.gamma;
        trade.theta = greeks.theta;
        trade.vega  = greeks.vega;
        trade.iv    = greeks.volatility;
        await saveTrade(trade);
        updated++;
      }
    } catch (err) {
      console.error(`Greeks refresh failed for ${trade.ticker}:`, err.message);
      // best-effort — continue with remaining positions
    }
  }

  console.log(`✓ Greeks refreshed on ${updated} open position${updated !== 1 ? "s" : ""}`);
  return updated;
}

// ─── EXTRACT GREEKS FROM CHAIN RESPONSE ──────────────────────────────────────
function extractGreeks(chain, trade) {
  const expKey  = trade.expiry; // "2025-05-16"
  const mapKey  = trade.type === "Call" ? "callExpDateMap" : "putExpDateMap";
  const dateMap = chain[mapKey];
  if (!dateMap) return null;

  // Find matching expiry (Schwab key format: "2025-05-16:30")
  const expEntry = Object.entries(dateMap).find(([k]) => k.startsWith(expKey));
  if (!expEntry) return null;

  const strikeMap = expEntry[1];
  const strikeKey = String(trade.strike.toFixed(1));
  const options   = strikeMap[strikeKey];
  if (!options?.length) return null;

  const opt = options[0];
  return {
    delta:      opt.delta,
    gamma:      opt.gamma,
    theta:      opt.theta,
    vega:       opt.vega,
    volatility: opt.volatility, // IV as decimal e.g. 0.25
  };
}

// ─── START BACKGROUND SCHEDULER ──────────────────────────────────────────────
export function startScheduler() {
  console.log(`✓ Scheduler started — syncing every ${POLL_INTERVAL_MS / 60000} minutes`);

  // Run immediately on startup
  syncTrades().catch(err => console.error("Initial sync failed:", err.message));

  // Then repeat on interval
  setInterval(() => {
    syncTrades().catch(err => console.error("Scheduled sync failed:", err.message));
  }, POLL_INTERVAL_MS);
}
