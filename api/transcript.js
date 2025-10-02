// api/transcript.js – Estrae captionTracks dalla watch page (JSON3 o XML)
import fetch from "node-fetch";

function getVideoId(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex(p => p === "shorts" || p === "live");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  } catch {}
  return null;
}

async function get(url, lang = "it") {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
      // evita il muro dei cookie
      "Cookie": "CONSENT=YES+cb"
    },
    timeout: 10000
  });
  if (!r.ok) return null;
  return await r.text();
}

function pickTrack(tracks, lang, asr) {
  return tracks.find(t => (t.languageCode || "").toLowerCase() === lang.toLowerCase()
                       && ((t.kind || "").toLowerCase() === "asr") === !!asr);
}

function parseJson3(raw) {
  const j = JSON.parse(raw);
  const segs = [];
  let plain = "";
  if (Array.isArray(j.events)) {
    for (const ev of j.events) {
      const tms = ev.tStartMs ?? 0;
      const dur = (ev.dDurationMs ?? 0) / 1000;
      let text = "";
      if (Array.isArray(ev.segs)) {
        for (const s of ev.segs) text += s.utf8 ?? "";
      }
      text = (text || "").replace(/\s+/g, " ").trim();
      if (text) {
        const sec = tms / 1000;
        const mm = Math.floor(sec / 60), ss = Math.floor(sec % 60);
        segs.push({ startSec: sec, start: `${mm}:${String(ss).padStart(2, "0")}`, dur, text });
        plain += text + " ";
      }
    }
  }
  return { segments: segs, transcript: plain.trim() };
}

function parseXmlTimedtext(xml) {
  const segs = [];
  let plain = "";
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                         .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1] || "0");
    const dur = parseFloat(m[2] || "0");
    const text = decode(m[3] || "");
    if (text) {
      const mm = Math.floor(start / 60), ss = Math.floor(start % 60);
      segs.push({ startSec: start, start: `${mm}:${String(ss).padStart(2, "0")}`, dur, text });
      plain += text + " ";
    }
  }
  return { segments: segs, transcript: plain.trim() };
}

export default async function handler(req, res) {
  try {
    const url = req.query.url || req.query.u;
    const lang = (req.query.lang || "it").toString();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });
    const id = getVideoId(url);
    if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });

    // 1) Scarica la watch page e trova ytInitialPlayerResponse.captionTracks
    const watch = await get(`https://www.youtube.com/watch?v=${id}&hl=${lang}&bpctr=9999999999&has_verified=1`, lang);
    if (!watch) return res.status(500).json({ error: "Cannot fetch watch page" });

    let tracks = [];
    const m1 = watch.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
    if (m1) {
      const pr = JSON.parse(m1[1]);
      tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    }
    if (!tracks.length) {
      const m2 = watch.match(/"captionTracks"\s*:\s*(\[[^\]]+\])/s);
      if (m2) tracks = JSON.parse(m2[1]);
    }
    if (!Array.isArray(tracks) || !tracks.length) {
      return res.status(404).json({ error: "Captions not found in player response" });
    }

    const track =
      pickTrack(tracks, lang, false) ||
      pickTrack(tracks, lang, true) ||
      pickTrack(tracks, "en", false) ||
      pickTrack(tracks, "en", true);

    if (!track?.baseUrl) return res.status(404).json({ error: "Transcript not found or not public" });

    // 2) Scarica captions in JSON3 (preferito) poi XML
    const base = track.baseUrl;
    const json3Url = `${base}${base.includes("?") ? "&" : "?"}fmt=json3`;
    let raw = await get(json3Url, lang);
    let parsed;

    if (raw && raw.trim().startsWith("{")) {
      parsed = parseJson3(raw);
    } else {
      raw = await get(base, lang);
      if (!raw) return res.status(404).json({ error: "Failed to download captions" });
      parsed = parseXmlTimedtext(raw);
    }

    if (!parsed.transcript) return res.status(404).json({ error: "Empty transcript" });

    // 3) Metadati
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
      language: track.languageCode || "",
      autoGenerated: (track.kind || "").toLowerCase() === "asr",
      transcript: parsed.transcript,
      segments: parsed.segments
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
}
