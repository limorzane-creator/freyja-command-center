import { getServerSession } from "next-auth/next";
import { authOptions } from "./auth/[...nextauth]";
import { google } from "googleapis";

function getDriveClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

function friendlyMimeType(mimeType) {
  const map = {
    "application/vnd.google-apps.document": "Google Doc",
    "application/vnd.google-apps.spreadsheet": "Google Sheet",
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/vnd.google-apps.folder": "Folder",
    "application/pdf": "PDF",
    "text/plain": "Text File",
    "text/csv": "CSV",
    "image/jpeg": "JPEG Image",
    "image/png": "PNG Image",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word Doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel Sheet",
  };
  return map[mimeType] || mimeType;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const b = parseInt(bytes, 10);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatFileResult(f) {
  return { id: f.id, name: f.name, mimeType: f.mimeType, type: friendlyMimeType(f.mimeType), modifiedTime: f.modifiedTime || "", size: formatSize(f.size), webViewLink: f.webViewLink || "" };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.access_token) return res.status(401).json({ error: "Not authenticated. Please sign in with Google at /api/auth/signin" });
  if (session.error === "RefreshAccessTokenError") return res.status(401).json({ error: "Google session expired. Please sign in again at /api/auth/signin" });

  const drive = getDriveClient(session.access_token);
  const { action, q, fileId, maxResults = "20", mimeType } = req.query;

  try {
    if (action === "search") {
      if (!q) return res.status(400).json({ error: "q is required for search" });
      const queryParts = [`fullText contains '${q.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`, "trashed = false"];
      if (mimeType) queryParts.push(`mimeType = '${mimeType}'`);
      const response = await drive.files.list({ q: queryParts.join(" and "), pageSize: parseInt(maxResults, 10), fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)", orderBy: "modifiedTime desc" });
      const files = (response.data.files || []).map(formatFileResult);
      return res.status(200).json({ files, count: files.length, query: q });
    }

    if (action === "read") {
      if (!fileId) return res.status(400).json({ error: "fileId is required for read" });
      const meta = await drive.files.get({ fileId, fields: "id, name, mimeType, modifiedTime, webViewLink" });
      const { mimeType: fileMime, name, webViewLink } = meta.data;
      let content = "";
      let exportedAs = "";

      if (fileMime === "application/vnd.google-apps.document" || fileMime === "application/vnd.google-apps.presentation") {
        const exported = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
        content = exported.data; exportedAs = "text/plain";
      } else if (fileMime === "application/vnd.google-apps.spreadsheet") {
        const exported = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
        content = exported.data; exportedAs = "text/csv";
      } else if (fileMime === "text/plain" || fileMime === "text/csv") {
        const downloaded = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        content = downloaded.data; exportedAs = fileMime;
      } else {
        content = `[This file type (${friendlyMimeType(fileMime)}) cannot be displayed as text. Open it here: ${webViewLink}]`;
        exportedAs = "unsupported";
      }

      return res.status(200).json({ id: fileId, name, mimeType: fileMime, type: friendlyMimeType(fileMime), exportedAs, webViewLink, content });
    }

    if (action === "list" || !action) {
      const queryParts = ["trashed = false"];
      if (mimeType) queryParts.push(`mimeType = '${mimeType}'`);
      const response = await drive.files.list({ q: queryParts.join(" and "), pageSize: parseInt(maxResults, 10), fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)", orderBy: "modifiedTime desc" });
      const files = (response.data.files || []).map(formatFileResult);
      return res.status(200).json({ files, count: files.length });
    }

    return res.status(400).json({ error: `Unknown action: "${action}". Valid: search, read, list` });
  } catch (error) {
    console.error("Drive API error:", error);
    return res.status(500).json({ error: "Drive API error", detail: error.message });
  }
}
