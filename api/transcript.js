const UA_ANDROID = "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip";

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

function parseJson3(raw) {
  const j = JSON.parse(raw);
  const segs = []; let plain = "";
  if (Array.isArray(j.events)) {
    for (const ev of j.events) {
      const tms = ev.tStartMs ?? 0, dur = (ev.dDurationMs ?? 0)/1000;
      let text = "";
      if (Array.isArray(ev.segs)) for (const s of ev.segs) text += s.utf8 ?? "";
      text = (text || "").replace(/\s+/g," ").trim();
      if (text) {
        const sec = tms/1000, mm = Math.floor(sec/60), ss = Math.floor(sec%60);
        segs.push({ startSec: sec, start: `${mm}:${String(ss).padStart(2,"0")}`, dur, text });
        plain += text + " ";
      }
    }
  }
  return { segments: segs, transcript: plain.trim() };
}
function parseXmlTimedtext(xml) {
  const segs = []; let plain = "";
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const decode = s => s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim();
  let m; while ((m = re.exec(xml)) !== null) {
    const start = parseFloat(m[1]||"0"), dur = parseFloat(m[2]||"0");
    const text = decode(m[3]||"");
    if (text) { const mm = Math.floor(start/60), ss = Math.floor(start%60);
      segs.push({ startSec: start, start: `${mm}:${String(ss).padStart(2,"0")}`, dur, text });
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

    // youtubei ANDROID
    const API_KEY = "AIzaSyAOd3v4u7cFFxaRZPZ5oVkywY6hR6-2mN8";
    const body = {
      context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", hl: lang, gl: "IT", androidSdkVersion: 30, userAgent: UA_ANDROID } },
      videoId: id, racyCheckOk: true, contentCheckOk: true
    };

    let pr;
    try {
      const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${API_KEY}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "User-Agent": UA_ANDROID,
          "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) return res.status(502).json({ error: "youtubei player call failed", status: r.status });
      pr = await r.json();
    } catch (e) {
      console.error("youtubei error:", e);
      return res.status(502).json({ error: "youtubei request crashed", detail: String(e) });
    }

    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!Array.isArray(tracks) || !tracks.length) {
      return res.status(404).json({ error: "Captions not found in player response" });
    }

    const pick = (tgt, asr) => tracks.find(t => (t.languageCode||"").toLowerCase()===tgt && ((t.kind||"").toLowerCase()==="asr")===!!asr);
    const lc = lang.toLowerCase();
    const track = pick(lc,false) || pick(lc,true) || pick("en",false) || pick("en",true);
    if (!track?.baseUrl) return res.status(404).json({ error: "Transcript not found or not public" });

    const base = track.baseUrl;
    const json3Url = `${base}${base.includes("?") ? "&" : "?"}fmt=json3`;

    let parsed = null;
    try {
      const r1 = await fetch(json3Url, { headers: { "User-Agent": UA_ANDROID, "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8` } });
      if (r1.ok) {
        const t = await r1.text();
        if (t && t.trim().startsWith("{")) parsed = parseJson3(t);
      }
    } catch (e) { console.error("json3 fetch err:", e); }

    if (!parsed) {
      const r2 = await fetch(base, { headers: { "User-Agent": UA_ANDROID, "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8` } });
      if (!r2.ok) return res.status(404).json({ error: "Failed to download captions", status: r2.status });
      const xml = await r2.text();
      parsed = parseXmlTimedtext(xml);
    }

    if (!parsed?.transcript) return res.status(404).json({ error: "Empty transcript" });

    // metadati
    let meta = {};
    try {
      const m = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
      if (m.ok) meta = await m.json();
    } catch {}

    return res.status(200).json({
      url, videoId: id,
      title: meta.title || "", channel: meta.author_name || "",
      language: track.languageCode || "", autoGenerated: (track.kind||"").toLowerCase()==="asr",
      transcript: parsed.transcript, segments: parsed.segments
    });
  } catch (e) {
    console.error("FATAL:", e);
    return res.status(500).json({ error: String(e) });
  }
}
