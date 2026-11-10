// GET  /api/auth  -> who is logged in
// POST /api/auth  -> { action: "signup" | "login" | "logout", email, password }
import { sql, setup, hashPassword, checkPassword, startSession, endSession, getUser, publicUser } from "./_lib.js";

export default async function handler(req, res) {
  try {
    await setup();

    if (req.method === "GET") {
      return res.json({ user: publicUser(await getUser(req)) });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed." });
    }

    const { action, password } = req.body || {};
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (action === "logout") {
      await endSession(req, res);
      return res.json({ user: null });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== "string") {
      return res.status(400).json({ error: "Enter a valid email and password." });
    }

    if (action === "signup") {
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
      }
      const rows = await sql`INSERT INTO users (email, password_hash)
        VALUES (${email}, ${hashPassword(password)})
        ON CONFLICT (email) DO NOTHING
        RETURNING id, email, is_premium`;
      if (!rows[0]) {
        return res.status(409).json({ error: "An account with that email already exists. Try logging in." });
      }
      await startSession(res, rows[0].id);
      return res.json({ user: publicUser(rows[0]) });
    }

    if (action === "login") {
      const rows = await sql`SELECT id, email, is_premium, password_hash FROM users WHERE email = ${email}`;
      if (!rows[0] || !checkPassword(password, rows[0].password_hash)) {
        return res.status(401).json({ error: "Wrong email or password." });
      }
      await startSession(res, rows[0].id);
      return res.json({ user: publicUser(rows[0]) });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
