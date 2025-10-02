// Serverless endpoint: /transcript (o /api/transcript)
import fetch from "node-fetch";
import { YoutubeTranscript } from "youtube-transcript";

function videoIdFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex(p => p === "shorts" || p === "live");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {}
  return null;
}

export default async function handler(req, res) {
  try {
    const url = req.query.url || req.query.u;
    const lang = (req.query.lang || "it").toString();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });
    const id = videoIdFromUrl(url);
    if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });

    // Tenta lingua preferita, poi fallback automatico
    let items = [];
    try {
      items = await YoutubeTranscript.fetchTranscript(id, { lang });
    } catch {
      items = await YoutubeTranscript.fetchTranscript(id);
    }
    if (!items || items.length === 0) {
      return res.status(404).json({ error: "Transcript not found or not public" });
    }
    const transcript = items.map(i => i.text).join(" ").trim();

    // Metadati base via oEmbed
    let meta = {};
    try {
      const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
      if (r.ok) meta = await r.json();
    } catch {}

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      url,
      videoId: id,
      title: meta.title || "",
      channel: meta.author_name || "",
      language: lang,
      transcript
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Internal error" });
  }
}
