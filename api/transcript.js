// api/transcript.js — versione robusta: usa youtubei/v1/player
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

async function txt(url, lang = "it") {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
      "Cookie": "CONSENT=YES+cb"
    },
    timeout: 15000
  });
  if (!r.ok) return null;
  return await r.text();
}

async function json(url, body, lang = "it") {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
      "Cookie": "CONSENT=YES+cb"
    },
    body: JSON.stringify(body),
    timeout: 15000
  });
  if (!r.ok) return null;
  return await r.json();
}

function pickTrack(tracks, lang, asr) {
  return tracks.find(t => (t.languageCode || "").toLowerCase() === lang.toLowerCase()
    && (((t.kind || "").toLowerCase() === "asr") === !!asr));
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
      if (Array.isArray(ev.segs)) for (const s of ev.segs) text += s.utf8 ?? "";
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

function parseXml(xml) {
  const segs = [];
  let plain = "";
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const decode = s => s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  let m;
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

    // 1) Prendi INNERTUBE_* dalla pagina
    const watch = await txt(`https://www.youtube.com/watch?v=${id}&hl=${lang}&bpctr=9999999999&has_verified=1`, lang);
    if (!watch) return res.status(500).json({ error: "Cannot fetch watch page" });

    const key = (watch.match(/"INNERTUBE_API_KEY":"(.*?)"/) || [])[1];
    const cname = (watch.match(/"INNERTUBE_CLIENT_NAME":"(.*?)"/) || [])[1] || "WEB";
    const cver = (watch.match(/"INNERTUBE_CLIENT_VERSION":"(.*?)"/) || [])[1] || "2.20240101.00.00";

    if (!key) return res.status(500).json({ error: "Cannot extract API key" });

    // 2) Chiamata youtubei/v1/player
    const body = {
      context: { client: { clientName: cname, clientVersion: cver, hl: lang, gl: "IT" } },
      videoId: id,
      playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
      racyCheckOk: true, contentCheckOk: true
    };
    const pr = await json(`https://www.youtube.com/youtubei/v1/player?key=${key}`, body, lang);
    if (!pr) return res.status(500).json({ error: "youtubei player call failed" });

    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!Array.isArray(tracks) || !tracks.length) {
      return res.status(404).json({ error: "Captions not found in player response" });
    }

    const track =
      pickTrack(tracks, lang, false) ||
      pickTrack(tracks, lang, true) ||
      pickTrack(tracks, "en", false) ||
      pickTrack(tracks, "en", true);

    if (!track?.baseUrl) return res.status(404).json({ error: "Transcript not found or not public" });

    // 3) Scarica i captions (JSON3 preferito, poi XML)
    const json3Url = `${track.baseUrl}${track.baseUrl.includes("?") ? "&" : "?"}fmt=json3`;
    let raw = await txt(json3Url, lang);
    let parsed;
    if (raw && raw.trim().startsWith("{")) {
      parsed = parseJson3(raw);
    } else {
      raw = await txt(track.baseUrl, lang);
      if (!raw) return res.status(404).json({ error: "Failed to download captions" });
      parsed = parseXml(raw);
    }
    if (!parsed.transcript) return res.status(404).json({ error: "Empty transcript" });

    // 4) Metadati
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
