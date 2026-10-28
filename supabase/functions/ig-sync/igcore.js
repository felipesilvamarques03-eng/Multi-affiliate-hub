// Trecho da lógica pura do painel (Core): mesmas regras de leitura das métricas do Instagram.
// Manter igual ao Core do painel.
function igNum(v){ if(v==null || v==='') return null; var n = Number(v); return isFinite(n) ? n : null; }
function igTs(v){
  if(!v) return null;
  var s = String(v).trim().replace(' ', 'T');
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T12:00:00Z';
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if(!/(Z|[+-]\d{2}:\d{2})$/i.test(s)) s += 'Z';
  var d = new Date(s); return isNaN(d.getTime()) ? null : d;
}
function igTime(v){ var d = igTs(v); return d ? d.getTime() : 0; }
function igMax(a, b){ return a==null ? b : b==null ? a : Math.max(a,b); }
function igProfile(rows){
  var pool = rows.filter(function(r){ return igNum(r.followers_count)!=null; });
  if(!pool.length) pool = rows;
  if(!pool.length) return null;
  var r = pool.slice().sort(function(a,b){ var da = String(a.date||''), db = String(b.date||''); return da<db?1:da>db?-1:0; })[0];
  return {username:String(r.username || r.account_name || ''), name:String(r.name || r.account_name || ''), biography:String(r.biography||'').slice(0,300), website:String(r.website||''),
    followers:igNum(r.followers_count), following:igNum(r.follows_count), posts:igNum(r.media_count)};
}
var IG_DAILY_MAP = [['reach','reach'],['views','views'],['engaged','accounts_engaged'],['interactions','total_interactions'],['likes','likes'],['comments','comments'],['saves','saves'],['shares','shares'],['linkTaps','profile_links_taps'],['newFollowers','follower_count']];
var IG_DAILY_KEYS = IG_DAILY_MAP.map(function(p){ return p[0]; });
function igDaily(rows){
  var map = {};
  rows.forEach(function(r){
    var d = String(r.date||'').slice(0,10); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    var o = map[d]; if(!o){ o = map[d] = {date:d}; IG_DAILY_KEYS.forEach(function(k){ o[k] = null; }); }
    IG_DAILY_MAP.forEach(function(p){ var v = igNum(r[p[1]]); if(v!=null) o[p[0]] = (o[p[0]]||0) + v; });
  });
  return Object.keys(map).sort().map(function(k){ return map[k]; });
}
function igFormatOf(m){
  var t = String(m.type||'').toUpperCase(), p = String(m.product||'').toUpperCase();
  if(p.indexOf('REEL')>-1 || t.indexOf('REEL')>-1) return 'Reels';
  if(t==='CAROUSEL_ALBUM') return 'Carrossel';
  if(t==='VIDEO') return 'Vídeo';
  if(t==='IMAGE') return 'Foto';
  return 'Outro';
}
var IG_MEDIA_NUM = [['likes','media_like_count'],['comments','media_comments_count'],['saved','media_saved'],['shares','media_shares'],['engagementRaw','media_engagement'],['reach','media_reach'],['views','media_views'],['follows','media_follows'],['visits','media_profile_visits'],['avgWatchMs','media_reel_avg_watch_time']];
function igMedia(rows){
  var map = {}, order = [];
  rows.forEach(function(r){
    var id = String(r.media_id || r.media_permalink || '').trim(); if(!id) return;
    var m = map[id];
    if(!m){ m = map[id] = {id:id, ts:'', type:'', product:'', caption:'', link:''}; IG_MEDIA_NUM.forEach(function(p){ m[p[0]] = null; }); order.push(id); }
    if(!m.ts && (r.timestamp || r.date)) m.ts = String(r.timestamp || r.date);
    if(!m.type && r.media_type) m.type = String(r.media_type);
    if(!m.product && r.media_product_type) m.product = String(r.media_product_type);
    if(!m.caption && r.media_caption) m.caption = String(r.media_caption).slice(0,300);
    if(!m.link && /^https:\/\//.test(String(r.media_permalink||''))) m.link = String(r.media_permalink);
    IG_MEDIA_NUM.forEach(function(p){ m[p[0]] = igMax(m[p[0]], igNum(r[p[1]])); });
  });
  return order.map(function(id){
    var m = map[id], parts = [m.likes, m.comments, m.saved, m.shares].filter(function(x){ return x!=null; });
    m.engagement = m.engagementRaw!=null ? m.engagementRaw : (parts.length ? parts.reduce(function(a,b){ return a+b; },0) : null);
    delete m.engagementRaw;
    m.format = igFormatOf(m);
    m.rate = m.reach>0 && m.engagement!=null ? m.engagement/m.reach : null;
    return m;
  }).sort(function(a,b){ return igTime(b.ts) - igTime(a.ts); });
}
var IG_STORY_NUM = [['reach','story_reach'],['views','story_views'],['replies','story_replies'],['shares','story_shares'],['exits','story_exits'],['tapsF','story_taps_forward'],['tapsB','story_taps_back']];
function igStories(rows){
  var map = {}, order = [];
  rows.forEach(function(r){
    var id = String(r.story_id || r.story_permalink || '').trim(); if(!id) return;
    var s = map[id];
    if(!s){ s = map[id] = {id:id, ts:'', link:''}; IG_STORY_NUM.forEach(function(p){ s[p[0]] = null; }); order.push(id); }
    if(!s.ts && (r.story_timestamp || r.date)) s.ts = String(r.story_timestamp || r.date);
    if(!s.link && /^https:\/\//.test(String(r.story_permalink||''))) s.link = String(r.story_permalink);
    IG_STORY_NUM.forEach(function(p){ s[p[0]] = igMax(s[p[0]], igNum(r[p[1]])); });
  });
  return order.map(function(id){ var s = map[id]; s.exitRate = s.views>0 && s.exits!=null ? s.exits/s.views : null; return s; })
    .sort(function(a,b){ return igTime(b.ts) - igTime(a.ts); });
}
function igAudience(rows, nameKey, sizeKey){
  var dated = rows.filter(function(r){ return r.date; }), use = rows;
  if(dated.length){
    var max = dated.reduce(function(m,r){ var d = String(r.date); return d>m ? d : m; }, '');
    use = dated.filter(function(r){ return String(r.date)===max; });
  }
  var map = {};
  use.forEach(function(r){ var n = String(r[nameKey]==null ? '' : r[nameKey]).trim(), v = igNum(r[sizeKey]); if(!n || v==null) return; map[n] = (map[n]||0) + v; });
  var tot = 0; Object.keys(map).forEach(function(k){ tot += map[k]; });
  return Object.keys(map).map(function(k){ return {name:k, size:map[k], pct: tot>0 ? map[k]/tot : 0}; }).sort(function(a,b){ return b.size - a.size; });
}
function igComments(rows){
  var seen = {}, out = [];
  rows.forEach(function(r){
    var text = String(r.comment_text || '').trim(); if(!text) return;
    var k = String(r.comment_id || '') || (text+'|'+(r.comment_timestamp||''));
    if(seen[k]) return; seen[k] = 1;
    out.push({id:k, ts:String(r.comment_timestamp||''), user:String(r.comment_username||''), text:text.slice(0,240), likes:igNum(r.comment_like_count), replies:igNum(r.comment_reply_count)});
  });
  return out.sort(function(a,b){ return igTime(b.ts) - igTime(a.ts); });
}
function igHistoryUpsert(hist, date, v){
  var h = (hist||[]).filter(function(x){ return x && x.date!==date; });
  h.push({date:date, followers:igNum(v.followers), following:igNum(v.following), posts:igNum(v.posts), source:v.source||'api'});
  h.sort(function(a,b){ return a.date<b.date ? -1 : 1; });
  return h.slice(-400);
}
export const Core = {igNum:igNum, igTs:igTs, igProfile:igProfile, igDaily:igDaily, igFormatOf:igFormatOf, igMedia:igMedia, igStories:igStories, igAudience:igAudience, igComments:igComments, igHistoryUpsert:igHistoryUpsert};
