import { getServerSession } from "next-auth/next";
import { authOptions } from "./auth/[...nextauth]";
import { google } from "googleapis";

function getGmailClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth });
}

function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts?.length > 0) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return "";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session?.access_token) return res.status(401).json({ error: "Not authenticated. Please sign in with Google at /api/auth/signin" });
  if (session.error === "RefreshAccessTokenError") return res.status(401).json({ error: "Google session expired. Please sign in again at /api/auth/signin" });

  const gmail = getGmailClient(session.access_token);
  const { action } = req.query;

  try {
    if (req.method === "GET" && action === "list") {
      const { maxResults = 10, q = "" } = req.query;
      const list = await gmail.users.messages.list({ userId: "me", maxResults: parseInt(maxResults), labelIds: ["INBOX"], q });
      if (!list.data.messages?.length) return res.status(200).json({ messages: [] });
      const messages = await Promise.all(list.data.messages.map(async (msg) => {
        const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
        const headers = full.data.payload?.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || "";
        return { id: msg.id, threadId: msg.threadId, subject: get("Subject"), from: get("From"), to: get("To"), date: get("Date"), snippet: full.data.snippet };
      }));
      return res.status(200).json({ messages });
    }

    if (req.method === "GET" && action === "read") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id is required" });
      const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const headers = msg.data.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name === name)?.value || "";
      const body = extractPlainText(msg.data.payload);
      return res.status(200).json({ id: msg.data.id, subject: get("Subject"), from: get("From"), to: get("To"), date: get("Date"), body, snippet: msg.data.snippet });
    }

    if (req.method === "POST" && action === "draft") {
      const { to, subject, body } = req.body;
      if (!to || !subject || !body) return res.status(400).json({ error: "to, subject, and body are required" });
      const raw = Buffer.from([`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body].join("\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const draft = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
      return res.status(200).json({ draftId: draft.data.id, message: "Draft saved to Gmail." });
    }

    if (req.method === "POST" && action === "send") {
      const { to, subject, body } = req.body;
      if (!to || !subject || !body) return res.status(400).json({ error: "to, subject, and body are required" });
      const raw = Buffer.from([`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body].join("\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      return res.status(200).json({ messageId: sent.data.id, message: "Email sent." });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (error) {
    console.error("Gmail error:", error);
    return res.status(500).json({ error: "Gmail API error", detail: error.message });
  }
}
