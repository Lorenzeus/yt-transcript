// api/transcript.js — Puppeteer + Chromium serverless (Vercel Hobby)
// Estrae captionTracks come un browser vero e poi scarica i sottotitoli (JSON3 o XML).
import fetch from "node-fetch";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

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

function parseXmlTimedtext(xml) {
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
  const started = Date.now();
  try {
    const url = req.query.url || req.query.u;
    const lang = (req.query.lang || "it").toString();
    if (!url) return res.status(400).json({ error: "Missing ?url=" });
    const id = getVideoId(url);
    if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });

    // —— 1) Avvio Chromium headless ottimizzato per Vercel
    const execPath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 720 },
      executablePath: execPath,
      headless: chromium.headless
    });
    const page = await browser.newPage();

    // Cookie CONSENT & Accept-Language per evitare il muro dei cookie e avere localizzazione
    await page.setExtraHTTPHeaders({
      "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`
    });
    await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".youtube.com" });

    // —— 2) Carica pagina watch (veloce) e prendi ytInitialPlayerResponse
    const watchUrl = `https://www.youtube.com/watch?v=${id}&hl=${lang}&bpctr=9999999999&has_verified=1`;
    await page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: 8000 });

    const html = await page.content();
    // Primo: prova a trovare il blocco ytInitialPlayerResponse
    let tracks = [];
    const m1 = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
    if (m1) {
      try {
        const pr = JSON.parse(m1[1]);
        tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      } catch {}
    }
    // Fallback: cerca "captionTracks":[...]
    if (!tracks?.length) {
      const m2 = html.match(/"captionTracks"\s*:\s*(\[[^\]]+\])/s);
      if (m2) {
        try { tracks = JSON.parse(m2[1]); } catch {}
      }
    }

    // Se ancora vuoto, tenta la chiamata youtubei/v1/player con chiavi della pagina
    if (!tracks?.length) {
      const key = (html.match(/"INNERTUBE_API_KEY":"(.*?)"/) || [])[1];
      const cname = (html.match(/"INNERTUBE_CLIENT_NAME":"(.*?)"/) || [])[1] || "WEB";
      const cver = (html.match(/"INNERTUBE_CLIENT_VERSION":"(.*?)"/) || [])[1] || "2.20240101.00.00";
      if (key) {
        const body = {
          context: { client: { clientName: cname, clientVersion: cver, hl: lang, gl: "IT" } },
          videoId: id,
          playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
          racyCheckOk: true, contentCheckOk: true
        };
        const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
            "Cookie": "CONSENT=YES+cb"
          },
          body: JSON.stringify(body)
        });
        if (r.ok) {
          const pr = await r.json();
          tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        }
      }
    }

    // Chiudi browser il prima possibile per stare nei 10s
    await page.close();
    await browser.close();

    if (!Array.isArray(tracks) || !tracks.length) {
      return res.status(404).json({ error: "Captions not found in player response" });
    }

    const track =
      pickTrack(tracks, lang, false) ||
      pickTrack(tracks, lang, true) ||
      pickTrack(tracks, "en", false) ||
      pickTrack(tracks, "en", true);

    if (!track?.baseUrl) {
      return res.status(404).json({ error: "Transcript not found or not public" });
    }

    // —— 3) Sca
