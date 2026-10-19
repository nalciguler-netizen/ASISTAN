// arama-proxy.js - isteğe bağlı Cloudflare Worker.
// Asistanın genel web araması (/ara) ve sayfa okuma (/oku) yapabilmesi için gerekir;
// tarayıcılar başka sitelerin sayfalarını doğrudan okumaya izin vermediği için aracı sunucu şart.
// Yalnızca ALLOWED_ORIGINS listesindeki sitelerden gelen isteklere cevap verir.

const VARSAYILAN_IZIN = "https://nalciguler-netizen.github.io";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36 AsistanBot/1.0";
const MAKS_BAYT = 1_500_000;

function izinliOrigin(req, env) {
  const liste = String((env && env.ALLOWED_ORIGINS) || VARSAYILAN_IZIN).split(",").map((s) => s.trim()).filter(Boolean);
  const o = req.headers.get("Origin") || "";
  return liste.includes(o) ? o : "";
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, origin, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

export function urlGuvenli(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return false;
  if (x.username || x.password) return false;
  const h = x.hostname.toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.includes(":") || h.startsWith("[")) return false;
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const a = +ip[1], b = +ip[2];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  } else if (/^\d+$/.test(h) || /^0x/i.test(h)) return false;
  return true;
}

export function htmlToText(html, max = 6000) {
  let s = String(html || "");
  s = s.replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol|table|blockquote)>|<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(b|i|u|em|strong|span|a|font|small|mark|code|sup|sub|abbr|cite)\b[^>]*>/gi, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return " "; } });
  s = s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.slice(0, max);
}

// DuckDuckGo'nun HTML sonuç sayfasını ayrıştırır (en iyi çaba; sayfa düzeni değişirse boş döner).
export function aramaAyristir(html) {
  const sonuclar = [];
  const etiket = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  const parcalar = String(html || "").split(/<div[^>]*class="[^"]*result\b[^"]*"[^>]*>/i).slice(1);
  for (const p of parcalar) {
    const a = p.match(etiket);
    if (!a) continue;
    const href = (a[0].match(/href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    let url = href.replace(/&amp;/g, "&");
    if (url.startsWith("//")) url = "https:" + url;
    try {
      const u = new URL(url);
      const hedef = u.searchParams.get("uddg");
      if (hedef) url = decodeURIComponent(hedef);
    } catch { continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    const baslik = htmlToText(a[0], 200);
    const oz = p.match(/<(?:a|td|div)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
    sonuclar.push({ baslik, url, ozet: oz ? htmlToText(oz[1], 300) : "" });
    if (sonuclar.length >= 6) break;
  }
  return sonuclar;
}

async function sinirliOku(res) {
  const okuyucu = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!okuyucu) return (await res.text()).slice(0, MAKS_BAYT);
  const dec = new TextDecoder("utf-8", { fatal: false });
  let toplam = 0, metin = "";
  for (;;) {
    const { done, value } = await okuyucu.read();
    if (done) break;
    toplam += value.byteLength;
    metin += dec.decode(value, { stream: true });
    if (toplam > MAKS_BAYT) { try { await okuyucu.cancel(); } catch { /* yok say */ } break; }
  }
  return metin;
}

export default {
  async fetch(req, env) {
    const origin = izinliOrigin(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: origin ? 204 : 403, headers: origin ? cors(origin) : {} });
    if (!origin) return new Response("Bu siteye izin verilmedi.", { status: 403 });
    if (req.method !== "GET") return json({ hata: "Yalnızca GET" }, origin, 405);

    const url = new URL(req.url);
    try {
      if (url.pathname === "/ara") {
        const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
        if (!q) return json({ hata: "q gerekli" }, origin, 400);
        const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
          headers: { "User-Agent": UA, "Accept-Language": "tr,en;q=0.8" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return json({ hata: "Arama kaynağı HTTP " + r.status }, origin, 502);
        return json({ sonuclar: aramaAyristir(await sinirliOku(r)) }, origin);
      }
      if (url.pathname === "/oku") {
        const hedef = url.searchParams.get("url") || "";
        if (!urlGuvenli(hedef)) return json({ hata: "Bu adres okunamaz." }, origin, 400);
        const r = await fetch(hedef, {
          headers: { "User-Agent": UA, "Accept": "text/html,text/plain;q=0.9", "Accept-Language": "tr,en;q=0.8" },
          redirect: "follow", signal: AbortSignal.timeout(8000),
        });
        if (!urlGuvenli(r.url || hedef)) return json({ hata: "Yönlendirme güvenli değil." }, origin, 400);
        const tur = (r.headers.get("Content-Type") || "").toLowerCase();
        if (!r.ok) return json({ hata: "Sayfa HTTP " + r.status }, origin, 200);
        if (!/text\/|json|xml/.test(tur)) return json({ hata: "Metin olmayan içerik: " + tur }, origin, 200);
        const ham = await sinirliOku(r);
        return json({ url: hedef, metin: /html/.test(tur) ? htmlToText(ham, 6000) : ham.slice(0, 6000) }, origin);
      }
      return json({ hata: "Bilinmeyen yol. /ara?q= veya /oku?url= kullan." }, origin, 404);
    } catch (e) {
      return json({ hata: "İstek başarısız: " + (e && e.message ? e.message : e) }, origin, 502);
    }
  },
};
