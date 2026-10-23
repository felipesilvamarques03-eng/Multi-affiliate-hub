// ml-connect: conexão oficial com o Mercado Livre (OAuth do app do próprio Felipe).
// Rotas: POST /start, GET /callback, POST /api  (o caminho pode vir com prefixo /ml-connect).
// Segredos no Supabase: ML_CLIENT_ID, ML_CLIENT_SECRET (e opcional MAH_TOKEN_KEY).
import { json, corsHeaders, requireMember, rateLimit, rest, seal, open, randomToken, s256, envKeys, HttpError, APP_ORIGIN } from './mah.js';

const AUTH = 'https://auth.mercadolivre.com.br/authorization';
const API = 'https://api.mercadolibre.com';

function redirectUri(deps) { return envKeys(deps.env).url + '/functions/v1/ml-connect/callback'; }
function back(status) { return new Response(null, { status: 302, headers: { Location: APP_ORIGIN + '/app/#mercadolivre?ml=' + status, 'Cache-Control': 'no-store' } }); }

async function form(deps, params) {
  const r = await deps.fetch(API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.access_token) throw new HttpError(r.status === 400 ? 401 : 502, 'ml_token', (j && (j.message || j.error)) || 'Falha ao obter o token do Mercado Livre.');
  return j;
}

async function saveTokens(deps, db, owner, tok, extra) {
  const row = {
    owner,
    access_enc: await seal(deps, tok.access_token),
    refresh_enc: await seal(deps, tok.refresh_token || ''),
    expires_at: new Date(deps.now() + (Number(tok.expires_in) || 10800) * 1000).toISOString(),
    scope: tok.scope || null,
    updated_at: new Date(deps.now()).toISOString(),
    ...(extra || {}),
  };
  await db.upsert('mah_ml_tokens', row, 'owner');
}

// Token válido; renova quando falta menos de 2 minutos. O refresh_token do ML é de uso único.
export async function accessToken(deps, db, owner) {
  const rows = await db.select('mah_ml_tokens', 'owner=eq.' + owner + '&select=*');
  const st = rows && rows[0];
  if (!st) throw new HttpError(409, 'ml_not_connected', 'O Mercado Livre ainda não foi conectado.');
  if (new Date(st.expires_at).getTime() - 120000 > deps.now()) return { token: await open(deps, st.access_enc), st };
  const refresh = await open(deps, st.refresh_enc);
  if (!refresh) throw new HttpError(401, 'ml_reconnect', 'A conexão com o Mercado Livre expirou. Conecte de novo.');
  let tok;
  try {
    tok = await form(deps, { grant_type: 'refresh_token', client_id: deps.env('ML_CLIENT_ID'), client_secret: deps.env('ML_CLIENT_SECRET'), refresh_token: refresh });
  } catch (e) {
    // outra chamada pode ter renovado ao mesmo tempo: relê antes de desistir
    const again = (await db.select('mah_ml_tokens', 'owner=eq.' + owner + '&select=*'))[0];
    if (again && again.refresh_enc !== st.refresh_enc && new Date(again.expires_at).getTime() > deps.now()) return { token: await open(deps, again.access_enc), st: again };
    throw new HttpError(401, 'ml_reconnect', 'A conexão com o Mercado Livre expirou. Conecte de novo.');
  }
  const patch = {
    access_enc: await seal(deps, tok.access_token),
    refresh_enc: await seal(deps, tok.refresh_token || refresh),
    expires_at: new Date(deps.now() + (Number(tok.expires_in) || 10800) * 1000).toISOString(),
    updated_at: new Date(deps.now()).toISOString(),
  };
  await db.update('mah_ml_tokens', 'owner=eq.' + owner + '&refresh_enc=eq.' + encodeURIComponent(st.refresh_enc), patch);
  return { token: tok.access_token, st: { ...st, ...patch } };
}

async function ml(deps, token, path, init) {
  const r = await deps.fetch(API + path, { ...(init || {}), headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...((init && init.headers) || {}) } });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const m = (j && (j.message || j.error)) || ('HTTP ' + r.status);
    if (r.status === 401) throw new HttpError(401, 'ml_reconnect', 'O Mercado Livre recusou o acesso. Conecte de novo.');
    if (r.status === 403) throw new HttpError(403, 'ml_forbidden', 'O Mercado Livre não permitiu essa ação (' + String(m).slice(0, 160) + ').');
    if (r.status === 429) throw new HttpError(429, 'ml_rate', 'O Mercado Livre pediu para esperar um pouco.');
    throw new HttpError(502, 'ml_error', 'Mercado Livre: ' + String(m).slice(0, 200));
  }
  return j;
}

const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
function order(o) {
  const items = (o.order_items || []).map((it) => ({
    titulo: (it.item && it.item.title) || '', item_id: (it.item && it.item.id) || '', qtd: n(it.quantity) || 0,
    preco: n(it.unit_price), tarifa: n(it.sale_fee),
  }));
  return {
    id: o.id, status: o.status || '', criado: o.date_created || '', fechado: o.date_closed || '',
    total: n(o.total_amount), pago: n(o.paid_amount), moeda: o.currency_id || 'BRL',
    comprador: (o.buyer && o.buyer.nickname) || '', envio_id: (o.shipping && o.shipping.id) || null,
    tags: Array.isArray(o.tags) ? o.tags.slice(0, 10) : [], itens: items,
    tarifas: items.reduce((s, it) => s + (it.tarifa || 0) * (it.qtd || 1), 0),
  };
}
function question(q) {
  return {
    id: q.id, texto: q.text || '', status: q.status || '', item_id: q.item_id || '', criado: q.date_created || '',
    resposta: q.answer ? { texto: q.answer.text || '', data: q.answer.date_created || '' } : null,
  };
}

async function api(req, deps, me, b) {
  const db = rest(deps);
  const op = String(b.op || '');
  if (op === 'status') {
    const rows = await db.select('mah_ml_tokens', 'owner=eq.' + me.uid + '&select=ml_user_id,nickname,expires_at,updated_at,scope');
    const r = rows && rows[0];
    return { conectado: !!r, apelido: r ? r.nickname : null, ml_user_id: r ? r.ml_user_id : null, atualizado: r ? r.updated_at : null, configurado: !!(deps.env('ML_CLIENT_ID') && deps.env('ML_CLIENT_SECRET')) };
  }
  if (op === 'disconnect') {
    await db.remove('mah_ml_tokens', 'owner=eq.' + me.uid);
    await db.insert('mah_audit', { owner: me.uid, action: 'ml.disconnect', detail: {} });
    return { ok: true };
  }
  const { token, st } = await accessToken(deps, db, me.uid);
  const sid = st.ml_user_id;
  if (op === 'me') {
    const u = await ml(deps, token, '/users/me');
    return { id: u.id, apelido: u.nickname, nivel: u.seller_reputation && u.seller_reputation.level_id, permalink: u.permalink };
  }
  if (op === 'orders') {
    const lim = Math.max(1, Math.min(50, Number(b.limit) || 30));
    const off = Math.max(0, Math.min(1000, Number(b.offset) || 0));
    const j = await ml(deps, token, '/orders/search?seller=' + sid + '&sort=date_desc&limit=' + lim + '&offset=' + off);
    return { pedidos: (j.results || []).map(order), total: (j.paging && j.paging.total) || 0 };
  }
  if (op === 'questions') {
    const status = b.status === 'ANSWERED' ? 'ANSWERED' : 'UNANSWERED';
    const j = await ml(deps, token, '/questions/search?seller_id=' + sid + '&status=' + status + '&api_version=4&sort_fields=date_created&sort_types=DESC&limit=50');
    return { perguntas: (j.questions || []).map(question), total: j.total || 0 };
  }
  if (op === 'items') {
    const s = await ml(deps, token, '/users/' + sid + '/items/search?status=active&limit=50');
    const ids = (s.results || []).slice(0, 50);
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const m = await ml(deps, token, '/items?ids=' + chunk.join(',') + '&attributes=id,title,price,available_quantity,sold_quantity,status,permalink,thumbnail,listing_type_id');
      (m || []).forEach((x) => { const it = x && x.body; if (it) out.push({ id: it.id, titulo: it.title, preco: n(it.price), estoque: n(it.available_quantity), vendidos: n(it.sold_quantity), status: it.status, link: it.permalink, foto: it.thumbnail, tipo: it.listing_type_id }); });
    }
    return { anuncios: out, total: (s.paging && s.paging.total) || out.length };
  }
  if (op === 'answer') {
    // Só depois do [CONFIRMAR] no painel. O texto vai exatamente como aprovado.
    if (b.confirm !== true) throw new HttpError(400, 'need_confirm', 'Confirme o envio antes.');
    const qid = Number(b.question_id);
    const text = String(b.text || '').trim();
    if (!(qid > 0) || text.length < 2) throw new HttpError(400, 'bad_answer', 'Resposta vazia.');
    const r = await ml(deps, token, '/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question_id: qid, text }) });
    await db.insert('mah_audit', { owner: me.uid, action: 'ml.answer', detail: { question_id: qid, chars: text.length } });
    return { ok: true, status: (r && r.status) || 'ANSWERED' };
  }
  throw new HttpError(400, 'bad_op', 'Operação inválida.');
}

export async function handle(req, deps) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    if (/\/callback$/.test(path) && req.method === 'GET') {
      if (url.searchParams.get('error')) return back('cancelado');
      const code = url.searchParams.get('code') || '', state = url.searchParams.get('state') || '';
      if (!code || !/^[A-Za-z0-9_-]{20,80}$/.test(state)) return back('invalido');
      const db = rest(deps);
      const taken = await db.remove('mah_ml_pending', 'state=eq.' + state);
      const p = taken && taken[0];
      if (!p || deps.now() - new Date(p.created_at).getTime() > 15 * 60000) return back('expirado');
      let tok;
      try {
        tok = await form(deps, { grant_type: 'authorization_code', client_id: deps.env('ML_CLIENT_ID'), client_secret: deps.env('ML_CLIENT_SECRET'), code, redirect_uri: redirectUri(deps), code_verifier: p.verifier });
      } catch (_) { return back('erro'); }
      let nick = null, uid = n(tok.user_id);
      try { const u = await ml(deps, tok.access_token, '/users/me'); nick = u.nickname || null; uid = n(u.id) || uid; } catch (_) { /* opcional */ }
      await saveTokens(deps, db, p.owner, tok, { ml_user_id: uid, nickname: nick });
      await db.insert('mah_audit', { owner: p.owner, action: 'ml.connect', detail: { nickname: nick, refresh: !!tok.refresh_token } });
      return back(tok.refresh_token ? 'ok' : 'sem_renovacao');
    }
    if (req.method !== 'POST') return json(req, 405, { erro: 'Use POST.' });
    const me = await requireMember(req, deps);
    rateLimit('ml:' + me.uid, 60, 60000, deps.now());
    if (/\/start$/.test(path)) {
      if (!deps.env('ML_CLIENT_ID') || !deps.env('ML_CLIENT_SECRET')) throw new HttpError(503, 'ml_no_app', 'Cadastre ML_CLIENT_ID e ML_CLIENT_SECRET nos segredos do Supabase.');
      const db = rest(deps);
      await db.remove('mah_ml_pending', 'created_at=lt.' + new Date(deps.now() - 3600000).toISOString());
      const state = randomToken(24), verifier = randomToken(48);
      await db.insert('mah_ml_pending', { state, owner: me.uid, verifier });
      const q = new URLSearchParams({ response_type: 'code', client_id: deps.env('ML_CLIENT_ID'), redirect_uri: redirectUri(deps), state, code_challenge: await s256(verifier), code_challenge_method: 'S256' });
      return json(req, 200, { url: AUTH + '?' + q.toString() });
    }
    if (/\/api$/.test(path)) {
      let b = {};
      try { b = await req.json(); } catch (_) { throw new HttpError(400, 'bad_body', 'Pedido inválido.'); }
      return json(req, 200, await api(req, deps, me, b));
    }
    return json(req, 404, { erro: 'Rota não encontrada.' });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { erro: e.message, codigo: e.code });
    return json(req, 500, { erro: 'Erro inesperado.', codigo: 'internal' });
  }
}
