import { Redis } from "@upstash/redis";

const KEY_PREFIX = "freyja:memory:";
const TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_MEMORY_CHARS = 10000;

function getRedisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in environment variables");
  }
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const { sessionId } = req.query;
  if (!sessionId || typeof sessionId !== "string" || sessionId.trim() === "") {
    return res.status(400).json({ error: "sessionId query parameter is required" });
  }

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  const key = `${KEY_PREFIX}${safeSessionId}`;

  let redis;
  try {
    redis = getRedisClient();
  } catch (configError) {
    return res.status(500).json({ error: "Redis not configured", detail: configError.message });
  }

  try {
    if (req.method === "GET") {
      const memory = await redis.get(key);
      return res.status(200).json({ sessionId: safeSessionId, memory: memory || "", found: !!memory, length: memory ? memory.length : 0 });
    }

    if (req.method === "POST") {
      const { userMessage, assistantMessage, overwrite } = req.body || {};

      if (overwrite !== undefined) {
        if (typeof overwrite !== "string") return res.status(400).json({ error: "overwrite must be a string" });
        const trimmed = overwrite.slice(-MAX_MEMORY_CHARS);
        await redis.set(key, trimmed, { ex: TTL_SECONDS });
        return res.status(200).json({ sessionId: safeSessionId, message: "Memory replaced.", length: trimmed.length });
      }

      if (!userMessage || !assistantMessage) {
        return res.status(400).json({ error: "Request body must include userMessage and assistantMessage" });
      }

      const timestamp = new Date().toISOString();
      const entry = `\n[${timestamp}]\n[User]: ${userMessage.trim()}\n[Freyja]: ${assistantMessage.trim()}`;
      const existing = (await redis.get(key)) || "";
      const updated = (existing + entry).slice(-MAX_MEMORY_CHARS);
      await redis.set(key, updated, { ex: TTL_SECONDS });

      return res.status(200).json({ sessionId: safeSessionId, message: "Memory updated.", length: updated.length, remaining: MAX_MEMORY_CHARS - updated.length });
    }

    if (req.method === "DELETE") {
      const deleted = await redis.del(key);
      return res.status(200).json({ sessionId: safeSessionId, message: deleted > 0 ? "Memory cleared." : "No memory found for this session.", deleted: deleted > 0 });
    }

    return res.status(405).json({ error: "Method not allowed. Use GET to retrieve, POST to append, DELETE to clear." });
  } catch (error) {
    console.error("Memory API error:", error);
    return res.status(500).json({ error: "Memory API error", detail: error.message });
  }
}
