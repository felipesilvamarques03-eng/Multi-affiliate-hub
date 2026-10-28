/* Registra o service worker para o Chrome oferecer "Instalar app". */
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () {});
  });
})();
