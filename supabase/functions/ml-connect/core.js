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


// ---------- publicação de anúncios (só depois do [CONFIRMAR] no painel) ----------
async function mlRaw(deps, token, path, init) {
  const r = await deps.fetch(API + path, { ...(init || {}), headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...((init && init.headers) || {}) } });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, j };
}
function mlCauses(j) {
  const out = [];
  if (j && Array.isArray(j.cause)) j.cause.forEach((c) => { if (c && (c.type === 'error' || !c.type) && c.message) out.push(String(c.message)); });
  if (!out.length && j && (j.message || j.error)) out.push(String(j.message || j.error));
  return out.slice(0, 8).map((m) => m.slice(0, 220));
}
const ATTR_ALWAYS = ['BRAND', 'MODEL', 'COLOR', 'GTIN', 'EMPTY_GTIN_REASON'];
function attrOut(a) {
  const t = a.tags || {};
  return {
    id: a.id, nome: a.name || a.id, tipo: a.value_type || 'string',
    obrigatorio: !!(t.required || t.catalog_required || a.id === 'BRAND' || a.id === 'MODEL'),
    condicional: !!t.conditional_required, oculto: !!t.hidden,
    valores: Array.isArray(a.values) ? a.values.slice(0, 80).map((v) => ({ id: String(v.id), nome: v.name })) : [],
    max: a.value_max_length || null, unidades: Array.isArray(a.allowed_units) ? a.allowed_units.slice(0, 10).map((u) => u.id) : [],
    dica: a.hint || a.tooltip || '',
  };
}
function cleanText(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); }
function picOk(deps, u) {
  const supa = envKeys(deps.env).url + '/storage/v1/object/public/vitrine/';
  return typeof u === 'string' && u.length < 600 && !/[\s"<>]/.test(u) && (u.indexOf(supa) === 0 || u.indexOf(APP_ORIGIN + '/assets/ml/') === 0);
}
export function buildItem(deps, it) {
  const title = cleanText(it.title, 80);
  if (title.length < 10 || title.length > 60) throw new HttpError(400, 'bad_title', 'O título precisa ter entre 10 e 60 caracteres.');
  if (!/^MLB\d{3,12}$/.test(String(it.category_id || ''))) throw new HttpError(400, 'bad_category', 'Escolha a categoria.');
  const price = Math.round(Number(it.price) * 100) / 100;
  if (!(price >= 5 && price <= 100000)) throw new HttpError(400, 'bad_price', 'Preço inválido.');
  const qty = Math.floor(Number(it.quantity));
  if (!(qty >= 1 && qty <= 9999)) throw new HttpError(400, 'bad_qty', 'Informe o estoque (1 a 9999).');
  const lt = it.listing_type === 'gold_pro' ? 'gold_pro' : 'gold_special';
  const pics = (Array.isArray(it.pictures) ? it.pictures : []).filter((u) => picOk(deps, u)).slice(0, 10);
  if (!pics.length) throw new HttpError(400, 'bad_pics', 'Adicione pelo menos a foto principal.');
  const attrs = [];
  (Array.isArray(it.attributes) ? it.attributes : []).slice(0, 60).forEach((a) => {
    const id = String((a && a.id) || '');
    if (!/^[A-Z0-9_]{2,60}$/.test(id)) return;
    const vid = a.value_id != null && /^-?\d{1,15}$/.test(String(a.value_id)) ? String(a.value_id) : null;
    const vname = cleanText(a.value_name, 255);
    if (!vid && !vname) return;
    attrs.push(vid ? { id, value_id: vid } : { id, value_name: vname });
  });
  const warr = cleanText(it.warranty || '90 dias', 40);
  const body = {
    title, category_id: it.category_id, price, currency_id: 'BRL', available_quantity: qty,
    buying_mode: 'buy_it_now', condition: it.condition === 'used' ? 'used' : 'new', listing_type_id: lt,
    pictures: pics.map((source) => ({ source })), attributes: attrs,
    sale_terms: [{ id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' }, { id: 'WARRANTY_TIME', value_name: warr }],
  };
  const description = cleanText(it.description, 50000);
  return { body, description };
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

  if (op === 'categorize') {
    const q = cleanText(b.q, 120);
    if (q.length < 3) throw new HttpError(400, 'bad_q', 'Escreva o título primeiro.');
    const j = await ml(deps, token, '/sites/MLB/domain_discovery/search?limit=4&q=' + encodeURIComponent(q));
    const seen = {}, out = [];
    (Array.isArray(j) ? j : []).forEach((c) => { if (c && c.category_id && !seen[c.category_id]) { seen[c.category_id] = 1; out.push({ id: c.category_id, nome: c.category_name || c.category_id, dominio: c.domain_name || '' }); } });
    return { categorias: out };
  }
  if (op === 'attributes') {
    const cid = String(b.category_id || '');
    if (!/^MLB\d{3,12}$/.test(cid)) throw new HttpError(400, 'bad_category', 'Categoria inválida.');
    const [cat, at] = await Promise.all([ml(deps, token, '/categories/' + cid), ml(deps, token, '/categories/' + cid + '/attributes')]);
    const list = (Array.isArray(at) ? at : []).filter((a) => {
      const t = a.tags || {};
      if (t.read_only || t.fixed) return false;
      if (ATTR_ALWAYS.indexOf(a.id) > -1) return true;
      if (t.hidden) return false;
      return !!(t.required || t.catalog_required || t.conditional_required);
    }).map(attrOut);
    const caminho = Array.isArray(cat && cat.path_from_root) ? cat.path_from_root.map((x) => x.name).join(' › ') : (cat && cat.name) || cid;
    return { categoria: { id: cid, caminho }, atributos: list };
  }
  if (op === 'publish') {
    if (b.confirm !== true) throw new HttpError(400, 'need_confirm', 'Confirme a publicação antes.');
    const { body, description } = buildItem(deps, b.item || {});
    let res = await mlRaw(deps, token, '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let usedFamily = false;
    if (!res.ok && res.status === 400 && /family_name/i.test(JSON.stringify(res.j || {}))) {
      const alt = { ...body, family_name: body.title }; delete alt.title; usedFamily = true;
      res = await mlRaw(deps, token, '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alt) });
    }
    if (!res.ok) {
      if (res.status === 401) throw new HttpError(401, 'ml_reconnect', 'O Mercado Livre recusou o acesso. Conecte de novo.');
      await db.insert('mah_audit', { owner: me.uid, action: 'ml.publish_fail', detail: { status: res.status, causas: mlCauses(res.j).slice(0, 4) } });
      const e = new HttpError(res.status === 403 ? 403 : 422, 'ml_rejected', 'O Mercado Livre não aceitou o anúncio.');
      e.causas = mlCauses(res.j);
      throw e;
    }
    const item = res.j || {};
    let descOk = true, descErr = '';
    if (description && item.id) {
      const d = await mlRaw(deps, token, '/items/' + encodeURIComponent(item.id) + '/description', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plain_text: description }) });
      if (!d.ok) { descOk = false; descErr = mlCauses(d.j).join(' · '); }
    }
    await db.insert('mah_audit', { owner: me.uid, action: 'ml.publish', detail: { item_id: item.id || null, titulo: body.title, preco: body.price, estoque: body.available_quantity, tipo: body.listing_type_id, familia: usedFamily, descricao: descOk } });
    return { ok: true, id: item.id || null, link: item.permalink || null, status: item.status || '', sub_status: Array.isArray(item.sub_status) ? item.sub_status : [], descricao_ok: descOk, descricao_erro: descErr };
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
    if (e instanceof HttpError) return json(req, e.status, { erro: e.message, codigo: e.code, ...(e.causas ? { causas: e.causas } : {}) });
    return json(req, 500, { erro: 'Erro inesperado.', codigo: 'internal' });
  }
}
