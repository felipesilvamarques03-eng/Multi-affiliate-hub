// Spotify Controle — conector MCP pessoal do Multi Affiliate Hub.
// Lógica pura (sem Deno/Node específico): recebe um Request e devolve um Response.
// Dependências injetadas: { clientId, baseUrl, db, fetch, now, randomBytes }.
//
// Rotas (o caminho pode ter prefixo, ex.: /spotify-control/...):
//   GET  /            página de status
//   GET  /login       inicia o login no Spotify (PKCE, sem segredo do app)
//   GET  /callback    volta do Spotify: guarda os tokens e mostra o endereço do conector
//   POST /mcp/<chave> endpoint MCP (Streamable HTTP, respostas JSON, sem sessão)

export const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played';
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const URI_RE = /^spotify:(track|episode|album|playlist|artist|show):[A-Za-z0-9]{8,40}$/;

/* ---------- utilidades ---------- */
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
async function sha256hex(text) {
  return Array.from(await sha256(text)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function json(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) } });
}
function page(status, title, inner) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:dark}body{margin:0;background:#070B26;color:#fff;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
.box{max-width:640px;margin:0 auto;background:#0E1539;border:1px solid rgba(160,174,192,.2);border-radius:18px;padding:24px}
h1{font-size:1.35rem;margin:0 0 10px}p{margin:0 0 12px;color:#D2D8F0}.m{color:#A0AEC0;font-size:.92rem}
.btn{display:inline-block;background:#0B6BFF;color:#fff;text-decoration:none;font-weight:700;border-radius:12px;padding:11px 18px;border:0;cursor:pointer;font-size:1rem}
code,.key{display:block;background:#060B26;border:1px solid rgba(160,174,192,.25);border-radius:10px;padding:12px;font:14px/1.45 ui-monospace,Menlo,monospace;color:#fff;word-break:break-all;margin:6px 0 14px}
ol{padding-left:20px;color:#D2D8F0}li{margin-bottom:8px}.ok{color:#2FC98E;font-weight:700}.bad{color:#FF7272;font-weight:700}
</style></head><body><div class="box">${inner}</div></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}

/* ---------- erros do Spotify em português ---------- */
export class SpotifyError extends Error {
  constructor(status, reason, retryAfter) {
    super(reason || 'HTTP ' + status);
    this.status = status;
    this.reason = reason || '';
    this.retryAfter = retryAfter;
  }
}
export function friendly(e) {
  if (e && e.code === 'NOT_SETUP') return 'O conector ainda não está ligado a uma conta do Spotify. Abra o endereço de configuração e conecte.';
  if (e && e.code === 'BAD_INPUT') return e.message;
  if (!(e instanceof SpotifyError)) return 'Não foi possível falar com o Spotify agora. Tente de novo em instantes.';
  const r = String(e.reason || '').toUpperCase();
  if (e.status === 401 || r === 'INVALID_GRANT') return 'A conexão com o Spotify expirou. Abra o endereço de configuração e conecte de novo.';
  if (r.indexOf('PREMIUM') > -1) return 'Esse comando exige Spotify Premium.';
  if (e.status === 403 && /not registered|developer dashboard/i.test(e.reason)) return 'Sua conta do Spotify não está liberada no app do Spotify for Developers. Adicione seu e-mail em "User Management" no app.';
  if (r === 'NO_ACTIVE_DEVICE' || (e.status === 404 && /device/i.test(e.reason))) return 'Nenhum aparelho com o Spotify aberto. Abra o Spotify no celular ou no computador e tente de novo.';
  if (e.status === 429) return 'O Spotify pediu para esperar um pouco' + (e.retryAfter ? ' (' + e.retryAfter + ' s)' : '') + '.';
  if (r === 'RESTRICTION_VIOLATED' || /restriction/i.test(e.reason)) return 'O Spotify não permitiu esse comando agora (por exemplo, durante um anúncio ou no fim da fila).';
  return 'O Spotify recusou o comando' + (e.reason ? ' (' + e.reason + ')' : '') + '.';
}

/* ---------- tokens ---------- */
async function tokenRequest(deps, params) {
  const r = await deps.fetch(ACCOUNTS + '/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (_) { /* resposta não JSON */ }
  if (!r.ok || !j || !j.access_token) throw new SpotifyError(r.status === 400 ? 401 : r.status, (j && (j.error === 'invalid_grant' ? 'INVALID_GRANT' : (j.error_description || j.error))) || 'TOKEN_ERROR');
  return j;
}
export async function getToken(deps) {
  const st = await deps.db.getState();
  if (!st || !st.refresh_token) { const e = new Error('not setup'); e.code = 'NOT_SETUP'; throw e; }
  if (st.access_token && st.expires_at && new Date(st.expires_at).getTime() - 60000 > deps.now()) return st.access_token;
  const j = await tokenRequest(deps, { grant_type: 'refresh_token', refresh_token: st.refresh_token, client_id: deps.clientId });
  await deps.db.saveState({
    access_token: j.access_token,
    expires_at: new Date(deps.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(),
    refresh_token: j.refresh_token || st.refresh_token,
  });
  return j.access_token;
}
export async function api(deps, method, path, opt) {
  const o = opt || {};
  const token = await getToken(deps);
  const u = new URL(API + path);
  if (o.query) for (const [k, v] of Object.entries(o.query)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const headers = { Authorization: 'Bearer ' + token };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await deps.fetch(u.toString(), { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  if (r.status === 204 || r.status === 202) return null;
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (_) { /* ignorado */ }
  if (!r.ok) {
    const er = j && j.error;
    throw new SpotifyError(r.status, (er && (er.reason || er.message)) || '', r.headers.get('retry-after'));
  }
  return j;
}

/* ---------- formato das respostas ---------- */
function artistsOf(it) {
  if (!it) return [];
  if (Array.isArray(it.artists)) return it.artists.map((a) => a && a.name).filter(Boolean);
  if (it.show && it.show.name) return [it.show.name];
  return [];
}
function itemOf(it) {
  if (!it) return null;
  return {
    type: it.type || 'track',
    name: it.name || '',
    artists: artistsOf(it),
    album: (it.album && it.album.name) || (it.show && it.show.name) || '',
    duration_ms: Number(it.duration_ms) || null,
    uri: it.uri || '',
    url: (it.external_urls && it.external_urls.spotify) || '',
  };
}
function deviceOf(d) {
  if (!d) return null;
  return { id: d.id || '', name: d.name || '', type: d.type || '', active: !!d.is_active, volume: d.volume_percent == null ? null : Number(d.volume_percent), supports_volume: d.supports_volume !== false, restricted: !!d.is_restricted };
}
function needUri(v, kinds) {
  const s = String(v || '').trim();
  if (!URI_RE.test(s) || (kinds && kinds.indexOf(s.split(':')[1]) < 0)) {
    const e = new Error('Endereço do Spotify inválido. Use um URI como spotify:track:...'); e.code = 'BAD_INPUT'; throw e;
  }
  return s;
}

/* ---------- ferramentas ---------- */
const RO = { readOnlyHint: true, openWorldHint: true };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const NOARGS = { type: 'object', properties: {}, additionalProperties: false };
const DEV = { type: 'string', description: 'Opcional: id do aparelho (veja a ferramenta dispositivos).' };
export const TOOLS = [
  { name: 'estado', title: 'Estado do player', description: 'O que está tocando agora no Spotify: música, artistas, tempo, aparelho, volume, aleatório e repetir. Responde {ativo:false} quando nada está tocando.', inputSchema: NOARGS, annotations: RO },
  { name: 'dispositivos', title: 'Aparelhos', description: 'Lista os aparelhos com o Spotify aberto (celular, computador, caixa de som).', inputSchema: NOARGS, annotations: RO },
  { name: 'tocar', title: 'Tocar', description: 'Começa a tocar um item: música (spotify:track:...), episódio, álbum, playlist ou artista. Toca no aparelho ativo ou no aparelho informado.', inputSchema: { type: 'object', properties: { uri: { type: 'string', description: 'URI do Spotify, ex.: spotify:track:4iV5W9uYEdYUVa79Axb7Rh' }, device_id: DEV }, required: ['uri'], additionalProperties: false }, annotations: RW },
  { name: 'continuar', title: 'Continuar', description: 'Continua a música pausada.', inputSchema: { type: 'object', properties: { device_id: DEV }, additionalProperties: false }, annotations: RW },
  { name: 'pausar', title: 'Pausar', description: 'Pausa a música.', inputSchema: NOARGS, annotations: RW },
  { name: 'proxima', title: 'Próxima', description: 'Pula para a próxima música.', inputSchema: NOARGS, annotations: RW },
  { name: 'anterior', title: 'Anterior', description: 'Volta para a música anterior.', inputSchema: NOARGS, annotations: RW },
  { name: 'volume', title: 'Volume', description: 'Muda o volume do aparelho ativo (0 a 100).', inputSchema: { type: 'object', properties: { percent: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['percent'], additionalProperties: false }, annotations: RW },
  { name: 'transferir', title: 'Trocar de aparelho', description: 'Passa a música para outro aparelho.', inputSchema: { type: 'object', properties: { device_id: { type: 'string' }, tocar: { type: 'boolean', description: 'Começar a tocar no novo aparelho (padrão: sim).' } }, required: ['device_id'], additionalProperties: false }, annotations: RW },
  { name: 'buscar', title: 'Buscar', description: 'Busca músicas, álbuns, playlists ou artistas no Spotify (até 10 resultados).', inputSchema: { type: 'object', properties: { q: { type: 'string' }, tipo: { type: 'string', enum: ['track', 'album', 'playlist', 'artist'] }, limite: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['q'], additionalProperties: false }, annotations: RO },
  { name: 'adicionar_fila', title: 'Adicionar à fila', description: 'Coloca uma música ou episódio na fila de reprodução.', inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false }, annotations: RW },
  { name: 'aleatorio', title: 'Aleatório', description: 'Liga ou desliga o modo aleatório.', inputSchema: { type: 'object', properties: { ligado: { type: 'boolean' } }, required: ['ligado'], additionalProperties: false }, annotations: RW },
  { name: 'repetir', title: 'Repetir', description: 'Modo de repetição: off (desligado), track (esta música) ou context (álbum/playlist).', inputSchema: { type: 'object', properties: { modo: { type: 'string', enum: ['off', 'track', 'context'] } }, required: ['modo'], additionalProperties: false }, annotations: RW },
];

export async function runTool(deps, name, a) {
  const args = a && typeof a === 'object' ? a : {};
  switch (name) {
    case 'estado': {
      const p = await api(deps, 'GET', '/me/player', { query: { additional_types: 'episode' } });
      if (!p || !p.item) return { ativo: !!(p && p.device), tocando: false, device: p ? deviceOf(p.device) : null };
      return { ativo: true, tocando: !!p.is_playing, progress_ms: Number(p.progress_ms) || 0, aleatorio: !!p.shuffle_state, repetir: p.repeat_state || 'off', device: deviceOf(p.device), item: itemOf(p.item), lido_em: deps.now() };
    }
    case 'dispositivos': {
      const d = await api(deps, 'GET', '/me/player/devices');
      return { dispositivos: ((d && d.devices) || []).map(deviceOf) };
    }
    case 'tocar': {
      const uri = needUri(args.uri);
      const kind = uri.split(':')[1];
      const body = kind === 'track' || kind === 'episode' ? { uris: [uri] } : { context_uri: uri };
      await api(deps, 'PUT', '/me/player/play', { query: { device_id: args.device_id }, body });
      return { ok: true, tocando: uri };
    }
    case 'continuar': await api(deps, 'PUT', '/me/player/play', { query: { device_id: args.device_id } }); return { ok: true };
    case 'pausar': await api(deps, 'PUT', '/me/player/pause'); return { ok: true };
    case 'proxima': await api(deps, 'POST', '/me/player/next'); return { ok: true };
    case 'anterior': await api(deps, 'POST', '/me/player/previous'); return { ok: true };
    case 'volume': {
      const v = Math.round(Number(args.percent));
      if (!(v >= 0 && v <= 100)) { const e = new Error('Volume deve ser de 0 a 100.'); e.code = 'BAD_INPUT'; throw e; }
      await api(deps, 'PUT', '/me/player/volume', { query: { volume_percent: v } });
      return { ok: true, volume: v };
    }
    case 'transferir': {
      const id = String(args.device_id || '').trim();
      if (!id) { const e = new Error('Informe o aparelho.'); e.code = 'BAD_INPUT'; throw e; }
      await api(deps, 'PUT', '/me/player', { body: { device_ids: [id], play: args.tocar !== false } });
      return { ok: true };
    }
    case 'buscar': {
      const q = String(args.q || '').trim().slice(0, 200);
      if (!q) { const e = new Error('Digite o que buscar.'); e.code = 'BAD_INPUT'; throw e; }
      const tipo = ['track', 'album', 'playlist', 'artist'].indexOf(args.tipo) > -1 ? args.tipo : 'track';
      const lim = Math.max(1, Math.min(10, Math.round(Number(args.limite) || 10)));
      const r = await api(deps, 'GET', '/search', { query: { q, type: tipo, limit: lim } });
      const box = r && r[tipo + 's'];
      const items = ((box && box.items) || []).filter(Boolean).map((it) => ({
        tipo, name: it.name || '', artists: artistsOf(it).length ? artistsOf(it) : (it.owner && it.owner.display_name ? [it.owner.display_name] : []),
        album: (it.album && it.album.name) || '', duration_ms: Number(it.duration_ms) || null, uri: it.uri || '', url: (it.external_urls && it.external_urls.spotify) || '',
      }));
      return { resultados: items };
    }
    case 'adicionar_fila': {
      const uri = needUri(args.uri, ['track', 'episode']);
      await api(deps, 'POST', '/me/player/queue', { query: { uri } });
      return { ok: true };
    }
    case 'aleatorio': await api(deps, 'PUT', '/me/player/shuffle', { query: { state: args.ligado ? 'true' : 'false' } }); return { ok: true, aleatorio: !!args.ligado };
    case 'repetir': {
      const m = ['off', 'track', 'context'].indexOf(args.modo) > -1 ? args.modo : 'off';
      await api(deps, 'PUT', '/me/player/repeat', { query: { state: m } });
      return { ok: true, repetir: m };
    }
    default: { const e = new Error('Ferramenta desconhecida: ' + name); e.code = 'UNKNOWN_TOOL'; throw e; }
  }
}

/* ---------- MCP (JSON-RPC) ---------- */
function rpcOk(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } }; }
async function rpc(m, deps) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id != null ? rpcErr(m.id, -32600, 'Invalid Request') : null;
  const notif = m.id === undefined || m.id === null;
  switch (m.method) {
    case 'initialize': {
      const asked = m.params && m.params.protocolVersion;
      return rpcOk(m.id, {
        protocolVersion: PROTOCOLS.indexOf(asked) > -1 ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'spotify-controle', title: 'Spotify Controle', version: '1.0.0' },
        instructions: 'Controla o Spotify do dono deste conector: ver o que toca, tocar, pausar, pular, trocar de aparelho, volume, busca e fila.',
      });
    }
    case 'ping': return notif ? null : rpcOk(m.id, {});
    case 'tools/list': return rpcOk(m.id, { tools: TOOLS });
    case 'tools/call': {
      const p = m.params || {};
      if (!TOOLS.some((t) => t.name === p.name)) return rpcErr(m.id, -32602, 'Unknown tool: ' + p.name);
      try {
        const out = await runTool(deps, p.name, p.arguments);
        return rpcOk(m.id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        const msg = friendly(e);
        return rpcOk(m.id, { content: [{ type: 'text', text: msg }], structuredContent: { erro: msg, codigo: e && (e.code || e.reason || e.status) || 'ERRO' }, isError: true });
      }
    }
    default:
      if (m.method.indexOf('notifications/') === 0 || notif) return null;
      return rpcErr(m.id, -32601, 'Method not found');
  }
}
async function mcp(req, deps, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'POST' } });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const st = await deps.db.getState();
  const fromPath = (path.match(/\/mcp\/([A-Za-z0-9_-]{20,})$/) || [])[1] || '';
  const key = fromPath || req.headers.get('x-mah-key') || '';
  if (!st || !st.api_key_hash || !key || !safeEqual(await sha256hex(key), st.api_key_hash)) return json(404, { error: 'not found' });
  let body;
  try { body = await req.json(); } catch (_) { return json(400, rpcErr(null, -32700, 'Parse error')); }
  const batch = Array.isArray(body);
  const out = [];
  for (const m of batch ? body : [body]) { const r = await rpc(m, deps); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202 });
  return json(200, batch ? out : out[0]);
}

/* ---------- configuração (login no Spotify) ---------- */
async function home(deps) {
  const st = await deps.db.getState();
  const ok = !!(st && st.refresh_token);
  return page(200, 'Spotify Controle', `<h1>Spotify Controle</h1>
<p>Conector pessoal do Multi Affiliate Hub para controlar o seu Spotify Premium pelo painel.</p>
<p>${ok ? '<span class="ok">Conectado</span>' + (st.spotify_user ? ' à conta <b>' + esc(st.spotify_user) + '</b>' : '') + '.' : '<span class="bad">Ainda não conectado.</span>'}</p>
${ok ? '<p class="m">Para conectar de novo ou gerar um novo endereço, abra o link de configuração com a sua chave atual.</p>' : (deps.clientId ? `<p><a class="btn" href="${esc(deps.baseUrl)}/login">Conectar o Spotify</a></p>` : '<p class="bad">Falta configurar o Client ID do app do Spotify (segredo SPOTIFY_CLIENT_ID).</p>')}`);
}
async function login(req, deps, url) {
  if (!deps.clientId) return page(500, 'Falta o Client ID', '<h1>Falta o Client ID</h1><p>Configure o segredo SPOTIFY_CLIENT_ID no Supabase com o Client ID do seu app do Spotify for Developers.</p>');
  const st = await deps.db.getState();
  if (st && st.api_key_hash) {
    const k = url.searchParams.get('key') || '';
    if (!k || !safeEqual(await sha256hex(k), st.api_key_hash)) {
      return page(403, 'Já configurado', '<h1>Já configurado</h1><p>Este conector já está ligado a uma conta. Para reconectar, abra este endereço com <code>?key=SUA_CHAVE</code> no final (a chave é a parte final do endereço do conector).</p>');
    }
  }
  const verifier = b64url(deps.randomBytes(64));
  const state = b64url(deps.randomBytes(24));
  await deps.db.putPending(state, verifier);
  const challenge = b64url(await sha256(verifier));
  const q = new URLSearchParams({
    response_type: 'code', client_id: deps.clientId, scope: SCOPES, redirect_uri: deps.baseUrl + '/callback',
    state, code_challenge_method: 'S256', code_challenge: challenge,
  });
  return new Response(null, { status: 302, headers: { Location: ACCOUNTS + '/authorize?' + q.toString(), 'Cache-Control': 'no-store' } });
}
async function callback(req, deps, url) {
  const err = url.searchParams.get('error');
  if (err) return page(400, 'Login cancelado', '<h1>Login cancelado</h1><p>O Spotify não autorizou (' + esc(err) + '). Volte e tente de novo.</p>');
  const code = url.searchParams.get('code') || '', state = url.searchParams.get('state') || '';
  const pend = state ? await deps.db.takePending(state) : null;
  if (!code || !pend || deps.now() - new Date(pend.created_at || 0).getTime() > 15 * 60000) {
    return page(400, 'Link expirado', '<h1>Link expirado</h1><p>Esse retorno do Spotify não é válido ou expirou. Comece de novo pelo endereço de configuração.</p>');
  }
  let tok;
  try {
    tok = await tokenRequest(deps, { grant_type: 'authorization_code', code, redirect_uri: deps.baseUrl + '/callback', client_id: deps.clientId, code_verifier: pend.verifier });
  } catch (e) {
    return page(400, 'Erro no login', '<h1>Não deu certo</h1><p>' + esc(friendly(e)) + '</p>');
  }
  if (!tok.refresh_token) return page(400, 'Erro no login', '<h1>Não deu certo</h1><p>O Spotify não devolveu a autorização completa. Tente de novo.</p>');
  const apiKey = b64url(deps.randomBytes(32));
  await deps.db.saveState({
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_at: new Date(deps.now() + (Number(tok.expires_in) || 3600) * 1000).toISOString(),
    api_key_hash: await sha256hex(apiKey),
    scopes: tok.scope || SCOPES,
  });
  let who = '';
  try { const me = await api(deps, 'GET', '/me'); who = (me && (me.display_name || me.id)) || ''; } catch (_) { /* nome é opcional */ }
  if (who) await deps.db.saveState({ spotify_user: who });
  const endpoint = deps.baseUrl + '/mcp/' + apiKey;
  return page(200, 'Spotify conectado', `<h1>Pronto, Spotify conectado${who ? ' (' + esc(who) + ')' : ''}!</h1>
<p>Agora adicione o conector no Claude. Este é o endereço dele. <b>Ele funciona como uma senha</b>: não compartilhe.</p>
<span class="key" id="u">${esc(endpoint)}</span>
<p><button class="btn" type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('u').textContent).then(function(){this.textContent='Copiado'}.bind(this))">Copiar endereço</button></p>
<ol>
<li>No Claude, abra <b>Configurações → Conectores</b> e toque em <b>Adicionar conector personalizado</b>.</li>
<li>Nome: <b>Spotify Controle</b> (exatamente assim, o painel procura por esse nome).</li>
<li>Endereço: cole o endereço acima. Autenticação: <b>sem login</b>.</li>
<li>Abra o painel, vá em <b>Música</b> e toque em <b>Ligar controle</b>.</li>
</ol>
<p class="m">Este endereço só aparece agora. Se perder, conecte de novo pelo link de configuração com <code>?key=</code> e a chave antiga, ou peça ao Claude para gerar um novo.</p>`);
}

/* ---------- entrada ---------- */
export async function handle(req, deps) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (/\/mcp(\/[A-Za-z0-9_-]+)?$/.test(path)) return await mcp(req, deps, path);
    if (/\/login$/.test(path)) return await login(req, deps, url);
    if (/\/callback$/.test(path)) return await callback(req, deps, url);
    if (req.method !== 'GET') return new Response(null, { status: 405 });
    return await home(deps);
  } catch (e) {
    return page(500, 'Erro', '<h1>Algo deu errado</h1><p>' + esc(friendly(e)) + '</p>');
  }
}
