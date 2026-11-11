/* 账号页的筛选与勾选逻辑（纯函数，测试里直接加载） */
(function(g){
'use strict';
const TIERS=['PRO','ULTRA','FREE'];
const STATUSES=['ok','cooldown','banned','disabled'];
const tierOf=a=>a.tier||'';
function match(a,f,skip){
  const q=(f.q||'').trim().toLowerCase();
  if(q&&!String(a.email||'').toLowerCase().includes(q)&&!String(a.note||'').toLowerCase().includes(q))return false;
  if(skip!=='tier'&&f.tier&&tierOf(a)!==f.tier)return false;
  if(skip!=='status'&&f.status&&a.status!==f.status)return false;
  return true;
}
/** 当前筛选下可见的账号（保持原顺序） */
const filter=(list,f)=>list.filter(a=>match(a,f));
/** 套餐筛选条的数字：只看搜索和状态，不看套餐本身 */
function tierCounts(list,f){
  const n={all:0};for(const t of TIERS)n[t]=0;
  for(const a of list){if(!match(a,f,'tier'))continue;n.all++;if(n[tierOf(a)]!=null)n[tierOf(a)]++;}
  return n;
}
function statusCounts(list,f){
  const n={all:0};for(const s of STATUSES)n[s]=0;
  for(const a of list){if(!match(a,f,'status'))continue;n.all++;n[a.status]++;}
  return n;
}
/** 表头全选：只动当前可见的行 */
function toggleAll(sel,visibleIds,on){
  const s=new Set(sel);
  for(const id of visibleIds){if(on)s.add(id);else s.delete(id);}
  return s;
}
/** 表头复选框的状态 */
function headState(sel,visibleIds){
  let n=0;for(const id of visibleIds)if(sel.has(id))n++;
  return n===0?'none':n===visibleIds.length?'all':'some';
}
/** shift 点选：从上一次点的行到这一行，全部设成 on（只在可见行里算） */
function rangeSelect(sel,visibleIds,anchor,id,on){
  const s=new Set(sel),a=visibleIds.indexOf(anchor),b=visibleIds.indexOf(id);
  if(a<0||b<0){if(on)s.add(id);else s.delete(id);return s;}
  for(let i=Math.min(a,b);i<=Math.max(a,b);i++){if(on)s.add(visibleIds[i]);else s.delete(visibleIds[i]);}
  return s;
}
/** 筛选一变，看不见的就不再算“已选”，免得批量操作误伤 */
const prune=(sel,visibleIds)=>{const v=new Set(visibleIds);return new Set([...sel].filter(id=>v.has(id)));};
/** 数据或筛选一变：勾选只留看得见的；reset 时（筛选/搜索变了、全选、取消、删除后）shift 锚点作废，锚点不可见也作废 */
function reconcile(sel,anchor,visibleIds,reset){
  return {sel:prune(sel,visibleIds),anchor:!reset&&anchor!=null&&visibleIds.includes(anchor)?anchor:null};
}
/* 排序（表头点选）：键前加 '-' 是倒序。状态（封号 > 冷却 > 正常 > 停用）、邮箱、等级（ULTRA 在前）、最近使用（近的在前）、
   5H / 7天剩余（少的在前；各模型族取最少，重置时间已过的算已恢复）、最早恢复（还没满的窗口里最早的重置时间）。
   没有数据的不管正序倒序都排最后，并列按邮箱 A→Z */
const SORTS=[['quota','模型配额'],['gemini','Gemini 3.8'],['claude','Claude / GPT'],['argon','Gemini 4 Argon'],['carbon','Gemini 4 Carbon'],['created','导入时间'],
  ['email','账号'],['status','状态'],['tier','等级'],['used','最近使用'],['h5','5H'],['week','7D'],['reset','最早恢复']];
/** 凭证页表头只排模型配额 */
const QUOTA_SORTS=['quota'];
const ST_ORDER={banned:0,cooldown:1,ok:2,disabled:3};
const TIER_ORDER={ULTRA:0,PRO:1,FREE:2};
const FAMS=['gemini','claude','argon','carbon'];
const liveB=(b,now)=>b&&b.reset&&Date.parse(b.reset)<=now?{frac:1,reset:null}:b;
function buckets(a,win,now){
  const q=a.quota;if(!q||q.forbidden)return [];
  const out=[];
  for(const k of FAMS){const f=q[k];if(!f)continue;for(const w of win){const b=liveB(f[w],now);if(b)out.push(b);}}
  return out;
}
function minFrac(a,win,now){const b=buckets(a,[win],now);return b.length?Math.min(...b.map(x=>x.frac)):null;}
function nextReset(a,now){
  let t=null;
  for(const b of buckets(a,['h5','week'],now)){if(b.frac>=1||!b.reset)continue;const x=Date.parse(b.reset);if(Number.isFinite(x)&&(t==null||x<t))t=x;}
  return t;
}
const em=a=>String(a.email||'').toLowerCase();
/** 某个模型还剩多少：5H / 7D 里少的那个；封号、403、没开通、没数据都算没有（不管正序倒序都排最后） */
function famLeft(a,k,now){
  const q=a.quota;if(!q||q.forbidden||a.status==='banned')return null;
  if((k==='argon'||k==='carbon')&&q[k+'State']!=='on')return null;
  const f=q[k];if(!f)return null;
  const v=[liveB(f.h5,now),liveB(f.week,now)].filter(Boolean).map(b=>b.frac);
  return v.length?Math.min(...v):null;
}
/** 总配额：四个模型各自剩余（0–1）加起来；封号、403、没数据算没有 */
function totalLeft(a,now){
  const q=a.quota;if(!q||q.forbidden||a.status==='banned')return null;
  let t=0,n=0;for(const k of FAMS){const v=famLeft(a,k,now);if(v!=null){t+=v;n++;}}
  return n?t:null;
}
function createdVal(a){const t=Date.parse(a.createdAt||'');return Number.isFinite(t)?t:(a.createdAt||null);}
function sortVal(a,k,now){
  switch(k){
    case 'quota':return totalLeft(a,now);
    case 'gemini':case 'claude':case 'argon':case 'carbon':return famLeft(a,k,now);
    case 'created':return createdVal(a);
    case 'email':return em(a);
    case 'h5':case 'week':return minFrac(a,k,now);
    case 'reset':return nextReset(a,now);
    case 'used':return a.lastUsed?-a.lastUsed:null;
    case 'tier':return a.tier&&TIER_ORDER[a.tier]!=null?TIER_ORDER[a.tier]:null;
    default:return ST_ORDER[a.status]??9;
  }
}
/** 下一次点这个表头之后的排序键。配额列：剩得多的在前 → 剩得少的在前 → 回到默认（导入时间）；其它列：正序 ↔ 倒序 */
function nextSort(cur,k){
  cur=cur||'';
  if(QUOTA_SORTS.includes(k))return cur==='-'+k?k:cur===k?'':'-'+k;
  return cur===k?'-'+k:k;
}
/** 排好序的新数组（不改原数组）；空键＝按导入时间（先导入的在前） */
function sort(list,key,now=Date.now()){
  key=key||'created';
  const desc=key.startsWith('-'),k=desc?key.slice(1):key,dir=desc?-1:1;
  const cmp=(x,y)=>x<y?-1:x>y?1:0;
  return list.map(a=>({a,v:sortVal(a,k,now),e:em(a)})).sort((x,y)=>{
    if(x.v==null||y.v==null){if(x.v!=y.v)return x.v==null?1:-1;}
    else{const c=cmp(x.v,y.v);if(c)return c*dir;}
    return cmp(x.e,y.e);
  }).map(x=>x.a);
}
g.AF={TIERS,STATUSES,SORTS,QUOTA_SORTS,sort,nextSort,filter,tierCounts,statusCounts,toggleAll,headState,rangeSelect,prune,reconcile};
})(typeof window!=='undefined'?window:globalThis);
