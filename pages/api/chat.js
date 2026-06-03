import Anthropic from "@anthropic-ai/sdk";

const FREYJA_SYSTEM_PROMPT = `You are Freyja, the elite AI command center and personal assistant for Limor Zane, founder of BeautyAI, a luxury AI consulting agency in Palm Beach, Florida. Poised, intelligent, warm but efficient. World-class chief of staff who is also a strategic genius. Precise, elegant, occasionally witty. Never robotic. Keep conversational answers concise for voice. Full detail for documents and proposals. Never say certainly or great question, just answer with intelligence and grace. Sign off complex deliverables with Freyja. BeautyAI is luxury AI consulting for med spas, dermatology, cosmetic surgery, and beauty brands. Tagline: Where Intelligence Meets Beauty. Sub-brands: Beauty Intelligence consumer AI beauty app, Color Vault B2B SaaS for hair colorists at colorvaultbylimor.com. Active clients: Palm Beach Advanced Aesthetics contact Chase Backer trade client website rebuild in progress, Palm Beach Models PR contact Melissa Hornung European Summer Series campaign media kit in progress. Closed clients: Elevatione do not surface as open, Bespoke Capital was never a client. Three-pillar pricing: Foundation, Growth, Automation. Tools: GoHighLevel, ManyChat Pro, Netlify, Vercel, Supabase, Higgsfield, ElevenLabs, Canva, CapCut. Discovery-to-Proposal Agent saves to Gmail Drafts only never auto-sends. Draft all emails in Limors voice: warm, direct, luxury-positioned, Palm Beach adjacent.`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, sessionId, stream: useStream } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  let memoryContext = "";
  if (sessionId && process.env.UPSTASH_REDIS_REST_URL) {
    try {
      const { Redis } = await import("@upstash/redis");
      const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      const memory = await redis.get(`freyja:memory:${sessionId}`);
      if (memory) memoryContext = `\n\nCONVERSATION MEMORY:\n${memory}`;
    } catch (e) { console.error("Memory load error:", e.message); }
  }

  const systemPrompt = FREYJA_SYSTEM_PROMPT + memoryContext;

  try {
    if (useStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const stream = await client.messages.stream({ model: "claude-sonnet-4-20250514", max_tokens: 4096, system: systemPrompt, messages });
      let fullText = "";

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          fullText += chunk.delta.text;
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }

      res.write("data: [DONE]\n\n");
      res.end();

      if (sessionId && process.env.UPSTASH_REDIS_REST_URL && fullText) {
        try {
          const { Redis } = await import("@upstash/redis");
          const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
          const lastUserMsg = typeof messages[messages.length - 1]?.content === "string" ? messages[messages.length - 1].content : JSON.stringify(messages[messages.length - 1]?.content);
          const entry = `\n[User]: ${lastUserMsg}\n[Freyja]: ${fullText}`;
          const existing = (await redis.get(`freyja:memory:${sessionId}`)) || "";
          const updated = (existing + entry).slice(-8000);
          await redis.set(`freyja:memory:${sessionId}`, updated, { ex: 60 * 60 * 24 * 30 });
        } catch (e) { console.error("Memory save error:", e.message); }
      }
      return;
    }

    const response = await client.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 4096, system: systemPrompt, messages });
    const replyText = response.content[0]?.text || "";

    if (sessionId && process.env.UPSTASH_REDIS_REST_URL && replyText) {
      try {
        const { Redis } = await import("@upstash/redis");
        const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
        const lastUserMsg = typeof messages[messages.length - 1]?.content === "string" ? messages[messages.length - 1].content : JSON.stringify(messages[messages.length - 1]?.content);
        const entry = `\n[User]: ${lastUserMsg}\n[Freyja]: ${replyText}`;
        const existing = (await redis.get(`freyja:memory:${sessionId}`)) || "";
        const updated = (existing + entry).slice(-8000);
        await redis.set(`freyja:memory:${sessionId}`, updated, { ex: 60 * 60 * 24 * 30 });
      } catch (e) { console.error("Memory save error:", e.message); }
    }

    return res.status(200).json({ content: replyText, usage: response.usage });
  } catch (error) {
    console.error("Anthropic error:", error);
    return res.status(500).json({ error: "Anthropic API error", detail: error.message });
  }
}
