// Shared helpers for the API. Vercel does not turn files starting with "_" into pages.
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

export const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

const SESSION_DAYS = 30;
let ready = null;

// Creates the tables the first time the API runs, so there is no separate setup step.
export function setup() {
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_premium BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS ai_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    })().catch(error => { ready = null; throw error; });
  }
  return ready;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const attempt = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(attempt, Buffer.from(hash, "hex"));
}

// Only a hash of the token is stored, so a leaked database can't be used to log in.
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");

export async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, NOW() + make_interval(days => ${SESSION_DAYS}))`;
  res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}

export async function endSession(req, res) {
  const token = req.cookies?.session;
  if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}

// Returns the logged-in user, or null.
export async function getUser(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  const rows = await sql`SELECT users.id, users.email, users.is_premium FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${hashToken(token)} AND sessions.expires_at > NOW()`;
  return rows[0] || null;
}

export const publicUser = user => user && { email: user.email, isPremium: user.is_premium };
