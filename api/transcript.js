// api/transcript.js — SOLO WEB (niente chiavi hardcoded, niente Puppeteer)
// 1) legge la pagina /watch, estrae INNERTUBE_API_KEY / CLIENT_*
// 2) chiama youtubei/v1/player (WEB)
// 3) scarica i captions (JSON3 -> XML)
// Risponde SEMPRE in JSON.

const UA_WEB =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function getVideoId(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "shorts" || p === "live");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  } catch {}
  return null;
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
        const mm = Math.floor(sec / 60),
          ss = Math.floor(sec % 60);
        segs.push({
          startSec: sec,
          start: `${mm}:${String(ss).padStart(2, "0")}`,
          dur,
          text,
        });
        plain += text + " ";
      }
    }
  }
  return { segments: segs, transcript: plain.trim() };
}

function parseXmlTimedtext(xml) {
  const segs = [];
  let plain = "";
  const re =
    /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const decode = (s) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  let m;
  while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1] || "0");
    const dur = parseFloat(m[2] || "0");
    const text = decode(m[3] || "");
    if (text) {
      const mm = Math.floor(start / 60),
        ss = Math.floor(start % 60);
      segs.push({
        startSec: start,
        start: `${mm}:${String(ss).padStart(2, "0")}`,
        dur,
        text,
      });
      plain += text + " ";
    }
  }
  return { segments: segs, transcript: plain.trim() };
}

async function fetchWatchHtml(id, lang) {
  const r = await fetch(
    `https://www.youtube.com/watch?v=${id}&hl=${lang}&bpctr=9999999999&has_verified=1`,
    {
      headers: {
        "User-Agent": UA_WEB,
        "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
        // consente di oltrepassare il muro dei cookie
        Cookie: "CONSENT=YES+cb",
      },
    }
  );
  if (!r.ok) return null;
  return await r.text();
}

async function youtubeiWebPlayer(id, lang) {
  const html = await fetchWatchHtml(id, lang);
  if (!html) return { ok: false, error: "Cannot fetch watch page" };

  const key = (html.match(/"INNERTUBE_API_KEY":"(.*?)"/) || [])[1];
  const cname = (html.match(/"INNERTUBE_CLIENT_NAME":"(.*?)"/) || [])[1] || "WEB";
  const cver =
    (html.match(/"INNERTUBE_CLIENT_VERSION":"(.*?)"/) || [])[1] ||
    "2.20240101.00.00";

  if (!key) return { ok: false, error: "Cannot extract API key" };

  const body = {
    context: { client: { clientName: cname, clientVersion: cver, hl: lang, gl: "IT" } },
    videoId: id,
    racyCheckOk: true,
    contentCheckOk: true,
  };

  const r = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${key}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "User-Agent": UA_WEB,
        "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
        Cookie: "CONSENT=YES+cb",
      },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) return { ok: false, error: "youtubei player call failed", status: r.status };

  const pr = await r.json();
  const tracks =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return { ok: true, tracks };
}

function pickTrack(tracks, lang, asr) {
  return tracks.find(
    (t) =>
      (t.languageCode || "").toLowerCase() === lang.toLowerCase() &&
      (((t.kind || "").toLowerCase() === "asr") === !!asr)
  );
}

export default async function handler(req, res) {
  try {
    const url = req.query.url || req.query.u;
    const lang = (req.query.lang || "it").toString();

    if (!url) return res.status(400).json({ error: "Missing ?url=" });
    const id = getVideoId(url);
    if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });

    // 1) Chiamata youtubei (WEB)
    const pr = await youtubeiWebPlayer(id, lang);
    if (!pr.ok) return res.status(500).json({ error: pr.error, status: pr.status || null });

    const tracks = pr.tracks || [];
    if (!Array.isArray(tracks) || !tracks.length) {
      return res.status(404).json({ error: "Captions not found in player response" });
    }


    
// DEBUG: elenco tracce disponibili
if (req.query.debug === "1") {
  const langs = Array.isArray(tracks)
    ? tracks.map(t => ({
        languageCode: t.languageCode,
        kind: t.kind || "",
        name:
          t.name?.simpleText ||
          (t.name?.runs ? t.name.runs.map(r => r.text).join("") : "")
      }))
    : [];
  return res.status(200).json({
    hasTracks: Array.isArray(tracks) && tracks.length > 0,
    count: tracks?.length || 0,
    languages: langs
  });
}

    
    
    // 2) Scegli traccia: IT → IT asr → EN → EN asr
    const track =
      pickTrack(tracks, lang, false) ||
      pickTrack(tracks, lang, true) ||
      pickTrack(tracks, "en", false) ||
      pickTrack(tracks, "en", true);

    if (!track?.baseUrl) {
      return res.status(404).json({ error: "Transcript not found or not public" });
    }

    // 3) Scarica i sottotitoli (JSON3 preferito; altrimenti XML)
    const base = track.baseUrl;
    const json3Url = `${base}${base.includes("?") ? "&" : "?"}fmt=json3`;

    let parsed = null;

    // JSON3
    try {
      const r1 = await fetch(json3Url, {
        headers: {
          "User-Agent": UA_WEB,
          "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
          Cookie: "CONSENT=YES+cb",
        },
      });
      if (r1.ok) {
        const t = await r1.text();
        if (t && t.trim().startsWith("{")) parsed = parseJson3(t);
      }
    } catch {}

    // XML
    if (!parsed) {
      const r2 = await fetch(base, {
        headers: {
          "User-Agent": UA_WEB,
          "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
          Cookie: "CONSENT=YES+cb",
        },
      });
      if (!r2.ok) return res.status(404).json({ error: "Failed to download captions" });
      const xml = await r2.text();
      parsed = parseXmlTimedtext(xml);
    }

    if (!parsed?.transcript) return res.status(404).json({ error: "Empty transcript" });

    // 4) Metadati best-effort
    let meta = {};
    try {
      const m = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`
      );
      if (m.ok) meta = await m.json();
    } catch {}

    return res.status(200).json({
      url,
      videoId: id,
      title: meta.title || "",
      channel: meta.author_name || "",
      language: track.languageCode || "",
      autoGenerated: (track.kind || "").toLowerCase() === "asr",
      transcript: parsed.transcript,
      segments: parsed.segments,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
