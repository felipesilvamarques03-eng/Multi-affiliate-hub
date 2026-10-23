/* Vitrine pública: produtos e dados do site vêm do Supabase (só leitura pública).
   Google Analytics, Google Ads e Pixel da Meta só são carregados com consentimento (LGPD / guia de cookies da ANPD). */
(function () {
  'use strict';
  var SUPA = 'https://znfmookzymtymgalwlly.supabase.co';
  var KEY = 'sb_publishable_Hf3LLiQusqyArfjlPlA7iA_fg0Bl3J7';
  var CK = 'fj-consent', CK_VER = 1, CK_DAYS = 365;
  var PLAT = { mercadolivre: 'Mercado Livre', shopee: 'Shopee', tiktok: 'TikTok Shop', loja: 'loja oficial', outro: 'loja parceira' };
  var $ = function (id) { return document.getElementById(id); };
  var brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var site = {}, tagsOn = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https:\/\/[^\s<>"]+$/.test(String(u || '')) ? String(u) : ''; }
  async function get(path) {
    var r = await fetch(SUPA + '/rest/v1/' + path, { headers: { apikey: KEY, Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* ---------- consentimento ---------- */
  function readConsent() {
    try { var c = JSON.parse(localStorage.getItem(CK) || 'null'); if (c && c.v === CK_VER && Date.now() - c.at < CK_DAYS * 864e5) return c; } catch (e) {}
    return null;
  }
  function writeConsent(analytics, ads) {
    var c = { v: CK_VER, analytics: !!analytics, ads: !!ads, at: Date.now() };
    try { localStorage.setItem(CK, JSON.stringify(c)); } catch (e) {}
    return c;
  }
  function banner(custom) {
    var el = $('ck'); if (!el) return;
    var c = readConsent() || { analytics: false, ads: false };
    el.hidden = false;
    el.innerHTML = '<p><b>Cookies</b>: usamos cookies do Google e da Meta para medir visitas e anúncios <b>só se você permitir</b>. Os essenciais não guardam dados pessoais. <a href="/privacidade.html">Saiba mais</a>.</p>' +
      (custom ? '<div class="opts"><label><input type="checkbox" id="ckA"' + (c.analytics ? ' checked' : '') + '><span>Medição de visitas<small>Google Analytics: páginas vistas e cliques, sem identificar você pelo nome.</small></span></label>' +
        '<label><input type="checkbox" id="ckD"' + (c.ads ? ' checked' : '') + '><span>Anúncios<small>Google Ads e Pixel da Meta: saber quais anúncios trouxeram visitas e mostrar anúncios relevantes.</small></span></label></div>' : '') +
      '<div class="row"><button type="button" id="ckNo">Recusar</button>' + (custom ? '<button type="button" class="pri" id="ckSave">Salvar escolha</button>' : '<button type="button" id="ckCustom">Personalizar</button><button type="button" class="pri" id="ckYes">Aceitar</button>') + '</div>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'ckYes') done(writeConsent(true, true));
    else if (b.id === 'ckNo') done(writeConsent(false, false));
    else if (b.id === 'ckCustom') banner(true);
    else if (b.id === 'ckSave') done(writeConsent($('ckA').checked, $('ckD').checked));
    else if (b.id === 'ckOpen') banner(true);
  });
  function done(c) {
    $('ck').hidden = true;
    if (tagsOn) {
      if (window.gtag) window.gtag('consent', 'update', consentState(c));
      if (window.fbq) window.fbq('consent', c.ads ? 'grant' : 'revoke');
    } else startTags(c);
  }
  function consentState(c) {
    return { analytics_storage: c.analytics ? 'granted' : 'denied', ad_storage: c.ads ? 'granted' : 'denied', ad_user_data: c.ads ? 'granted' : 'denied', ad_personalization: c.ads ? 'granted' : 'denied' };
  }

  /* ---------- tags (carregadas só depois do consentimento) ---------- */
  function loadScript(src) { var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); }
  function startTags(c) {
    if (!c || (!c.analytics && !c.ads)) return;
    var g = site.ga4_id || '', aw = site.gads_id || '';
    if ((c.analytics && g) || (c.ads && aw)) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      window.gtag('consent', 'update', consentState(c));
      window.gtag('js', new Date());
      if (c.analytics && /^G-[A-Z0-9]{4,16}$/.test(g)) window.gtag('config', g, { anonymize_ip: true });
      if (c.ads && /^AW-[0-9]{6,16}$/.test(aw)) window.gtag('config', aw);
      loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(c.analytics && g ? g : aw));
      tagsOn = true;
    }
    if (c.ads && /^[0-9]{8,20}$/.test(site.meta_pixel_id || '')) {
      var f = window.fbq = function () { f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
      if (!window._fbq) window._fbq = f;
      f.push = f; f.loaded = true; f.version = '2.0'; f.queue = [];
      loadScript('https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', site.meta_pixel_id);
      window.fbq('track', 'PageView');
      tagsOn = true;
    }
  }
  function trackClick(p) {
    var c = readConsent() || {};
    if (window.gtag) {
      if (c.analytics) window.gtag('event', 'clique_afiliado', { item_name: p.title, platform: p.platform, value: p.price || 0, currency: 'BRL', transport_type: 'beacon' });
      if (c.ads && site.gads_id && site.gads_click_label) window.gtag('event', 'conversion', { send_to: site.gads_id + '/' + site.gads_click_label, value: p.price || 0, currency: 'BRL', transport_type: 'beacon' });
    }
    if (window.fbq && c.ads) window.fbq('trackCustom', 'CliqueAfiliado', { content_name: p.title, value: p.price || 0, currency: 'BRL' });
  }

  /* ---------- rodapé e dados do responsável ---------- */
  function fillSite() {
    document.querySelectorAll('[data-site]').forEach(function (el) {
      var k = el.getAttribute('data-site'), v = site[k];
      if (k === 'site_name') el.textContent = v || 'FJ store';
      else if (v) el.textContent = v;
    });
    var who = [site.responsible, site.doc_id ? 'CPF/CNPJ ' + site.doc_id : ''].filter(Boolean).join(' · ');
    var contact = [];
    if (site.contact_email) contact.push('<a href="mailto:' + esc(site.contact_email) + '">' + esc(site.contact_email) + '</a>');
    if (site.whatsapp) contact.push('<a href="https://wa.me/' + esc(site.whatsapp) + '" target="_blank" rel="noopener">WhatsApp</a>');
    var f = $('ftWho'); if (f) f.innerHTML = (who ? esc(who) + '<br>' : '') + (contact.length ? 'Contato: ' + contact.join(' · ') : '');
    document.querySelectorAll('[data-contact]').forEach(function (el) { el.innerHTML = contact.length ? contact.join(' · ') : 'pelo contato informado no rodapé do site'; });
    document.querySelectorAll('[data-who]').forEach(function (el) { el.textContent = who || (site.site_name || 'FJ store'); });
    if (site.site_name && document.title.indexOf('FJ store') > -1) document.title = document.title.replace('FJ store', site.site_name);
    var y = $('year'); if (y) y.textContent = new Date().getFullYear();
  }

  /* ---------- produtos ---------- */
  var prods = [], filter = 'all';
  function card(p) {
    var url = safeUrl(p.url), img = safeUrl(p.image_url);
    var where = PLAT[p.platform] || 'loja parceira';
    return '<article class="prod" data-id="' + esc(p.id) + '">' +
      '<div class="ph">' + (img ? '<img src="' + esc(img) + '" alt="' + esc(p.title) + '" loading="lazy" decoding="async">' : '<div class="noimg">Sem foto</div>') + (p.badge ? '<span class="badge">' + esc(p.badge) + '</span>' : '') + '</div>' +
      '<div class="bd"><h2>' + esc(p.title) + '</h2>' + (p.descr ? '<p class="ds">' + esc(p.descr) + '</p>' + (p.descr.length > 140 ? '<button class="more" type="button" data-more>Ver detalhes</button>' : '') : '') +
      '<div class="price">' + (p.price != null ? '<b>' + brl.format(p.price) + '</b>' : '') + (p.old_price != null && p.price != null && p.old_price > p.price ? '<s>' + brl.format(p.old_price) + '</s>' : '') + '</div>' +
      '<span class="where">Compra feita no site ' + (p.platform === 'loja' ? 'da ' : 'do ') + esc(where) + '. Preço pode mudar.</span>' +
      (url ? '<a class="buy" href="' + esc(url) + '" target="_blank" rel="sponsored noopener noreferrer" data-buy="' + esc(p.id) + '">Ver no ' + esc(where) + ' →</a>' : '') +
      '</div></article>';
  }
  function render() {
    var g = $('grid'); if (!g) return;
    var list = prods.filter(function (p) { return filter === 'all' || p.platform === filter; });
    g.innerHTML = list.length ? list.map(card).join('') : '';
    $('empty').hidden = !!list.length;
    var plats = {}; prods.forEach(function (p) { plats[p.platform] = 1; });
    var keys = Object.keys(plats);
    $('chips').innerHTML = keys.length > 1 ? ['all'].concat(keys).map(function (k) { return '<button class="chip" type="button" data-f="' + k + '" aria-pressed="' + (k === filter) + '">' + esc(k === 'all' ? 'Todos' : PLAT[k] || k) + '</button>'; }).join('') : '';
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-buy]');
    if (a) { var p = prods.find(function (x) { return x.id === a.getAttribute('data-buy'); }); if (p) trackClick(p); return; }
    var m = e.target.closest('[data-more]');
    if (m) { var art = m.closest('.prod'); art.classList.toggle('open'); m.textContent = art.classList.contains('open') ? 'Ver menos' : 'Ver detalhes'; return; }
    var c = e.target.closest('[data-f]');
    if (c) { filter = c.getAttribute('data-f'); render(); }
  });

  async function start() {
    try {
      var s = await get('mah_site?id=eq.1&select=site_name,tagline,responsible,doc_id,contact_email,whatsapp,ga4_id,gads_id,gads_click_label,meta_pixel_id');
      site = (s && s[0]) || {};
    } catch (e) { site = {}; }
    fillSite();
    var c = readConsent();
    if (c) startTags(c); else banner(false);
    if ($('grid')) {
      try {
        prods = await get('mah_vitrine?published=eq.true&select=id,title,descr,price,old_price,platform,url,image_url,badge,sort&order=sort.asc,updated_at.desc&limit=200');
      } catch (e) { prods = []; $('empty').textContent = 'Não foi possível carregar os produtos agora. Tente de novo em instantes.'; }
      render();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
