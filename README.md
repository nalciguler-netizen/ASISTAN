# Asistan

Telefonda çalışan, kendi hafızası olan, internette arama yapabilen yapay zekâ asistanı.
Model telefonun GPU'sunda (WebGPU) çalışır; sunucu, kota ve ücret yoktur.

- `index.html` + `app.js` + `core.js` + `style.css` : uygulama (GitHub Pages'e yüklenir)
- `worker/` : isteğe bağlı arama sunucusu (genel web araması ve sayfa okuma için)
- `test/` : otomatik testler (`node test/test_core.mjs`, `test_worker.mjs`, `test_app.mjs`)
