// ig-sync: busca as métricas do Instagram da loja no Windsor.ai e guarda em mah_ig_state.
// Roda sozinha pelo agendamento (pg_cron, a cada 3 h) e também pelo botão "Atualizar" do painel.
import { HttpError, json, corsHeaders, requireMember, rest, seal, open, rateLimit } from './mah.js';
import { Core } from './igcore.js';

const API = 'https://connectors.windsor.ai';
const DAYS = 90; // o painel recorta 7, 30 ou 90 dias a partir destes dados

// Mesmos grupos de métricas que a aba Instagram já usa.
export const GROUPS = {
  profile: ['date', 'username', 'name', 'account_name', 'biography', 'website', 'followers_count', 'follows_count', 'media_count'],
  daily: ['date', 'reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'profile_links_taps', 'follower_count'],
  split: ['date', 'reach_followers', 'reach_non_followers', 'views_followers', 'views_non_followers'],
  media: ['media_id', 'timestamp', 'media_type', 'media_product_type', 'media_caption', 'media_permalink', 'media_like_count', 'media_comments_count', 'media_reach', 'media_views', 'media_saved', 'media_shares', 'media_engagement', 'media_follows', 'media_profile_visits', 'media_reel_avg_watch_time'],
  stories: ['story_id', 'story_timestamp', 'story_permalink', 'story_reach', 'story_views', 'story_replies', 'story_shares', 'story_exits', 'story_taps_forward', 'story_taps_back'],
  gender: ['date', 'audience_gender_name', 'audience_gender_size'],
  age: ['date', 'audience_age_name', 'audience_age_size'],
  city: ['date', 'city', 'audience_city_size'],
  country: ['date', 'audience_country_name', 'audience_country_size'],
  comments: ['comment_id', 'comment_timestamp', 'comment_username', 'comment_text', 'comment_like_count', 'comment_reply_count'],
};
const DIMS = new Set(['date', 'account_id', 'account_name', 'username', 'name', 'biography', 'website', 'media_id', 'timestamp', 'media_type', 'media_product_type', 'media_caption', 'media_permalink', 'story_id', 'story_timestamp', 'story_permalink', 'audience_gender_name', 'audience_age_name', 'city', 'audience_country_name', 'comment_id', 'comment_timestamp', 'comment_text', 'comment_username']);
const AUD = ['gender', 'age', 'city', 'country'];

// Quando o plano do Windsor está estourado, ele devolve linhas com zeros e um aviso no lugar do texto.
const PAUSED_RE = /not your real numbers|reads are paused/i;

export function todayBR(now) {
  return new Date(now - 3 * 3600e3).toISOString().slice(0, 10);
}

function parse(g, rows) {
  switch (g) {
    case 'profile': return Core.igProfile(rows);
    case 'daily': return Core.igDaily(rows);
    case 'split': return rows.map((r) => ({ date: String(r.date || '').slice(0, 10), reach_followers: r.reach_followers, reach_non_followers: r.reach_non_followers, views_followers: r.views_followers, views_non_followers: r.views_non_followers }));
    case 'media': return Core.igMedia(rows).slice(0, 200);
    case 'stories': return Core.igStories(rows).slice(0, 100);
    case 'gender': return Core.igAudience(rows, 'audience_gender_name', 'audience_gender_size');
    case 'age': return Core.igAudience(rows, 'audience_age_name', 'audience_age_size');
    case 'city': return Core.igAudience(rows, 'city', 'audience_city_size').slice(0, 15);
    case 'country': return Core.igAudience(rows, 'audience_country_name', 'audience_country_size').slice(0, 10);
    case 'comments': return Core.igComments(rows).slice(0, 100);
  }
  return null;
}

function windsorError(status, j) {
  const e = j && j.error;
  const msg = typeof e === 'string' ? e : (e && e.message) || '';
  if (status === 401 || /not authorized|invalid api key/i.test(msg)) return new HttpError(400, 'bad_key', 'O Windsor.ai recusou a chave da API. Confira a chave em onboard.windsor.ai.');
  if (status === 429) return new HttpError(429, 'windsor_limit', 'O Windsor.ai pediu uma pausa (limite de chamadas). A próxima sincronização tenta de novo.');
  return new HttpError(502, 'windsor', 'Windsor.ai: ' + (msg ? msg.slice(0, 240) : 'erro ' + status + '.'));
}

async function windsorGet(deps, path, params) {
  const q = new URLSearchParams(params);
  const r = await deps.fetch(API + path + '?' + q.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'multi-affiliate-hub/1.0' } });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch (_) { j = null; }
  if (!r.ok || (j && j.error)) throw windsorError(r.status, j);
  return j;
}

async function availableFields(deps, key) {
  try {
    const j = await windsorGet(deps, '/instagram/fields', { api_key: key });
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    const ids = new Set(list.map((f) => (typeof f === 'string' ? f : f && f.id)).filter(Boolean));
    return ids.size ? ids : null;
  } catch (e) {
    if (e.code === 'bad_key') throw e;
    return null; // sem a lista, pede todos os campos e deixa o Windsor ignorar os que não existem
  }
}

/* Uma sincronização completa. Grupos que falham mantêm o valor anterior. */
export async function runSync(deps, db, source) {
  const now = deps.now();
  const [cfg] = await db.select('mah_ig_config', 'id=eq.1&select=windsor_key,account_id');
  const [prevRow] = await db.select('mah_ig_state', 'id=eq.1&select=data');
  const prev = (prevRow && prevRow.data) || {};
  let key = deps.env('WINDSOR_API_KEY');
  if (!key && cfg && cfg.windsor_key) key = await open(deps, cfg.windsor_key);
  if (!key) {
    await db.update('mah_ig_state', 'id=eq.1', { last_run_at: new Date(now).toISOString(), last_status: 'no_key', last_error: 'Falta a chave da API do Windsor.ai.', last_source: source });
    throw new HttpError(400, 'no_key', 'Falta a chave da API do Windsor.ai. Cole a chave na aba Instagram do painel.');
  }
  const account = (cfg && cfg.account_id) || '';
  try { return await pull(deps, db, source, now, key, account, prev); }
  catch (e) {
    if (e.code === 'bad_key') await db.update('mah_ig_state', 'id=eq.1', { last_run_at: new Date(now).toISOString(), last_status: 'bad_key', last_error: e.message, last_source: source });
    throw e;
  }
}

async function pull(deps, db, source, now, key, account, prev) {
  const fields = await availableFields(deps, key);

  const out = { account: account ? { id: account } : null, profile: null, daily: [], splitDaily: [], media: [], stories: [], audience: { gender: [], age: [], city: [], country: [] }, comments: [], history: Array.isArray(prev.history) ? prev.history : [] };
  const errs = {};
  let paused = '';
  let okCount = 0;

  await Promise.all(Object.keys(GROUPS).map(async (g) => {
    const want = GROUPS[g].filter((f) => !fields || fields.has(f));
    if (!want.some((f) => !DIMS.has(f))) { errs[g] = 'O Windsor não oferece essas métricas para esta conta.'; return; }
    const preset = (g === 'profile' || AUD.includes(g)) ? 'last_3dT' : 'last_' + DAYS + 'dT';
    try {
      const params = { api_key: key, fields: want.join(','), date_preset: preset };
      if (account) params.select_accounts = account;
      const j = await windsorGet(deps, '/instagram', params);
      const rows = j && Array.isArray(j.data) ? j.data : [];
      const warn = rows.find((r) => Object.values(r).some((v) => typeof v === 'string' && PAUSED_RE.test(v)));
      if (warn) { paused = Object.values(warn).find((v) => typeof v === 'string' && PAUSED_RE.test(v)); return; }
      const val = parse(g, rows);
      if (AUD.includes(g)) out.audience[g] = val || [];
      else if (g === 'split') out.splitDaily = val || [];
      else out[g] = val;
      okCount++;
    } catch (e) {
      if (e.code === 'bad_key') throw e;
      errs[g] = e.message || 'Falha ao buscar.';
    }
  }));

  const stamp = new Date(now).toISOString();
  if (paused) {
    // Não grava zeros falsos: mantém os últimos dados bons.
    const msg = 'O Windsor.ai pausou as leituras: o plano grátis aceita 1 conta e há 2 conectadas. Desconecte a conta que não usa em onboard.windsor.ai/app (ou faça upgrade).';
    await db.update('mah_ig_state', 'id=eq.1', { last_run_at: stamp, last_status: 'paused', last_error: msg, last_source: source });
    throw new HttpError(409, 'paused', msg);
  }
  if (!okCount) {
    const msg = Object.values(errs)[0] || 'Nenhuma métrica voltou do Windsor.ai.';
    await db.update('mah_ig_state', 'id=eq.1', { last_run_at: stamp, last_status: 'error', last_error: msg, last_source: source });
    throw new HttpError(502, 'empty', msg);
  }
  // Grupos que falharam ficam com o valor da última sincronização boa.
  for (const g of Object.keys(errs)) {
    if (AUD.includes(g)) out.audience[g] = (prev.audience && prev.audience[g]) || [];
    else if (g === 'split') out.splitDaily = prev.splitDaily || [];
    else if (prev[g] != null) out[g] = prev[g];
  }
  if (out.profile && out.profile.followers != null) {
    out.history = Core.igHistoryUpsert(out.history, todayBR(now), { followers: out.profile.followers, following: out.profile.following, posts: out.profile.posts, source: 'api' }).slice(-400);
  }
  out.errors = errs;
  out.fetchedAt = now;
  const status = Object.keys(errs).length ? 'partial' : 'ok';
  await db.update('mah_ig_state', 'id=eq.1', { data: out, fetched_at: stamp, last_run_at: stamp, last_status: status, last_error: Object.keys(errs).length ? Object.keys(errs).length + ' grupo(s) de métricas não carregaram.' : null, last_source: source });
  return out;
}

async function snapshot(db, member) {
  const [st] = await db.select('mah_ig_state', 'id=eq.1&select=data,fetched_at,last_run_at,last_status,last_error,last_source');
  const [cfg] = await db.select('mah_ig_config', 'id=eq.1&select=windsor_key,account_id');
  return {
    data: st && st.data && st.data.fetchedAt ? st.data : null,
    status: {
      fetchedAt: st && st.fetched_at, lastRunAt: st && st.last_run_at, lastStatus: st && st.last_status, lastError: st && st.last_error, lastSource: st && st.last_source,
      hasKey: !!(cfg && cfg.windsor_key), account: (cfg && cfg.account_id) || '', owner: !!member.owner, everyHours: 3,
    },
  };
}

export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { erro: 'Use POST.' });
  try {
    const db = rest(deps);
    const cronTok = req.headers.get('x-ig-cron');
    if (cronTok) {
      const [cfg] = await db.select('mah_ig_config', 'id=eq.1&select=cron_hash');
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cronTok)))).map((b) => b.toString(16).padStart(2, '0')).join('');
      if (!cfg || !cfg.cron_hash || h !== cfg.cron_hash) return json(req, 401, { erro: 'Não autorizado.' });
      try { await runSync(deps, db, 'cron'); return json(req, 200, { ok: true }); }
      catch (e) { return json(req, 200, { ok: false, code: e.code, erro: e.message }); }
    }

    const member = await requireMember(req, deps);
    let body = {};
    try { body = await req.json(); } catch (_) { body = {}; }
    const op = String(body.op || 'get');

    if (op === 'get') return json(req, 200, await snapshot(db, member));

    if (op === 'run') {
      rateLimit('ig-run:' + member.uid, 6, 10 * 60e3, deps.now());
      let err = null;
      try { await runSync(deps, db, 'painel'); } catch (e) { err = e; }
      const snap = await snapshot(db, member);
      if (err) snap.erro = err.message;
      return json(req, 200, snap);
    }

    if (op === 'set_key' || op === 'clear_key' || op === 'set_account') {
      if (!member.owner) throw new HttpError(403, 'owner_only', 'Só o dono do painel pode mudar a conexão.');
      rateLimit('ig-key:' + member.uid, 10, 10 * 60e3, deps.now());
      const patch = { updated_at: new Date(deps.now()).toISOString() };
      if (op === 'set_key') {
        const k = String(body.key || '').trim();
        if (!/^[A-Za-z0-9._-]{16,200}$/.test(k)) throw new HttpError(400, 'bad_key_format', 'Essa não parece uma chave da API do Windsor.ai.');
        patch.windsor_key = await seal(deps, k);
      } else if (op === 'clear_key') patch.windsor_key = null;
      else {
        const a = String(body.account || '').trim();
        if (a && !/^[0-9]{5,30}$/.test(a)) throw new HttpError(400, 'bad_account', 'Conta inválida.');
        patch.account_id = a || null;
      }
      await db.update('mah_ig_config', 'id=eq.1', patch);
      let err = null;
      if (op !== 'clear_key') { try { await runSync(deps, db, 'painel'); } catch (e) { err = e; } }
      const snap = await snapshot(db, member);
      if (err) snap.erro = err.message;
      return json(req, 200, snap);
    }
    throw new HttpError(400, 'bad_op', 'Operação desconhecida.');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json(req, status, { erro: e instanceof HttpError ? e.message : 'Erro inesperado.', code: e && e.code });
  }
}
