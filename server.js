import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { login, verifyToken } from "./auth.js";
import { getSchwabAuthUrl, exchangeCodeForTokens, getStoredTokens } from "./schwab.js";
import { getTrades, saveTrade, deleteTrade } from "./db.js";
import { startScheduler } from "./scheduler.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy so we get real client IPs for rate limiting
app.set('trust proxy', 1);

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

// Rate limiting — 100 requests per 15 minutes per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." },
}));

// ─── PUBLIC ROUTES (no auth required) ────────────────────────────────────────

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Login — returns JWT on success
app.post("/api/login", async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  const result = await login(password);
  if (!result.success) return res.status(401).json({ error: "Invalid password" });
  res.json({ token: result.token });
});

// Schwab OAuth callback — Schwab redirects here after user authorizes
app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing authorization code");
  try {
    await exchangeCodeForTokens(code);
    res.send(`
      <html><body style="font-family:monospace;background:#060910;color:#00e5a0;padding:40px;text-align:center">
        <h2>✓ Schwab Connected</h2>
        <p style="color:#4d6480">You can close this window and return to your journal.</p>
      </body></html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("Authorization failed. Check server logs.");
  }
});

// ─── PROTECTED ROUTES (JWT required) ─────────────────────────────────────────
app.use("/api", (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = auth.split(" ")[1];
  const valid = verifyToken(token);
  if (!valid) return res.status(401).json({ error: "Invalid or expired token" });
  next();
});

// Get Schwab OAuth URL (user clicks this to connect their account)
app.get("/api/schwab/auth-url", (req, res) => {
  const url = getSchwabAuthUrl();
  res.json({ url });
});

// Check if Schwab is connected
app.get("/api/schwab/status", async (req, res) => {
  const tokens = await getStoredTokens();
  const connected = !!tokens && Date.now() < tokens.refresh_expires_at;
  res.json({ connected });
});

// Get all trades
app.get("/api/trades", async (req, res) => {
  try {
    const trades = await getTrades();
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

// Manually add a trade
app.post("/api/trades", async (req, res) => {
  try {
    const trade = await saveTrade(req.body);
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: "Failed to save trade" });
  }
});

// Delete a trade
app.delete("/api/trades/:id", async (req, res) => {
  try {
    await deleteTrade(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete trade" });
  }
});

// Trigger a manual sync from Schwab
app.post("/api/sync", async (req, res) => {
  try {
    const { syncTrades } = await import("./scheduler.js");
    const count = await syncTrades();
    res.json({ success: true, newTrades: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Options Journal API running on port ${PORT}`);
  startScheduler();
});
