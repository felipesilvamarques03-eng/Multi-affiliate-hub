/* Multi Affiliate Hub — portão de entrada do painel publicado.
   Login por e-mail e senha (Supabase Auth), verificação em 2 etapas obrigatória (TOTP),
   lista de convidados, bloqueio por inatividade e carregamento do painel só depois de tudo validado. */
(function () {
  'use strict';
  var CFG = window.MAH_CFG || {};
  var SUPA = String(CFG.supa || '').replace(/\/+$/, '');
  var KEY = CFG.key || '';
  var IDLE_MIN = 30;
  var STORE_KEY = 'mah-auth';
  var DATA_KEYS = ['mah-v3', 'mah-v2', 'mah-v1', 'mah-ui', 'mah-chat'];
  var $ = function (id) { return document.getElementById(id); };
  var session = null, refreshTimer = null, idleTimer = null, booted = false, fails = 0, lockUntil = 0;

  /* ---------- armazenamento da sessão ---------- */
  function store(persist) { try { return persist ? window.localStorage : window.sessionStorage; } catch (e) { return null; } }
  function saveSession(s) {
    session = s;
    try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    var st = store(s && s.persist);
    if (s && st) try { st.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
    scheduleRefresh();
  }
  function loadSession() {
    var raw = null;
    try { raw = sessionStorage.getItem(STORE_KEY) || localStorage.getItem(STORE_KEY); } catch (e) {}
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function wipeLocalData() {
    try { DATA_KEYS.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
  }
  function claims(tok) {
    try {
      var p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return {}; }
  }
  function fromTokenResponse(j, persist) {
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, user: j.user || (session && session.user) || null, persist: !!persist };
  }

  /* ---------- chamadas ao Supabase ---------- */
  async function http(method, path, body, opts) {
    opts = opts || {};
    var h = { apikey: KEY };
    if (body !== undefined && !opts.raw) h['Content-Type'] = 'application/json';
    if (opts.auth !== false && session) h.Authorization = 'Bearer ' + session.access_token;
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { h[k] = opts.headers[k]; });
    var r;
    try { r = await fetch(SUPA + path, { method: method, headers: h, body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body)) }); }
    catch (e) { throw { status: 0, erro: 'Sem conexão com o servidor. Confira a internet.' }; }
    var txt = await r.text(), j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
    if (!r.ok) throw Object.assign({ status: r.status }, j && typeof j === 'object' ? j : {}, { erro: friendly(r.status, j) });
    return j;
  }
  function friendly(status, j) {
    var code = j && (j.error_code || j.code || j.error) || '', msg = String((j && (j.msg || j.message || j.error_description || j.erro)) || '');
    if (j && j.erro) return j.erro;
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
    if (code === 'email_not_confirmed' || /not confirmed/i.test(msg)) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
    if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) return 'Muitas tentativas. Espere alguns minutos e tente de novo.';
    if (code === 'weak_password' || /password/i.test(msg) && /weak|short|least/i.test(msg)) return 'Senha fraca. Use pelo menos 12 caracteres com letras, números e símbolo.';
    if (code === 'user_already_exists' || /already registered/i.test(msg)) return 'Esse e-mail já tem conta. Entre ou use "Esqueci a senha".';
    if (/convidados|hook/i.test(msg) || status === 403 && /signup|cadastro/i.test(msg)) return 'Cadastro apenas para e-mails convidados pelo dono do painel.';
    if (code === 'signup_disabled') return 'Cadastro fechado. Peça um convite ao dono do painel.';
    if (code === 'mfa_verification_failed' || /invalid totp|mfa/i.test(msg) && status === 422) return 'Código inválido ou vencido. Use o código atual do aplicativo.';
    if (status === 401) return 'Sessão expirada. Entre de novo.';
    if (status === 409 && j && j.code === '23505') return 'Esse item já existe.';
    if (status === 400 && j && j.code === '23514') return 'Algum campo está em formato inválido.';
    if (status === 403 || (j && j.code === '42501')) return 'Sem permissão para isso.';
    return 'Não foi possível concluir (' + (status || 'rede') + ').';
  }
  async function refresh() {
    if (!session || !session.refresh_token) throw { status: 401, erro: 'Sessão expirada.' };
    var j = await http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token }, { auth: false });
    saveSession(fromTokenResponse(j, session.persist));
    return session;
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session) return;
    var wait = Math.max(5000, session.expires_at - Date.now() - 90000);
    refreshTimer = setTimeout(function () { refresh().catch(function () { lock('Sua sessão expirou. Entre de novo.'); }); }, wait);
  }
  async function fresh() {
    if (!session) throw { status: 401, erro: 'Entre de novo.' };
    if (session.expires_at - Date.now() < 60000) await refresh();
    return session;
  }

  /* ---------- telas ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function screen(html) { $('gateBox').innerHTML = html; var f = $('gateBox').querySelector('input:not([type=checkbox]),button.btn'); if (f) try { f.focus(); } catch (e) {} }
  function msg(text, ok) { var m = $('gateMsg'); if (m) { m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = text || ''; } }
  function busy(form, on) { form.querySelectorAll('button,input').forEach(function (b) { b.disabled = on; }); }
  var HEAD = '<div class="g-brand"><span class="g-logo" aria-hidden="true">M</span><div><b>Multi Affiliate Hub</b><small>Acesso protegido</small></div></div>';

  function showLogin(note) {
    screen(HEAD + '<h1>Entrar</h1><p class="g-sub">Painel privado. Só entra quem foi convidado.</p>' +
      '<form id="fLogin" novalidate><label>E-mail<input type="email" name="email" autocomplete="username" required></label>' +
      '<label>Senha<input type="password" name="password" autocomplete="current-password" required></label>' +
      '<label class="g-check"><input type="checkbox" name="persist"> Manter conectado neste aparelho</label>' +
      '<button class="btn block" type="submit">Entrar</button></form><p class="msg" id="gateMsg" role="status"></p>' +
      '<div class="g-links"><button type="button" class="g-link" data-go="forgot">Esqueci a senha</button><button type="button" class="g-link" data-go="signup">Primeiro acesso (convidados)</button></div>');
    if (note) msg(note.text, note.ok);
  }
  function showSignup() {
    screen(HEAD + '<h1>Primeiro acesso</h1><p class="g-sub">Use o e-mail que recebeu o convite. Você vai confirmar o e-mail e ativar o código de 2 etapas.</p>' +
      '<form id="fSignup" novalidate><label>E-mail<input type="email" name="email" autocomplete="username" required></label>' +
      '<label>Senha (mínimo 12 caracteres)<input type="password" name="password" autocomplete="new-password" required minlength="12"></label>' +
      '<label>Repita a senha<input type="password" name="password2" autocomplete="new-password" required></label>' +
      '<ul class="g-rules" id="pwRules"></ul><button class="btn block" type="submit">Criar acesso</button></form><p class="msg" id="gateMsg" role="status"></p>' +
      '<div class="g-links"><button type="button" class="g-link" data-go="login">Já tenho conta</button></div>');
    pwRules('');
  }
  function showForgot() {
    screen(HEAD + '<h1>Recuperar senha</h1><p class="g-sub">Enviamos um link para criar uma senha nova.</p>' +
      '<form id="fForgot" novalidate><label>E-mail<input type="email" name="email" autocomplete="username" required></label><button class="btn block" type="submit">Enviar link</button></form><p class="msg" id="gateMsg" role="status"></p>' +
      '<div class="g-links"><button type="button" class="g-link" data-go="login">Voltar</button></div>');
  }
  function showNewPassword() {
    screen(HEAD + '<h1>Nova senha</h1><form id="fNewPw" novalidate><label>Nova senha<input type="password" name="password" autocomplete="new-password" required minlength="12"></label><label>Repita<input type="password" name="password2" autocomplete="new-password" required></label><ul class="g-rules" id="pwRules"></ul><button class="btn block" type="submit">Salvar senha</button></form><p class="msg" id="gateMsg" role="status"></p>');
    pwRules('');
  }
  function showLoading(t) { screen(HEAD + '<div class="g-load"><span class="g-spin" aria-hidden="true"></span>' + esc(t || 'Verificando acesso…') + '</div>'); }

  function pwCheck(pw, email) {
    var name = String(email || '').split('@')[0].toLowerCase();
    return [
      [pw.length >= 12, 'Pelo menos 12 caracteres'],
      [/[a-zA-Z]/.test(pw) && /\d/.test(pw), 'Letras e números'],
      [/[^a-zA-Z0-9]/.test(pw), 'Um símbolo (ex.: ! @ # $)'],
      [!(name.length >= 3 && pw.toLowerCase().indexOf(name) > -1) && !/^(.)\1+$/.test(pw) && !/123456|senha|password|qwerty/i.test(pw), 'Não usar o seu e-mail nem sequências óbvias']
    ];
  }
  function pwRules(pw, email) {
    var el = $('pwRules'); if (!el) return;
    el.innerHTML = pwCheck(pw, email).map(function (r) { return '<li class="' + (r[0] ? 'ok' : '') + '">' + esc(r[1]) + '</li>'; }).join('');
  }

  /* ---------- 2 etapas (TOTP) ---------- */
  async function mfaFlow() {
    var u = await http('GET', '/auth/v1/user');
    session.user = u; saveSession(session);
    var factors = (u.factors || []).filter(function (f) { return f.factor_type === 'totp'; });
    var verified = factors.filter(function (f) { return f.status === 'verified'; });
    if (verified.length) return showChallenge(verified[0]);
    for (var i = 0; i < factors.length; i++) { try { await http('DELETE', '/auth/v1/factors/' + factors[i].id); } catch (e) {} }
    var en = await http('POST', '/auth/v1/factors', { factor_type: 'totp', friendly_name: 'Painel ' + new Date().toISOString().slice(0, 16), issuer: 'Multi Affiliate Hub' });
    var qr = en.totp && en.totp.qr_code || '';
    if (qr && qr.indexOf('data:') !== 0) qr = 'data:image/svg+xml;utf-8,' + encodeURIComponent(qr);
    screen(HEAD + '<h1>Ative a verificação em 2 etapas</h1><p class="g-sub">Obrigatória para entrar. Instale um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou 2FAS), toque em adicionar e leia o código abaixo.</p>' +
      '<div class="g-qr">' + (qr ? '<img alt="Código QR para o aplicativo autenticador" src="' + esc(qr) + '">' : '') + '</div>' +
      '<details class="g-secret"><summary>Não consegue ler? Digite esta chave</summary><code>' + esc(en.totp && en.totp.secret || '') + '</code></details>' +
      '<form id="fMfa" data-factor="' + esc(en.id) + '" data-new="1" novalidate><label>Código de 6 dígitos do aplicativo<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button class="btn block" type="submit">Confirmar e entrar</button></form><p class="msg" id="gateMsg" role="status"></p>' +
      '<div class="g-links"><button type="button" class="g-link" data-go="logout">Sair</button></div>');
  }
  function showChallenge(f) {
    screen(HEAD + '<h1>Código de verificação</h1><p class="g-sub">Abra o aplicativo autenticador e digite o código de 6 dígitos do Multi Affiliate Hub.</p>' +
      '<form id="fMfa" data-factor="' + esc(f.id) + '" novalidate><label>Código<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button class="btn block" type="submit">Entrar</button></form><p class="msg" id="gateMsg" role="status"></p>' +
      '<div class="g-links"><button type="button" class="g-link" data-go="logout">Sair</button></div>');
  }
  async function verifyMfa(factorId, code, isNew) {
    var ch = await http('POST', '/auth/v1/factors/' + factorId + '/challenge', {});
    var v = await http('POST', '/auth/v1/factors/' + factorId + '/verify', { challenge_id: ch.id, code: code });
    saveSession(fromTokenResponse(v, session.persist));
    if (isNew) audit('mfa.enroll', {});
    await afterAuth();
  }

  /* ---------- depois do login ---------- */
  async function afterAuth() {
    showLoading('Verificando acesso…');
    var c = claims(session.access_token);
    if (c.aal !== 'aal2') return mfaFlow();
    var who = await http('POST', '/rest/v1/rpc/mah_whoami', {});
    if (!who || !who.member) {
      screen(HEAD + '<h1>Acesso não liberado</h1><p class="g-sub">O e-mail <b>' + esc(c.email || '') + '</b> não está na lista de convidados deste painel. Peça ao dono para convidar você.</p><button class="btn block" type="button" data-go="logout">Sair</button>');
      return;
    }
    var prev = null;
    try { prev = localStorage.getItem('mah-last-user'); } catch (e) {}
    if (prev && prev !== c.sub) wipeLocalData();
    try { localStorage.setItem('mah-last-user', c.sub); } catch (e) {}
    await boot(who);
  }
  async function boot(who) {
    if (booted) return;
    showLoading('Abrindo o painel…');
    var s = await fresh();
    var r = await fetch('/api/panel', { headers: { Authorization: 'Bearer ' + s.access_token }, cache: 'no-store' });
    if (!r.ok) throw { status: r.status, erro: r.status === 403 ? 'Acesso negado ao painel.' : 'Não foi possível carregar o painel (' + r.status + ').' };
    var pack = await r.json();
    var c = claims(s.access_token);
    window.MAH_ENV = makeEnv({ id: c.sub, email: c.email || (s.user && s.user.email) || '' }, !!who.owner);
    window.claude = makeClaudeShim(c.sub);
    $('appRoot').innerHTML = pack.html;
    $('appRoot').hidden = false;
    $('gate').hidden = true;
    document.documentElement.classList.add('booted');
    booted = true;
    audit('login', { ua: navigator.userAgent.slice(0, 120) });
    startIdle();
    for (var i = 0; i < pack.js.length; i++) await runScript(pack.js[i]);
  }
  function runScript(code) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { URL.revokeObjectURL(url); res(); };
      s.onerror = function () { URL.revokeObjectURL(url); rej(new Error('script')); };
      document.body.appendChild(s);
    });
  }

  /* ---------- ponte entre o painel e o Supabase ---------- */
  function makeEnv(user, owner) {
    return {
      kind: 'netlify', user: user, owner: owner, supaUrl: SUPA, idleMin: IDLE_MIN,
      rest: async function (method, path, body, prefer) {
        await fresh();
        return http(method, '/rest/v1/' + path, body, { headers: prefer ? { Prefer: prefer } : null });
      },
      fn: async function (name, path, body) {
        await fresh();
        return http('POST', '/functions/v1/' + name + (path || ''), body || {});
      },
      upload: async function (bucket, path, blob, type) {
        await fresh();
        await http('POST', '/storage/v1/object/' + bucket + '/' + path, blob, { raw: true, headers: { 'Content-Type': type, 'x-upsert': 'false', 'Cache-Control': '31536000' } });
        return SUPA + '/storage/v1/object/public/' + bucket + '/' + path;
      },
      audit: audit,
      logout: function () { logout(false); },
      logoutAll: function () { logout(true); }
    };
  }
  function audit(action, detail) {
    if (!session) return;
    fresh().then(function () { return http('POST', '/rest/v1/mah_audit', { action: action, detail: detail || {} }, { headers: { Prefer: 'return=minimal' } }); }).catch(function () {});
  }
  // O painel foi feito para o Claude; aqui o "banco" dele vira a tabela mah_docs (protegida por RLS + 2FA).
  function makeClaudeShim(uid) {
    var all = null;
    function loadAll() {
      if (!all) all = fresh().then(function () { return http('GET', '/rest/v1/mah_docs?select=key,data'); }).then(function (rows) { var m = {}; (rows || []).forEach(function (r) { m[r.key] = r.data; }); return m; });
      return all;
    }
    function keyOf(path) { var k = String(path).split('/').pop(); if (!/^[a-z0-9_-]{1,40}$/.test(k)) throw { code: 'invalid_argument' }; return k; }
    var db = {
      doc: function (path) {
        var k = keyOf(path);
        return {
          get: async function () { var m = await loadAll(); var has = Object.prototype.hasOwnProperty.call(m, k); var d = has ? m[k] : null; return { exists: has, data: function () { return d; } }; },
          set: async function (body) {
            try {
              await fresh();
              await http('POST', '/rest/v1/mah_docs?on_conflict=owner,key', { key: k, data: body }, { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
              if (all) all.then(function (m) { m[k] = body; });
            } catch (e) {
              throw { code: e.status === 400 && /size|23514/.test(JSON.stringify(e)) ? 'quota_exceeded' : (e.status === 401 ? 'unauthenticated' : 'unavailable'), message: e.erro };
            }
          }
        };
      }
    };
    var user = { id: async function () { return uid; } };
    return { use: function (n) { if (n === 'db') return Promise.resolve(db); if (n === 'user') return Promise.resolve(user); return Promise.reject({ code: 'capability_disabled' }); } };
  }

  /* ---------- sair e bloqueio por inatividade ---------- */
  async function logout(all) {
    try { if (session) { audit(all ? 'logout.all' : 'logout', {}); await http('POST', '/auth/v1/logout' + (all ? '?scope=global' : ''), {}); } } catch (e) {}
    lock(all ? 'Você saiu de todos os aparelhos.' : 'Você saiu do painel.', true);
  }
  function lock(text, ok) {
    clearTimeout(refreshTimer); clearTimeout(idleTimer);
    session = null;
    try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    wipeLocalData();
    if (booted) { location.replace('/app/?saiu=' + (ok ? '1' : '0')); return; }
    showLogin({ text: text, ok: ok });
  }
  function startIdle() {
    var reset = function () { clearTimeout(idleTimer); idleTimer = setTimeout(function () { logout(false); }, IDLE_MIN * 60000); };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, reset, { passive: true }); });
    reset();
  }

  /* ---------- eventos ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-go]'); if (!b || booted && b.closest('#appRoot')) return;
    var go = b.getAttribute('data-go');
    if (go === 'login') showLogin(); else if (go === 'signup') showSignup(); else if (go === 'forgot') showForgot(); else if (go === 'logout') logout(false);
  });
  document.addEventListener('input', function (e) {
    var f = e.target.form; if (!f || (f.id !== 'fSignup' && f.id !== 'fNewPw')) return;
    pwRules(f.elements.password.value, f.elements.email ? f.elements.email.value : (session && session.user && session.user.email));
  });
  document.addEventListener('submit', async function (e) {
    var f = e.target; if (!f.id || f.id.charAt(0) !== 'f' || !f.closest('#gate')) return;
    e.preventDefault();
    var v = function (n) { return f.elements[n] ? String(f.elements[n].value).trim() : ''; };
    try {
      if (f.id === 'fLogin') {
        if (Date.now() < lockUntil) { msg('Muitas tentativas. Espere ' + Math.ceil((lockUntil - Date.now()) / 1000) + ' s.'); return; }
        if (!v('email') || !f.elements.password.value) { msg('Preencha e-mail e senha.'); return; }
        busy(f, true); msg('');
        var j = await http('POST', '/auth/v1/token?grant_type=password', { email: v('email').toLowerCase(), password: f.elements.password.value }, { auth: false });
        fails = 0;
        saveSession(fromTokenResponse(j, f.elements.persist.checked));
        await afterAuth();
      } else if (f.id === 'fSignup') {
        var pw = f.elements.password.value, em = v('email').toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { msg('Digite um e-mail válido.'); return; }
        if (pwCheck(pw, em).some(function (r) { return !r[0]; })) { msg('A senha não cumpre as regras.'); return; }
        if (pw !== f.elements.password2.value) { msg('As senhas não são iguais.'); return; }
        busy(f, true); msg('');
        await http('POST', '/auth/v1/signup?redirect_to=' + encodeURIComponent(location.origin + '/app/'), { email: em, password: pw }, { auth: false });
        screen(HEAD + '<h1>Confira seu e-mail</h1><p class="g-sub">Se <b>' + esc(em) + '</b> estiver na lista de convidados, chegou um link de confirmação. Abra o link neste aparelho e depois entre com sua senha.</p><button class="btn block" type="button" data-go="login">Ir para o login</button>');
      } else if (f.id === 'fForgot') {
        busy(f, true);
        await http('POST', '/auth/v1/recover?redirect_to=' + encodeURIComponent(location.origin + '/app/'), { email: v('email').toLowerCase() }, { auth: false });
        screen(HEAD + '<h1>Confira seu e-mail</h1><p class="g-sub">Se existir uma conta com esse e-mail, enviamos o link para criar uma senha nova.</p><button class="btn block" type="button" data-go="login">Voltar ao login</button>');
      } else if (f.id === 'fNewPw') {
        var p1 = f.elements.password.value;
        if (pwCheck(p1, session && session.user && session.user.email).some(function (r) { return !r[0]; })) { msg('A senha não cumpre as regras.'); return; }
        if (p1 !== f.elements.password2.value) { msg('As senhas não são iguais.'); return; }
        busy(f, true);
        await http('PUT', '/auth/v1/user', { password: p1 });
        await afterAuth();
      } else if (f.id === 'fMfa') {
        var code = v('code').replace(/\D/g, '');
        if (code.length !== 6) { msg('O código tem 6 números.'); return; }
        busy(f, true); msg('');
        await verifyMfa(f.getAttribute('data-factor'), code, f.getAttribute('data-new') === '1');
      }
    } catch (err) {
      if (f.id === 'fLogin') { fails++; if (fails >= 5) { lockUntil = Date.now() + 30000 * Math.min(8, fails - 4); } }
      if (document.body.contains(f)) busy(f, false);
      var bx = $('gateMsg');
      if (bx) msg(err && err.erro || 'Algo deu errado. Tente de novo.');
      else showLogin({ text: err && err.erro || 'Algo deu errado. Entre de novo.' });
      if (f.elements.code) { f.elements.code.value = ''; try { f.elements.code.focus(); } catch (e2) {} }
    }
  });

  /* ---------- início ---------- */
  async function start() {
    if (!SUPA || !KEY) { screen(HEAD + '<p class="msg err">Configuração do servidor ausente.</p>'); return; }
    var hash = location.hash.replace(/^#/, '');
    var hp = new URLSearchParams(hash.indexOf('access_token=') > -1 ? hash : '');
    var qp = new URLSearchParams(location.search);
    if (qp.get('saiu')) { try { history.replaceState(null, '', '/app/'); } catch (e) {} }
    if (hp.get('error_description')) { try { history.replaceState(null, '', '/app/'); } catch (e) {} showLogin({ text: 'O link do e-mail expirou ou já foi usado. Peça outro.' }); return; }
    if (hp.get('access_token')) {
      saveSession({ access_token: hp.get('access_token'), refresh_token: hp.get('refresh_token'), expires_at: Date.now() + (Number(hp.get('expires_in')) || 3600) * 1000, user: null, persist: false });
      var type = hp.get('type');
      try { history.replaceState(null, '', '/app/'); } catch (e) {}
      if (type === 'recovery') { showNewPassword(); return; }
      try { await afterAuth(); } catch (e) { showLogin({ text: e && e.erro || 'Entre de novo.' }); }
      return;
    }
    var s = loadSession();
    if (!s || !s.refresh_token) { showLogin(qp.get('saiu') ? { text: qp.get('saiu') === '1' ? 'Você saiu do painel.' : 'Sessão encerrada por segurança.', ok: qp.get('saiu') === '1' } : null); return; }
    session = s;
    showLoading();
    try { await refresh(); await afterAuth(); }
    catch (e) { lock(e && e.erro || 'Entre de novo.'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
