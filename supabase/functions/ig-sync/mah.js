// Utilidades comuns das funções do Multi Affiliate Hub (Supabase Edge Functions).
// JavaScript puro: roda no Deno (produção) e no Node 22 (testes).

export const APP_ORIGIN = 'https://multi-affiliate-hub.netlify.app';
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+--multi-affiliate-hub\.netlify\.app$/;

export function envKeys(env) {
  const parse = (name) => { try { const j = JSON.parse(env(name) || ''); return j && (j.default || Object.values(j)[0]); } catch (_) { return ''; } };
  return {
    url: (env('SUPABASE_URL') || '').replace(/\/+$/, ''),
    publishable: parse('SUPABASE_PUBLISHABLE_KEYS') || env('SUPABASE_ANON_KEY') || '',
    secret: parse('SUPABASE_SECRET_KEYS') || env('SUPABASE_SERVICE_ROLE_KEY') || '',
  };
}

/* ---------- CORS (só o painel publicado) ---------- */
export function corsHeaders(req) {
  const o = req.headers.get('origin') || '';
  if (o !== APP_ORIGIN && !PREVIEW_RE.test(o)) return {};
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
export function json(req, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(req) },
  });
}

/* ---------- quem está chamando ---------- */
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
export function jwtPayload(token) {
  try { return JSON.parse(decodeURIComponent(escape(b64urlDecode(token.split('.')[1] || '')))); } catch (_) { return null; }
}
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
// Valida o token no Supabase Auth, exige 2FA (aal2) e e-mail convidado.
export async function requireMember(req, deps) {
  const k = envKeys(deps.env);
  const auth = req.headers.get('authorization') || '';
  const token = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  if (!token || token.split('.').length !== 3) throw new HttpError(401, 'no_session', 'Entre no painel de novo.');
  const r = await deps.fetch(k.url + '/auth/v1/user', { headers: { apikey: k.publishable, Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new HttpError(401, 'bad_session', 'Sua sessão expirou. Entre de novo.');
  const user = await r.json();
  const claims = jwtPayload(token) || {};
  if (claims.aal !== 'aal2') throw new HttpError(403, 'need_2fa', 'Confirme o código do aplicativo autenticador (2FA).');
  const w = await deps.fetch(k.url + '/rest/v1/rpc/mah_whoami', {
    method: 'POST', headers: { apikey: k.publishable, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}',
  });
  const who = w.ok ? await w.json() : null;
  if (!who || !who.member) throw new HttpError(403, 'not_member', 'Seu e-mail não está liberado neste painel.');
  return { uid: user.id, email: user.email, owner: !!who.owner, token };
}

/* ---------- banco com a chave secreta (só no servidor) ---------- */
export function rest(deps) {
  const k = envKeys(deps.env);
  const legacyJwt = k.secret.split('.').length === 3;
  const h = (extra) => ({ apikey: k.secret, ...(legacyJwt ? { Authorization: 'Bearer ' + k.secret } : {}), 'Content-Type': 'application/json', ...(extra || {}) });
  async function call(method, path, body, prefer) {
    const r = await deps.fetch(k.url + '/rest/v1/' + path, { method, headers: h(prefer ? { Prefer: prefer } : null), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new HttpError(500, 'db_error', 'Falha no banco (' + r.status + ').');
    return t ? JSON.parse(t) : null;
  }
  return {
    select: (table, q) => call('GET', table + '?' + q),
    insert: (table, row) => call('POST', table, row, 'return=representation'),
    upsert: (table, row, onConflict) => call('POST', table + '?on_conflict=' + onConflict, row, 'resolution=merge-duplicates,return=representation'),
    update: (table, q, patch) => call('PATCH', table + '?' + q, patch, 'return=representation'),
    remove: (table, q) => call('DELETE', table + '?' + q, undefined, 'return=representation'),
  };
}

/* ---------- criptografia dos tokens (AES-256-GCM, chave fora do banco) ---------- */
const keyCache = new Map();
async function aesKey(deps) {
  const material = deps.env('MAH_TOKEN_KEY') || envKeys(deps.env).secret;
  if (!material) throw new HttpError(500, 'no_key', 'Chave de criptografia ausente.');
  if (keyCache.has(material)) return keyCache.get(material);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('multi-affiliate-hub'), info: new TextEncoder().encode('mah-tokens-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(material, key);
  return key;
}
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function unb64(s) { const t = atob(s); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; }
export async function seal(deps, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(deps), new TextEncoder().encode(String(text))));
  return 'v1.' + b64(iv) + '.' + b64(ct);
}
export async function open(deps, sealed) {
  const p = String(sealed || '').split('.');
  if (p.length !== 3 || p[0] !== 'v1') throw new HttpError(500, 'bad_cipher', 'Token salvo em formato inválido.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p[1]) }, await aesKey(deps), unb64(p[2]));
  return new TextDecoder().decode(pt);
}

/* ---------- limite de chamadas por pessoa (por instância) ---------- */
const buckets = new Map();
export function rateLimit(id, max, windowMs, now) {
  const t = now || Date.now();
  const b = buckets.get(id) || { start: t, n: 0 };
  if (t - b.start > windowMs) { b.start = t; b.n = 0; }
  b.n++;
  buckets.set(id, b);
  if (b.n > max) throw new HttpError(429, 'rate_limited', 'Muitas chamadas seguidas. Espere um minuto.');
}

export function randomToken(bytes) {
  const u = crypto.getRandomValues(new Uint8Array(bytes || 32));
  return b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function s256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return b64(d).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
