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

    // Sort orders by date — oldest first, so FIFO matching works correctly
    orders.sort((a, b) => new Date(a.enteredTime) - new Date(b.enteredTime));

    for (const order of orders) {
      const parsed = parseOrderToTrade(order);
      if (!parsed) continue;

      if (parsed.action === "BUY") {
        // Buy-to-open: create a new open trade row
        await saveTrade({
          id:         parsed.orderId,
          date:       parsed.date,
          ticker:     parsed.ticker,
          type:       parsed.type,
          strike:     parsed.strike,
          expiry:     parsed.expiry,
          premium:    parsed.price,
          contracts:  parsed.contracts,
          openAction: "BUY",
          status:     "Open",
          strategy:   `Long ${parsed.type}`,
          source:     "schwab",
        });

        // Enrich with Greeks (best-effort)
        try {
          const chain = await getOptionsChain(parsed.ticker);
          const g = extractGreeks(chain, parsed);
          if (g) {
            await saveTrade({
              id: parsed.orderId,
              date: parsed.date, ticker: parsed.ticker, type: parsed.type,
              strike: parsed.strike, expiry: parsed.expiry,
              premium: parsed.price, contracts: parsed.contracts,
              openAction: "BUY", status: "Open", strategy: `Long ${parsed.type}`,
              source: "schwab",
              delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, iv: g.volatility,
            });
          }
        } catch {}

        saved++;
      } else {
        // Sell-to-close: match against oldest open trades for this contract (FIFO)
        const allTrades = await getTrades();
        const matches = allTrades
          .filter(t =>
            t.status === "Open" &&
            t.ticker === parsed.ticker &&
            t.type === parsed.type &&
            Number(t.strike) === parsed.strike &&
            t.expiry === parsed.expiry &&
            t.openAction === "BUY"
          )
          .sort((a, b) => new Date(a.date) - new Date(b.date)); // oldest first

        let remaining = parsed.contracts;
        for (const openTrade of matches) {
          if (remaining <= 0) break;
          const fillQty = Math.min(remaining, openTrade.contracts);

          if (fillQty === openTrade.contracts) {
            // Fully close this lot
            await saveTrade({
              ...openTrade,
              closePrice: parsed.price,
              closeDate:  parsed.date,
              status:     "Closed",
            });
          } else {
            // Partial close: split the lot into closed portion + remaining open portion
            await saveTrade({
              ...openTrade,
              contracts:  fillQty,
              closePrice: parsed.price,
              closeDate:  parsed.date,
              status:     "Closed",
              id:         `${openTrade.id}-close-${parsed.orderId}`,
            });
            await saveTrade({
              ...openTrade,
              contracts: openTrade.contracts - fillQty,
            });
          }
          remaining -= fillQty;
          saved++;
        }

        if (remaining > 0) {
          console.warn(`⚠ Sell order ${parsed.orderId} for ${parsed.contracts} ${parsed.ticker} ${parsed.type} had ${remaining} unmatched contracts (no matching open position)`);
        }
      }
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
