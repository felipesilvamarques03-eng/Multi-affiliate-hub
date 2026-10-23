// Entrega o código do painel só para quem está logado, com 2FA e convidado.
// Sem login válido, nada do código do painel sai do servidor (proteção contra cópia).
import { HTML, JS } from '../lib/panel_bundle.mjs';

const SUPA = 'https://znfmookzymtymgalwlly.supabase.co';
const KEY = 'sb_publishable_Hf3LLiQusqyArfjlPlA7iA_fg0Bl3J7';

function claims(tok) {
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')); } catch (e) { return {}; }
}
function out(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return out(405, { erro: 'Use GET.' });
  const tok = ((req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  if (tok.split('.').length !== 3) return out(401, { erro: 'Entre no painel.' });
  const u = await fetch(SUPA + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + tok } }).catch(() => null);
  if (!u || !u.ok) return out(401, { erro: 'Sessão inválida.' });
  if (claims(tok).aal !== 'aal2') return out(403, { erro: 'Verificação em 2 etapas pendente.' });
  const w = await fetch(SUPA + '/rest/v1/rpc/mah_whoami', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  const who = w && w.ok ? await w.json() : null;
  if (!who || !who.member) return out(403, { erro: 'Acesso não liberado.' });
  return out(200, { html: HTML, js: JS });
};

export const config = { path: '/api/panel' };
