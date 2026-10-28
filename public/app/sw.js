/* Multi Affiliate Hub: service worker mínimo para o painel poder ser instalado como app.
   Não guarda nada em cache (o painel tem dados de login): tudo vem da rede.
   Sem internet, mostra uma página simples avisando. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Sem conexão</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#060B26;color:#fff;font-family:system-ui,sans-serif;text-align:center">' +
      '<div><h1 style="font-size:20px">Sem conexão com a internet</h1><p style="opacity:.75">O painel precisa de internet. Conecte e tente de novo.</p></div></body>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }));
});
