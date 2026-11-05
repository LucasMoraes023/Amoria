const V='amoria-v7',A=['./','index.html','app.js','config.js','vendor/qrcode.js','vendor/supabase.js','manifest.webmanifest','icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(A)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))));self.clients.claim()});
// Só guarda arquivos estáticos do próprio site. Nunca guarda respostas das Functions (preços, pagamentos, painel admin) nem respostas com erro.
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/.netlify/'))return;e.respondWith(fetch(e.request).then(r=>{if(r.ok&&r.type==='basic'){const c=r.clone();caches.open(V).then(x=>x.put(e.request,c)).catch(()=>{})}return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('index.html'))))});
