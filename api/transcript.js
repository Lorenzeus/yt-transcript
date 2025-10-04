// Serverless Puppeteer su Vercel Hobby (10s). Cattura errori dettagliati in log.
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function getVideoId(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "shorts" || p === "live");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  } catch {}
  return null;
}

function pickTrack(tracks, lang, asr) {
  return tracks.find(
    (t) =>
      (t.languageCode || "").toLowerCase() === lang.toLowerCase() &&
      (((t.kind || "").toLowerCase() === "asr") === !!asr)
  );
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

export default async function handler(req, res) {
  const started = Date.now();
  const url = req.query.url || req.query.u;
  const lang = (req.query.lang || "it").toString();

  if (!url) return res.status(400).json({ error: "Missing ?url=" });
  const id = getVideoId(url);
  if (!id) return res.status(400).json({ error: "Invalid YouTube URL" });

  let browser;
  try {
    // >>> BLOCCO LAUNCH CORRETTO (SOSTITUISCI QUESTO) <<<
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

const browser = await puppeteer.launch({
  args: [
    ...chromium.args,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--single-process"
  ],
  defaultViewport: { width: 1280, height: 720 },
  executablePath: await chromium.executablePath(),
  headless: chromium.headless,
  ignoreHTTPSErrors: true
});

    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
    });
    await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".youtube.com" });

    // Caricamento veloce: domcontentloaded con timeout breve (6s)
    const watchUrl = `https://www.youtube.com/watch?v=${id}&hl=${lang}&bpctr=9999999999&has_verified=1`;
    await page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: 6000 });

    const html = await page.content();

    // 1) prova a leggere captionTracks dall'HTML
    let tracks = [];
    const m1 = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
    if (m1) {
      try {
        const pr = JSON.parse(m1[1]);
        tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      } catch (e) {
        console.error("parse playerResponse:", e.message);
      }
    }
    if (!tracks?.length) {
      const m2 = html.match(/"captionTracks"\s*:\s*(\[[^\]]+\])/s);
      if (m2) {
        try {
          tracks = JSON.parse(m2[1]);
        } catch (e) {
          console.error("parse captionTracks:", e.message);
        }
      }
    }

    // 2) fallback youtubei con chiavi dalla pagina
    if (!tracks?.length) {
      const key = (html.match(/"INNERTUBE_API_KEY":"(.*?)"/) || [])[1];
      const cname = (html.match(/"INNERTUBE_CLIENT_NAME":"(.*?)"/) || [])[1] || "WEB";
      const cver =
        (html.match(/"INNERTUBE_CLIENT_VERSION":"(.*?)"/) || [])[1] ||
        "2.20240101.00.00";

      if (key) {
        const body = {
          context: {
            client: { clientName: cname, clientVersion: cver, hl: lang, gl: "IT" },
          },
          videoId: id,
          playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } },
          racyCheckOk: true,
          contentCheckOk: true,
        };
        const r = await fetch(
          `https://www.youtube.com/youtubei/v1/player?key=${key}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "User-Agent": UA,
              "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`,
              Cookie: "CONSENT=YES+cb",
            },
            body: JSON.stringify(body),
          }
        );
        if (r.ok) {
          const pr = await r.json();
          tracks =
            pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        }
      }
    }

    await page.close();
    await browser.close();
    browser = null;

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

    // Scarica sottotitoli: JSON3 preferito, poi XML
    const base = track.baseUrl;
    const json3Url = `${base}${base.includes("?") ? "&" : "?"}fmt=json3`;

    let parsed = null;

    try {
      const r1 = await fetch(json3Url, {
        headers: { "User-Agent": UA, "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`, Cookie: "CONSENT=YES+cb" }
      });
      if (r1.ok) {
        const t = await r1.text();
        if (t && t.trim().startsWith("{")) parsed = parseJson3(t);
      }
    } catch (e) {
      console.error("json3 fetch:", e.message);
    }

    if (!parsed) {
      const r2 = await fetch(base, {
        headers: { "User-Agent": UA, "Accept-Language": `${lang},${lang};q=0.9,en;q=0.8`, Cookie: "CONSENT=YES+cb" }
      });
      if (!r2.ok) return res.status(404).json({ error: "Failed to download captions" });
      const xml = await r2.text();
      parsed = parseXmlTimedtext(xml);
    }

    if (!parsed?.transcript) {
      return res.status(404).json({ error: "Empty transcript" });
    }

    // Metadati (best effort)
    let meta = {};
    try {
      const r = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`
      );
      if (r.ok) meta = await r.json();
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
      elapsedMs: Date.now() - started
    });
  } catch (e) {
    console.error("FATAL:", e);
    return res.status(500).json({ error: e?.message || "Internal error" });
  } finally {
    // Chiudi eventuale browser rimasto aperto in caso di eccezione
    try { if (browser) await browser.close(); } catch {}
  }
}
