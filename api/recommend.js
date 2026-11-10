// POST /api/recommend  { request: "what the person likes, in their own words" }
// Asks Claude for personalized fragrance picks. Logged-in users only.
import Anthropic from "@anthropic-ai/sdk";
import { sql, setup, getUser } from "./_lib.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from Vercel's environment variables
const DAILY_LIMIT = 25; // per user, keeps API spending predictable

const SYSTEM = `You are the scent advisor for Fragrance Finder, a website that helps people find colognes and perfumes they'll love.
The person describes what they like, fragrances they already wear, who they're shopping for, or their budget.
Recommend 4 real, currently sold fragrances that fit. Where it fits their budget, include a niche or lesser-known option alongside well-known ones.
For each pick, explain in one or two plain sentences why it matches what they said, using their own words where you can.
Budget is a hard rule: if they name a price limit, or ask for something cheaper than a fragrance they mention, every pick must cost less than that. Good affordable houses include Zara, Montblanc, Nautica, Armaf, Lattafa, Rasasi and Al Haramain.
If they mention a fragrance they love but don't ask for cheaper, include at least one cheaper alternative with a similar feel, and don't recommend the fragrance they already own.
Price ranges are rough US retail for a full bottle, like "$80-$120". Only recommend fragrances you are confident exist under that exact name and brand; never invent one. Before answering, check each pick's price against their budget and swap out any that don't fit. If the request isn't about fragrance, set summary to a short friendly note asking them to describe scents they like, and return an empty picks list.`;

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences restating what they're looking for." },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          brand: { type: "string" },
          key_notes: { type: "array", items: { type: "string" } },
          why: { type: "string" },
          price_range: { type: "string" },
          best_for: { type: "string", description: "Season or occasion, a few words." }
        },
        required: ["name", "brand", "key_notes", "why", "price_range", "best_for"],
        additionalProperties: false
      }
    },
    tip: { type: "string", description: "One practical tip, such as how to sample before buying." }
  },
  required: ["summary", "picks", "tip"],
  additionalProperties: false
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await setup();
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Please log in to use the scent advisor." });

    const request = String(req.body?.request || "").trim();
    if (request.length < 5) return res.status(400).json({ error: "Tell us a little about what you like first." });
    if (request.length > 1500) return res.status(400).json({ error: "Please keep it under 1,500 characters." });

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM ai_requests
      WHERE user_id = ${user.id} AND created_at > NOW() - INTERVAL '1 day'`;
    if (count >= DAILY_LIMIT) {
      return res.status(429).json({ error: "You've reached today's limit of advisor requests. Come back tomorrow!" });
    }
    await sql`INSERT INTO ai_requests (user_id) VALUES (${user.id})`;

    const response = await client.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: request }]
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The advisor couldn't help with that. Try describing scents you like." });
    }
    const text = response.content.find(block => block.type === "text")?.text;
    if (response.stop_reason === "max_tokens" || !text) {
      return res.status(502).json({ error: "The advisor's answer got cut off. Please try again." });
    }
    return res.json(JSON.parse(text));
  } catch (error) {
    console.error(error);
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(503).json({ error: "The advisor is busy right now. Please try again in a minute." });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: "The advisor isn't set up yet (missing or invalid API key)." });
    }
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
