// POST /api/billing  { action: "checkout" }             -> { url } of a Stripe Checkout page
// POST /api/billing  { action: "confirm", sessionId }   -> marks the account Premium once Stripe says it's paid
import Stripe from "stripe";
import { sql, setup, getUser, publicUser } from "./_lib.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await setup();
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Please log in first." });

    const { action, sessionId } = req.body || {};

    if (action === "checkout") {
      if (user.is_premium) return res.status(400).json({ error: "You already have Premium." });
      const origin = `https://${req.headers.host}`;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer_email: user.email,
        client_reference_id: String(user.id),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 500,
            recurring: { interval: "month" },
            product_data: { name: "Fragrance Finder Premium" }
          }
        }],
        success_url: `${origin}/account.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/account.html`
      });
      return res.json({ url: session.url });
    }

    if (action === "confirm") {
      const session = await stripe.checkout.sessions.retrieve(String(sessionId || ""));
      // Only upgrade the account that started this checkout, and only once Stripe has the payment.
      if (session.client_reference_id !== String(user.id) || session.status !== "complete" || session.payment_status !== "paid") {
        return res.status(400).json({ error: "We couldn't confirm that payment." });
      }
      const rows = await sql`UPDATE users SET is_premium = TRUE WHERE id = ${user.id} RETURNING email, is_premium`;
      return res.json({ user: publicUser(rows[0]) });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Something went wrong with billing. Please try again." });
  }
}
