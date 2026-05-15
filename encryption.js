import crypto from "crypto";

// 32-byte key required for AES-256
// Set ENCRYPTION_KEY in .env as a 64-character hex string
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const ALGORITHM  = "aes-256-gcm";
const KEY_HEX    = process.env.ENCRYPTION_KEY;

function getKey() {
  if (!KEY_HEX || KEY_HEX.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string in .env");
  }
  return Buffer.from(KEY_HEX, "hex");
}

// ─── ENCRYPT ─────────────────────────────────────────────────────────────────
export function encrypt(plaintext) {
  const key  = getKey();
  const iv   = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Store as: iv:authTag:encryptedData (all hex)
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

// ─── DECRYPT ─────────────────────────────────────────────────────────────────
export function decrypt(ciphertext) {
  const key = getKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");

  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid encrypted token format");
  }

  const iv        = Buffer.from(ivHex, "hex");
  const authTag   = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}
