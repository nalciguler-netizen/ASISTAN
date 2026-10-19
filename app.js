// app.js - arayüz + WebLLM bağlantısı. Mantık core.js içindedir.
import {
  Hafiza, sistemMetni, gecmisKirp, sohbetDongusu, araclariKur,
} from "./core.js";

const $ = (id) => document.getElementById(id);

// ---------- Depolama ----------
const bellekDepo = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; })();
const depo = (() => {
  try { localStorage.setItem("_t", "1"); localStorage.removeItem("_t"); return localStorage; } catch { return bellekDepo; }
})();

const VARSAYILAN = { web: true, proxy: "", sicaklik: 0.6, model: "" };
let ayar = { ...VARSAYILAN, ...(() => { try { return JSON.parse(depo.getItem("ayar_v1") || "{}"); } catch { return {}; } })() };
const ayarKaydet = () => depo.setItem("ayar_v1", JSON.stringify(ayar));

const hafiza = new Hafiza(depo);
let gecmis = (() => { try { return JSON.parse(depo.getItem("gecmis_v1") || "[]"); } catch { return []; } })();
const gecmisKaydet = () => { gecmis = gecmis.slice(-40); depo.setItem("gecmis_v1", JSON.stringify(gecmis)); };

let webllm = null;
let engine = null;
let yukluModel = "";
let mesgul = false;
let durdurIstendi = false;

// ---------- Ekran yardımcıları ----------
function linkli(el, metin) {
  el.textContent = "";
  const re = /https?:\/\/[^\s<>"')]+/g;
  let son = 0, m;
  while ((m = re.exec(metin))) {
    el.append(metin.slice(son, m.index));
    const a = document.createElement("a");
    a.href = m[0]; a.textContent = m[0]; a.target = "_blank"; a.rel = "noopener noreferrer";
    el.append(a);
    son = m.index + m[0].length;
  }
  el.append(metin.slice(son));
}
function balon(tur, metin = "") {
  const d = document.createElement("div");
  d.className = "balon " + tur;
  linkli(d, metin);
  $("sohbet").append(d);
  d.scrollIntoView({ block: "end" });
  return d;
}
function durum(m) { $("durumSatiri").textContent = m; }

// ---------- Cihaz tanısı ----------
async function tani() {
  const s = [];
  let gpuVar = false;
  s.push("WebGPU: " + ("gpu" in navigator ? "var" : "YOK"));
  if ("gpu" in navigator) {
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) s.push("GPU adaptörü: bulunamadı");
      else {
        gpuVar = true;
        s.push("shader-f16: " + (a.features.has("shader-f16") ? "var" : "yok"));
        s.push("maxBufferSize: " + (a.limits.maxBufferSize / 2 ** 30).toFixed(2) + " GB");
      }
    } catch (e) { s.push("GPU hatası: " + e.message); }
  }
  s.push("Bellek (tarayıcının bildirdiği): " + (navigator.deviceMemory ? navigator.deviceMemory + " GB" : "bilinmiyor"));
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      s.push(`Depolama: ${(e.usage / 2 ** 30).toFixed(2)} / ${(e.quota / 2 ** 30).toFixed(1)} GB`);
    }
  } catch { /* yok say */ }
  $("taniMetni").textContent = s.join("\n");
  return gpuVar;
}

// ---------- WebLLM ----------
async function webllmGetir() {
  if (globalThis.__TEST_WEBLLM__) return globalThis.__TEST_WEBLLM__; // yalnızca otomatik testler için
  const adresler = ["https://esm.run/@mlc-ai/web-llm", "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm"];
  let son;
  for (const a of adresler) {
    try { return await import(a); } catch (e) { son = e; }
  }
  throw new Error("WebLLM kütüphanesi indirilemedi (internet gerekli, ilk açılışta bir kez). " + (son && son.message ? son.message : ""));
}

function modelSecenekleri() {
  const liste = (webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list) || [];
  const kayitlar = liste
    .map((m) => ({ id: m.model_id, mb: m.vram_required_MB || 0 }))
    .filter((m) => m.id && !/embed/i.test(m.id))
    .sort((a, b) => (a.mb || 1e9) - (b.mb || 1e9) || a.id.localeCompare(b.id));
  const sec = $("modelSec");
  sec.textContent = "";
  for (const m of kayitlar) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.mb ? `${m.id} · ~${(m.mb / 1024).toFixed(1)} GB` : m.id;
    sec.append(o);
  }
  const ids = kayitlar.map((m) => m.id);
  const oner = [/Qwen3-4B.*q4f16_1/i, /Qwen3-4B/i, /(4B|3B).*q4f16_1/i, /(4B|3B)/i].map((re) => ids.find((i) => re.test(i))).find(Boolean);
  const secili = ids.includes(ayar.model) ? ayar.model : oner || ids[0];
  if (secili) sec.value = secili;
  return kayitlar.length;
}

async function modeliYukle() {
  const id = $("modelSec").value;
  if (!id) return;
  $("btnYukle").disabled = true; $("modelSec").disabled = true;
  $("ilerleme").hidden = false; $("ilerleme").value = 0;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* yok say */ }
  try {
    engine = await webllm.CreateMLCEngine(id, {
      initProgressCallback: (p) => {
        if (typeof p.progress === "number") $("ilerleme").value = p.progress;
        if (p.text) durum(p.text);
      },
    });
    yukluModel = id;
    ayar.model = id; ayarKaydet();
    $("modelSecimi").hidden = true;
    durum("Hazır · " + id);
    $("btnGonder").disabled = false;
  } catch (e) {
    engine = null;
    durum("Model yüklenemedi.");
    balon("hata", "Model yüklenemedi: " + (e && e.message ? e.message : e) +
      "\n\nDaha küçük bir model seçip tekrar dene. Cihaz durumu bölümüne de bak.");
    $("btnYukle").disabled = false; $("modelSec").disabled = false;
  } finally {
    $("ilerleme").hidden = true;
  }
}

async function modelSohbet(mesajlar, onToken) {
  let tam = "";
  const akis = await engine.chat.completions.create({
    messages: mesajlar, stream: true, temperature: ayar.sicaklik, max_tokens: 700,
  });
  for await (const parca of akis) {
    const d = (parca.choices && parca.choices[0] && parca.choices[0].delta && parca.choices[0].delta.content) || "";
    if (d) { tam += d; onToken(d); }
    if (durdurIstendi) { try { engine.interruptGenerate(); } catch { /* yok say */ } break; }
  }
  return tam;
}

// ---------- Sohbet ----------
function bugun() {
  return new Date().toLocaleDateString("tr-TR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

async function gonder(metin) {
  metin = metin.trim();
  if (!metin || mesgul) return;
  const komut = metin.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (komut) {
    const [, ad, arg] = komut;
    if (ad === "ogren") {
      if (!arg.trim()) { balon("asistan", "Kullanım: /ogren Annemin doğum günü 3 Mart"); return; }
      const it = hafiza.ekle(arg, "kullanici");
      balon("asistan", it ? "Öğrendim, hafızaya kaydettim." : "Kaydedilemedi.");
      return;
    }
    if (ad === "hafiza" || ad === "unut") { hafizaAc(); return; }
    if (ad === "temizle") { gecmis = []; gecmisKaydet(); $("sohbet").textContent = ""; return; }
  }
  if (!engine) { balon("hata", "Önce modeli yükle."); return; }

  mesgul = true; durdurIstendi = false;
  $("btnGonder").hidden = true; $("btnDurdur").hidden = false;
  balon("kullanici", metin);
  let cevapEl = null, cevapMetni = "";
  const yaz = (p) => {
    if (!cevapEl) cevapEl = balon("asistan");
    cevapMetni += p;
    linkli(cevapEl, cevapMetni);
    cevapEl.scrollIntoView({ block: "end" });
  };
  try {
    const notlar = hafiza.ara(metin, 5).map((x) => x.metin);
    const proxyVar = !!ayar.proxy.trim();
    const sistem = { role: "system", content: sistemMetni({ tarih: bugun(), notlar, webAcik: ayar.web, proxyVar }) };
    // Bağlam penceresi dar (çoğu modelde ~4096 token, Türkçe çok token harcar): geçmişi kısa tut
    const mesajlar = gecmisKirp([sistem, ...gecmis, { role: "user", content: metin }], 4000);
    const araclar = araclariKur({
      fetchFn: (u, o) => fetch(u, o),
      proxy: ayar.proxy,
      hafiza,
      onayla: async (not) => window.confirm("Asistan şunu hafızaya kaydetmek istiyor:\n\n" + not + "\n\nKaydedilsin mi?"),
    });
    const aracEtiket = { VIKI: "Vikipedi'de aranıyor", ARA: "Web'de aranıyor", OKU: "Sayfa okunuyor", HATIRLA: "Hafıza" };
    const sonuc = await sohbetDongusu({
      mesajlar,
      sohbet: modelSohbet,
      araclar: ayar.web ? araclar : {},
      gorunenYaz: yaz,
      aracBasladi: (a) => balon("arac", `🔎 ${aracEtiket[a.ad] || a.ad}: ${a.arg}`),
    });
    if (!cevapEl && sonuc.metin) yaz(sonuc.metin);
    if (sonuc.metin) {
      gecmis.push({ role: "user", content: metin }, { role: "assistant", content: sonuc.metin });
      gecmisKaydet();
    }
  } catch (e) {
    balon("hata", "Hata: " + (e && e.message ? e.message : e));
  } finally {
    mesgul = false;
    $("btnGonder").hidden = false; $("btnDurdur").hidden = true;
  }
}

// ---------- Hafıza penceresi ----------
function hafizaCiz() {
  const ul = $("hafizaListe");
  ul.textContent = "";
  const l = hafiza.liste().reverse();
  if (!l.length) { const li = document.createElement("li"); li.textContent = "Henüz not yok."; ul.append(li); return; }
  for (const it of l) {
    const li = document.createElement("li");
    const s = document.createElement("span"); s.textContent = it.metin;
    const b = document.createElement("button"); b.textContent = "Sil";
    b.onclick = () => { hafiza.sil(it.id); hafizaCiz(); };
    li.append(s, b);
    ul.append(li);
  }
}
function hafizaAc() { hafizaCiz(); $("dlgHafiza").showModal(); }

// ---------- Başlangıç ----------
function baglantilar() {
  $("giris").addEventListener("submit", (e) => { e.preventDefault(); const m = $("metin").value; $("metin").value = ""; $("metin").style.height = "auto"; gonder(m); });
  $("metin").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px"; });
  $("btnDurdur").onclick = () => { durdurIstendi = true; };
  $("btnYukle").onclick = modeliYukle;
  $("btnHafiza").onclick = hafizaAc;
  $("btnHafizaKapat").onclick = () => $("dlgHafiza").close();
  $("btnNotEkle").onclick = () => { const v = $("yeniNot").value; if (hafiza.ekle(v)) { $("yeniNot").value = ""; hafizaCiz(); } };
  $("btnYedekAl").onclick = () => {
    const url = URL.createObjectURL(new Blob([hafiza.disaAktar()], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "hafiza-yedek.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  $("yedekDosya").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = hafiza.iceAktar(await f.text()); balon("asistan", `${n} not içe aktarıldı.`); hafizaCiz(); }
    catch (er) { balon("hata", er.message); }
    e.target.value = "";
  };
  $("btnAyar").onclick = () => {
    $("ayWeb").checked = ayar.web; $("ayProxy").value = ayar.proxy; $("aySicaklik").value = ayar.sicaklik;
    $("aySicaklikDeger").textContent = ayar.sicaklik;
    $("dlgAyar").showModal();
  };
  $("aySicaklik").oninput = (e) => { $("aySicaklikDeger").textContent = e.target.value; };
  // Kaydet düğmesine basılamasa bile ayarlar anında saklansın
  const otomatikKaydet = () => {
    ayar.web = $("ayWeb").checked;
    ayar.proxy = $("ayProxy").value.trim();
    ayar.sicaklik = parseFloat($("aySicaklik").value) || 0.6;
    ayarKaydet();
  };
  $("ayWeb").addEventListener("change", otomatikKaydet);
  $("ayProxy").addEventListener("input", otomatikKaydet);
  $("ayProxy").addEventListener("change", otomatikKaydet);
  $("aySicaklik").addEventListener("input", otomatikKaydet);
  $("btnAyarKapat").onclick = () => {
    ayar.web = $("ayWeb").checked;
    ayar.proxy = $("ayProxy").value.trim();
    ayar.sicaklik = parseFloat($("aySicaklik").value) || 0.6;
    ayarKaydet();
    $("dlgAyar").close();
  };
  $("btnSohbetTemizle").onclick = () => { gecmis = []; gecmisKaydet(); $("sohbet").textContent = ""; $("dlgAyar").close(); };
}

async function basla() {
  baglantilar();
  $("btnGonder").disabled = true;
  for (const m of gecmis) balon(m.role === "user" ? "kullanici" : "asistan", m.content);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const gpuVar = await tani();
  if (!gpuVar) {
    durum("Bu tarayıcıda WebGPU çalışmıyor. Android'de güncel Chrome kullan ve sayfayı yeniden aç.");
    return;
  }
  durum("Kütüphane yükleniyor…");
  try {
    webllm = await webllmGetir();
  } catch (e) {
    durum("Kütüphane yüklenemedi.");
    balon("hata", e.message);
    return;
  }
  const n = modelSecenekleri();
  if (!n) { durum("Model listesi boş."); return; }
  $("modelSecimi").hidden = false;
  durum("Bir model seç ve yükle (ilk seferde indirir, sonra telefonda saklanır).");
}

basla();
