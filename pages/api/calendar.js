import { getServerSession } from "next-auth/next";
import { authOptions } from "./auth/[...nextauth]";
import { google } from "googleapis";

function getCalendarClient(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.calendar({ version: "v3", auth });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session?.access_token) return res.status(401).json({ error: "Not authenticated. Please sign in with Google at /api/auth/signin" });
  if (session.error === "RefreshAccessTokenError") return res.status(401).json({ error: "Google session expired. Please sign in again at /api/auth/signin" });

  const calendar = getCalendarClient(session.access_token);

  try {
    if (req.method === "GET") {
      const { calendarId = "primary", maxResults = "10", timeMin, timeMax, q } = req.query;
      const resolvedTimeMin = timeMin || new Date().toISOString();
      const params = { calendarId, timeMin: resolvedTimeMin, maxResults: parseInt(maxResults, 10), singleEvents: true, orderBy: "startTime" };
      if (timeMax) params.timeMax = timeMax;
      if (q) params.q = q;

      const response = await calendar.events.list(params);
      const events = (response.data.items || []).map((event) => ({
        id: event.id,
        summary: event.summary || "(No title)",
        description: event.description || "",
        location: event.location || "",
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        allDay: !event.start?.dateTime,
        status: event.status || "",
        htmlLink: event.htmlLink || "",
        meetLink: event.hangoutLink || "",
        attendees: (event.attendees || []).map((a) => ({ email: a.email, name: a.displayName || "", responseStatus: a.responseStatus || "" })),
        organizer: { email: event.organizer?.email || "", name: event.organizer?.displayName || "" },
      }));

      return res.status(200).json({ events, count: events.length });
    }

    if (req.method === "POST") {
      const { summary, description, location, start, end, attendees, calendarId = "primary", timeZone = "America/New_York", sendUpdates = "all" } = req.body;
      if (!summary) return res.status(400).json({ error: "summary is required" });
      if (!start) return res.status(400).json({ error: "start is required" });
      if (!end) return res.status(400).json({ error: "end is required" });

      const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
      const eventBody = {
        summary,
        description: description || "",
        location: location || "",
        start: isAllDay ? { date: start } : { dateTime: start, timeZone },
        end: isAllDay ? { date: end } : { dateTime: end, timeZone },
      };

      if (attendees?.length) {
        eventBody.attendees = attendees.map((a) => typeof a === "string" ? { email: a } : { email: a.email, displayName: a.name || "" });
      }

      const created = await calendar.events.insert({ calendarId, requestBody: eventBody, sendUpdates });
      return res.status(200).json({ eventId: created.data.id, summary: created.data.summary, start: created.data.start?.dateTime || created.data.start?.date, end: created.data.end?.dateTime || created.data.end?.date, htmlLink: created.data.htmlLink, message: "Event created successfully." });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("Calendar API error:", error);
    return res.status(500).json({ error: "Calendar API error", detail: error.message });
  }
}
