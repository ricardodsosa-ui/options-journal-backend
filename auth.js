import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = "7d"; // Stay logged in for 7 days

// The journal password is stored as a bcrypt hash in your .env
// Generate it once by running: node -e "require('bcrypt').hash('yourpassword',12).then(console.log)"
const PASSWORD_HASH  = process.env.JOURNAL_PASSWORD_HASH;

if (!JWT_SECRET)      console.warn("⚠ JWT_SECRET not set in .env");
if (!PASSWORD_HASH)   console.warn("⚠ JOURNAL_PASSWORD_HASH not set in .env");

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export async function login(password) {
  if (!PASSWORD_HASH) return { success: false };
  const match = await bcrypt.compare(password, PASSWORD_HASH);
  if (!match) return { success: false };

  const token = jwt.sign(
    { role: "owner", iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return { success: true, token };
}

// ─── VERIFY TOKEN ─────────────────────────────────────────────────────────────
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── GENERATE PASSWORD HASH (utility — run once during setup) ─────────────────
// Usage: node -e "import('./auth.js').then(m => m.hashPassword('yourpassword'))"
export async function hashPassword(password) {
  const hash = await bcrypt.hash(password, 12);
  console.log("\nAdd this to your .env file:");
  console.log(`JOURNAL_PASSWORD_HASH=${hash}\n`);
  return hash;
}
