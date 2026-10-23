// ads-proxy: lê dados de anúncios (Google Ads, Meta Ads, TikTok Ads) e do Instagram pelo Windsor.ai,
// só para membros com 2FA. A chave WINDSOR_API_KEY fica nos segredos do Supabase.
import { json, corsHeaders, requireMember, rateLimit, HttpError } from './mah.js';

const BASE = 'https://connectors.windsor.ai';
export const CONNECTORS = ['google_ads', 'facebook', 'tiktok', 'instagram', 'googleanalytics4'];
const FIELD_RE = /^[a-z0-9_]{1,64}$/;
const PRESET_RE = /^(last_\d{1,3}[dwmy]T?|last_year|last_2years|this_month|this_year|this_monthT|this_yearT)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clean(msg, key) {
  let s = String(msg || '').slice(0, 400);
  if (key) s = s.split(key).join('***');
  return s.replace(/api_key=[^&\s]+/g, 'api_key=***');
}

export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, 405, { erro: 'Use POST.' });
  try {
    const me = await requireMember(req, deps);
    rateLimit('ads:' + me.uid, 40, 60000, deps.now && deps.now());
    const key = deps.env('WINDSOR_API_KEY') || '';
    if (!key) return json(req, 503, { erro: 'A chave do Windsor.ai ainda não foi cadastrada no Supabase.', codigo: 'no_key' });
    let b = {};
    try { b = await req.json(); } catch (_) { throw new HttpError(400, 'bad_body', 'Pedido inválido.'); }
    const c = String(b.connector || '');
    if (CONNECTORS.indexOf(c) < 0) throw new HttpError(400, 'bad_connector', 'Plataforma não suportada.');
    let url;
    if (b.op === 'fields') {
      url = BASE + '/' + c + '/fields?api_key=' + encodeURIComponent(key);
    } else if (b.op === 'data') {
      const fields = (Array.isArray(b.fields) ? b.fields : []).map(String).filter((f) => FIELD_RE.test(f)).slice(0, 30);
      if (!fields.length) throw new HttpError(400, 'bad_fields', 'Escolha os campos.');
      const q = new URLSearchParams({ api_key: key, fields: fields.join(',') });
      if (b.date_from && DATE_RE.test(b.date_from)) { q.set('date_from', b.date_from); if (b.date_to && DATE_RE.test(b.date_to)) q.set('date_to', b.date_to); }
      else q.set('date_preset', PRESET_RE.test(b.date_preset || '') ? b.date_preset : 'last_30d');
      if (Array.isArray(b.accounts) && b.accounts.length) q.set('select_accounts', b.accounts.map(String).filter((a) => /^[A-Za-z0-9_.-]{1,40}$/.test(a)).slice(0, 20).join(','));
      url = BASE + '/' + c + '?' + q.toString();
    } else {
      throw new HttpError(400, 'bad_op', 'Operação inválida.');
    }
    const r = await deps.fetch(url, { headers: { Accept: 'application/json' } });
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (_) { /* não JSON */ }
    if (!r.ok) {
      const m = clean((j && (j.error || j.message || j.detail)) || txt, key);
      const none = /no .*accounts|not configured|select your accounts/i.test(m);
      return json(req, none ? 409 : 502, { erro: none ? 'Nenhuma conta dessa plataforma ligada no Windsor.ai.' : 'O Windsor.ai respondeu com erro.', detalhe: m, codigo: none ? 'not_linked' : 'upstream' });
    }
    if (b.op === 'fields') {
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j && Array.isArray(j.fields) ? j.fields : []));
      return json(req, 200, { campos: list.map((f) => (f && (f.id || f.name)) || '').filter(Boolean) });
    }
    const rows = j && Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
    return json(req, 200, { linhas: rows.slice(0, 5000), total: rows.length });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { erro: e.message, codigo: e.code });
    return json(req, 500, { erro: 'Erro inesperado.', codigo: 'internal' });
  }
}
