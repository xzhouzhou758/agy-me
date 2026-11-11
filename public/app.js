(()=>{
'use strict';

/* ============ 图标（内联 SVG，参考 Lucide，ISC 许可） ============ */
const ICONS={
  terminal:'<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  pen:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  home:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  key:'<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  chart:'<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  window:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M6 6.5h.01M9 6.5h.01"/>',
  settings:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
  x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  copy:'<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  shield:'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  sliders:'<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  cpa:'<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  ext:'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash:'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  wifi:'<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  globe:'<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  play:'<path d="M6 4l14 8-14 8z"/>',
  power:'<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  pause:'<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list:'<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  layers:'<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
};
const ic=n=>`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]||''}</svg>`;
const GEM='<img class="qp-ic" src="icons/gemini.svg" alt="" aria-hidden="true">';
const CLA='<img class="qp-ic" src="icons/claude.svg" alt="" aria-hidden="true">';
const GPT='<span class="qp-ic gpt-ic" aria-hidden="true"><img class="lt" src="icons/openai.svg" alt=""><img class="dk" src="icons/openai-dark.svg" alt=""></span>';

/* ============ 工具 ============ */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const pad=n=>String(n).padStart(2,'0');
const hms=ts=>{const d=new Date(ts);return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;};
const md=ts=>{const d=new Date(ts);return `${pad(d.getMonth()+1)}-${pad(d.getDate())}`;};
function ago(ts){if(!ts)return '—';const s=Math.max(0,(Date.now()-ts)/1000);if(s<60)return '刚刚';if(s<3600)return Math.floor(s/60)+' 分钟前';if(s<86400)return Math.floor(s/3600)+' 小时前';return Math.floor(s/86400)+' 天前';}
function left(iso){if(!iso)return '';const ms=Date.parse(iso)-Date.now();if(!(ms>0))return '';const n=Math.ceil(ms/6e4),d=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`;}
function tk(n){n=Number(n)||0;const f=(v,u)=>(v>=100?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2)).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'')+u;return n>=1e9?f(n/1e9,'B'):n>=1e6?f(n/1e6,'M'):n>=1e3?f(n/1e3,'K'):String(n);}
const sec=ms=>ms==null?'—':ms<1000?ms+'ms':(ms/1000).toFixed(ms<1e4?2:1)+'s';
const pctOf=(a,b)=>b?Math.round(a/b*1000)/10:0;
const lv=p=>p>=40?'good':p>=15?'mid':'low';
const famIc=m=>/claude/i.test(m||'')?CLA:/gpt/i.test(m||'')?GPT:GEM;
const ST={ok:['good','正常'],cooldown:['warn','冷却'],banned:['bad','封号'],disabled:['','停用']};
const stChip=a=>`<span class="chip ${ST[a.status][0]}"${a.reason?` title="${esc(a.reason)}"`:''}><span class="dot"></span>${ST[a.status][1]}</span>`;
/* 档位徽章：发光胶囊 */
function tierTag(t){if(!t)return '';const k=String(t).toLowerCase();return `<span class="gb ${esc(k)} sm"><span class="gb-aura"></span><span class="gb-pill"><span class="gb-beam"></span><span class="gb-t">${esc(k[0].toUpperCase()+k.slice(1))}</span></span></span>`;}
const lsGet=(k,d)=>{try{return localStorage.getItem(k)??d;}catch(e){return d;}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v);}catch(e){}};

let me=null,page='dash',D={},loadState='idle',lastFocus=null;
const ui={
  acc:{q:'',tier:'',status:'',page:1,size:+lsGet('agyme-accsize','10')||10,view:lsGet('agyme-accview','list'),sort:(s=>AF.QUOTA_SORTS.some(k=>s===k||s==='-'+k)?s:'')(lsGet('agyme-accsort','')),sel:new Set(),anchor:null,focus:null},
  logs:{q:'',account:'',model:'',status:'',range:'24h',page:1,size:50,auto:false},
  usage:{range:'7d'},
  keys:{text:{},shown:new Set()},
  addTab:lsGet('agyme-addtab','oauth'),
};

/* 原始响应（导出下载用）；401 = 会话没了：关掉弹窗回登录页，不再另外报错 */
async function req(method,path,body,raw){
  const opt={method,headers:{},credentials:'same-origin'};
  if(method!=='GET')opt.headers['X-App-CSRF']='1';
  if(raw!==undefined){opt.body=raw;opt.headers['Content-Type']='application/octet-stream';}
  else if(body!==undefined){opt.body=JSON.stringify(body);opt.headers['Content-Type']='application/json';}
  const r=await fetch(path,opt);
  if(r.status===401&&path!=='api/me'&&path!=='api/login'){
    const was=!!me;me=null;flow=null;closeDialog();if(was)render();
    const e=new Error('unauthorized');e.code='unauthorized';e.status=401;e.silent=true;throw e;
  }
  if(!r.ok){let d=null;try{d=await r.json();}catch(e){}const e=new Error(d?.error||('http_'+r.status));e.code=d?.error||('http_'+r.status);e.detail=d?.message;e.status=r.status;throw e;}
  return r;
}
async function api(method,path,body,raw){
  const r=await req(method,path,body,raw);
  return (r.headers.get('content-type')||'').includes('json')?r.json():r;
}
const ERR={bad_password:'密码不对',too_many_attempts:'试太多次了，15 分钟后再试',cpa_unreachable:'连不上 CPA',invalid_zip:'ZIP 读不出来',empty_zip:'ZIP 里没有 JSON',
  zip_too_large:'ZIP 解开后太大了',body_too_large:'文件太大了',too_many:'一次最多 500 个',invalid:'不是 Antigravity 凭证',duplicate:'已存在',
  cpa_upload_failed:'CPA 没收下',cpa_list_failed:'CPA 读不出账号列表',failed:'导入失败',
  state_mismatch:'回调地址和这次登录对不上',invalid_callback:'回调地址不对',callback_rejected:'CPA 没接受这个回调',too_many_pending:'进行中的登录太多了',
  bad_old_password:'旧密码不对',password_too_short:'新密码至少 8 位',password_mismatch:'两次输入的新密码不一样',
  key_empty:'密钥不能为空',key_invalid:'密钥要 12–200 位，只能用字母、数字和 . _ ~ + / = -',last_key:'至少要留一个密钥',conflict:'CPA 配置正被别处修改，再试一次',cpa_keys_failed:'CPA 没保存密钥',
  browser_not_running:'浏览器没在运行',invalid_url:'只能打开 Google 的链接',not_found:'找不到了',csrf:'请求被拒绝'};
const errText=e=>e?.code==='export_incomplete'?`有账号导不出来，没有生成文件：${e.detail||''}`:ERR[e?.code]||e?.detail||ERR[e?.message]||'操作失败';
const fail=e=>{if(!e?.silent)toast(errText(e),true);};

/* ============ 额度片段（圆环版） ============ */
/* 重置时间已过的窗口按已恢复显示（和仪表盘一致） */
const live=b=>b&&b.reset&&Date.parse(b.reset)<=Date.now()?{...b,frac:1,reset:null}:b;
const winP=b=>{b=live(b);return b?{p:Math.round(b.frac*100),r:left(b.reset)}:null;};
const TOKF=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1});
const tokS=n=>Number.isFinite(n)&&n>0?TOKF.format(n):'—';
const QIC={gemini:'icons/gemini.svg',claude:'icons/claude.svg'};
function arcC(r,p){const t=`<circle class="tr" cx="22" cy="22" r="${r}"/>`;return p>0?t+`<circle class="${lv(p)}" cx="22" cy="22" r="${r}" pathLength="100" stroke-dasharray="${p} 100"/>`:t;}
function qLine(lab,b){const x=winP(b);return `<div class="aq-ln"><span class="w">${lab}</span><b class="${x?lv(x.p):'na'}" title="剩余额度">${x?`${x.p}<small>%</small>`:'—'}</b><span class="t" title="${lab} 重置时间">${x?'↻ '+esc(x.r||'—'):''}</span></div>`;}
/* 一个模型一格：外圈 5H，内圈 7D；f=null 是未开通 */
function gauge(name,icon,f,used){
  const img=`<img src="${QIC[icon]}" alt="">`;
  if(!f)return `<div class="aq-q off"><div class="aq-ring one"><svg aria-hidden="true" viewBox="0 0 44 44">${arcC(19,0)}</svg>${img}</div><div class="aq-qb"><div class="aq-qn">${name}</div><div class="aq-off">未开通配额</div></div></div>`;
  const ws=[f.h5,f.week].map(winP).filter(Boolean);
  return `<div class="aq-q"><div class="aq-ring ${ws.length>1?'':'one'}"><svg aria-hidden="true" viewBox="0 0 44 44">${(ws.length?ws:[{p:0}]).map((x,i)=>arcC(i?13.6:19,x.p)).join('')}</svg>${img}</div>
    <div class="aq-qb"><div class="aq-qn">${name}</div><div class="aq-windows">${qLine('5H',f.h5)}${qLine('7D',f.week)}</div>
    <div class="aq-ln usage"><span class="w">已用</span><span class="amounts" title="依次为 5H 和 7D 已用量">${tokS(used?.h5)} / ${tokS(used?.week)}</span></div></div></div>`;
}
/* Claude 那格写 5.5 还是 4.6：看这个号实际能用的模型 */
const claudeVer=q=>(q.models||[]).some(m=>/^claude-.*5-5/i.test(m.name))?'5.5':'4.6';
function quotaSlots(a){
  const q=a.quota,u=a.used||{},none={h5:null,week:null},on=(f,st)=>st==='on'?(f||none):null;
  return [['Gemini 3.8','gemini',q.gemini||none,u.gemini],[`Claude ${claudeVer(q)} / GPT`,'claude',q.claude||none,u.claude],
    ['Gemini 4 Argon','gemini',on(q.argon,q.argonState),u.argon],['Gemini 4 Carbon','gemini',on(q.carbon,q.carbonState),u.carbon]];
}
function quotaBlock(a,cls=''){
  const q=a.quota;
  if(q?.forbidden)return `<div class="aq-ban"><div class="aq-ban-l"><span class="aq-ban-ico"><span class="aq-lock"></span></span><div class="aq-ban-txt"><span>账号访问受限 (HTTP 403)</span><span class="aq-ban-sub">查看上游返回的错误详情</span></div></div><button type="button" data-act="reason:${esc(a.id)}">查看原因</button></div>`;
  if(!q)return `<div class="aq-none">${a.quotaErr?'额度读取失败':'暂无模型额度遥测数据'}</div>`;
  return `<div class="aq-quota ${cls}">${quotaSlots(a).map(x=>gauge(...x)).join('')}</div>`;
}
const ST_CLS={ok:'',cooldown:'warn',banned:'bad',disabled:'off'};
const stLabel=a=>a.status==='banned'?(a.quota?.forbidden?'403 异常':'异常'):a.status==='cooldown'?'冷却中':a.status==='disabled'?'已停用':'正常';
function stTag(a){
  const c=ST_CLS[a.status],t=esc(stLabel(a));
  return a.status!=='ok'&&(a.reason||a.quotaErr||a.quota?.forbidden)?`<button type="button" class="aq-st ${c}" data-act="reason:${esc(a.id)}" title="查看原因">${t}</button>`:`<span class="aq-st ${c}">${t}</span>`;
}

/* ============ 页面框架 ============ */
const PAGES=[['dash','home','仪表盘'],['accounts','key','我的凭证'],['keys','terminal','API 密钥'],['logs','activity','请求日志'],['usage','chart','用量统计'],['browser','window','内置 Chrome'],['settings','settings','设置']];
const navPages=()=>PAGES.filter(p=>p[0]!=='browser'||me?.browser);
const LOADERS={
  dash:async()=>{D.ov=await api('GET','api/overview');},
  accounts:async()=>{const r=await api('GET','api/accounts');D.accounts=r.accounts;D.progress=r.progress;syncSel(false);},
  logs:async()=>{await loadLogs(true);},
  usage:async()=>{D.usage=await api('GET','api/usage?'+new URLSearchParams({range:ui.usage.range,tz:-new Date().getTimezoneOffset()}));},
  browser:async()=>{D.br=await api('GET','api/browser');},
  keys:async()=>{ui.keys={text:{},shown:new Set()};D.keys=(await api('GET','api/keys')).keys;},
  settings:async()=>{D.set=await api('GET','api/settings');D.tiers=null;api('GET','api/tiers').then(t=>{D.tiers=t;if(page==='settings'){const el=$('#tiers');if(el)el.innerHTML=tiersBody();}}).catch(()=>{D.tiers={err:true};const el=$('#tiers');if(el)el.innerHTML=tiersBody();});},
};
function head(title,actions=''){return `<div class="head"><h1>${title}</h1>${actions?`<div class="hstack">${actions}</div>`:''}</div>`;}
function empty(icon,title,action=''){return `<div class="empty"><div class="bubble">${ic(icon)}</div><h2>${title}</h2>${action}</div>`;}
const seg=(name,opts,cur,label)=>`<div class="seg" role="radiogroup" aria-label="${label}">${opts.map(([v,l])=>`<label><input type="radio" name="${name}" value="${v}" ${String(cur)===String(v)?'checked':''}><span>${l}</span></label>`).join('')}</div>`;
const isDark=()=>document.documentElement.dataset.theme==='dark';
const themeBtn=()=>`<button class="btn sm ghost icon" id="themebtn" data-act="theme" aria-label="${isDark()?'切到浅色':'切到深色'}" title="${isDark()?'切到浅色':'切到深色'}">${ic(isDark()?'sun':'moon')}</button>`;

function render(){
  const root=$('#root');
  if(!me){root.innerHTML=loginView();$('#f-pass')?.focus();return;}
  if(!navPages().some(p=>p[0]===page))page='dash';
  const views={dash:pageDash,accounts:pageAccounts,keys:pageKeys,logs:pageLogs,usage:pageUsage,browser:pageBrowser,settings:pageSettings};
  let main;
  if(loadState==='loading')main=`<section class="card glass"><div class="hstack"><span class="spin"></span><span class="dim">加载中…</span></div></section>`;
  else if(loadState==='error')main=`<section class="card glass">${empty('wifi','加载失败',`<button class="btn primary" data-act="reload">${ic('refresh')}重试</button>`)}</section>`;
  else{try{main=views[page]();}catch(e){console.error(e);main=`<section class="card glass">${empty('alert','页面出错了')}</section>`;}}
  root.innerHTML=`<div class="app">
    <div class="content"><div class="wrap">
      <header class="top glass">
        <div class="top-left"><div class="brand tb"><img class="logo" src="logo.jpg" alt=""><span class="tb-name">Antigravity<i class="me">me</i></span></div></div>
        <nav class="tnav" aria-label="主导航">${navPages().map(([id,icon,name])=>`<button type="button" data-act="goto:${id}" aria-current="${page===id?'page':'false'}">${ic(icon)}<span>${name}</span></button>`).join('')}</nav>
        <div class="top-right"><button class="btn sm ghost icon" data-act="reload" aria-label="刷新" title="刷新">${ic('refresh')}</button>${themeBtn()}<button class="btn sm ghost icon" data-act="logout" aria-label="退出登录" title="退出登录">${ic('logout')}</button></div>
      </header>
      <main id="main" tabindex="-1">${main}</main>
      <footer class="credit">Made with 🦴 by 聪明绝顶二狗子</footer>
    </div></div>
  </div>`;
  afterRender();
}
function afterRender(){
  if(page==='accounts'){syncHeadBox();if(ui.acc.focus){const el=document.getElementById('acc-'+cssId(ui.acc.focus));ui.acc.focus=null;if(el){el.scrollIntoView({block:'center'});el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),2200);}}}
}
function loginView(){
  return `<div class="login">
    <section class="login-card glass">
      <div class="lg-logo"><img src="logo.jpg" alt=""></div>
      <h1 class="lg-title"><b>Antigravity</b><i class="me">me</i></h1>
      <form class="lg-form" id="pwform" autocomplete="on">
        <input type="text" name="username" autocomplete="username" value="me" hidden>
        <label class="lg-f"><span>密码</span><input class="input" id="f-pass" name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary lg-btn" type="submit">登录</button>
      </form>
    </section>
    <footer class="credit">Made with 🦴 by 聪明绝顶二狗子</footer>
  </div>`;
}
/* 只认最后一次加载：先点的慢页面回来时不能盖掉后来的页面 */
let loadSeq=0,dirty=false;
async function load(p=page){
  const n=++loadSeq;page=p;loadState='loading';render();
  try{await LOADERS[p]();if(n!==loadSeq)return;loadState='idle';}catch(e){if(n!==loadSeq||!me)return;loadState='error';}
  render();
}
async function reload(){
  const n=++loadSeq,p=page;
  try{await LOADERS[p]();if(n!==loadSeq)return;loadState='idle';}catch(e){if(n!==loadSeq||!me)return;loadState='error';}
  renderSoon();
}
/* 弹窗开着就等关掉再画 */
function renderSoon(){if(dialogOpen())dirty=true;else render();}
function go(p){closeDialog();load(p);$('#main')?.focus({preventScroll:true});window.scrollTo({top:0});}

/* ============ 仪表盘 ============ */
/* 额度族卡片：和凭证页同一套圆环（外圈 5H 平均，内圈 7D 平均） */
function famCard(k,name,icon){
  const F=D.ov.fam[k]||{total:0},tot=F.total,pc=v=>v==null?null:Math.round(v*100);
  const h=pc(F.h5),w=pc(F.week),ws=[h,w].filter(x=>x!=null);
  const ring=`<div class="aq-ring fcq-ring ${ws.length>1?'':'one'}"><svg viewBox="0 0 44 44" aria-hidden="true">${(ws.length?ws:[0]).map((p,i)=>arcC(i?13.6:19,p)).join('')}</svg><img src="${QIC[icon]}" alt=""></div>`;
  const ln=(lab,p)=>`<div class="aq-ln"><span class="w">${lab}</span><b class="${p==null?'na':lv(p)}">${p==null?'—':p+'<small>%</small>'}</b></div>`;
  const back=tot&&F.withQuota<tot&&F.earliest?`<span class="fc-back" title="${esc(new Date(F.earliest).toLocaleString())}">↻ ${esc(left(F.earliest)||'即将')}</span>`:'';
  return `<section class="stat glass fcq ${tot?'':'off'}"><div class="fcq-n">${name}${back}</div>
    <div class="fcq-b">${ring}${tot?`<div class="fcq-m"><div class="num">${F.withQuota}<small>/ ${tot}</small></div><div class="aq-windows">${ln('5H',h)}${ln('7D',w)}</div></div>`:`<div class="fcq-m"><div class="aq-off">未开通配额</div></div>`}</div></section>`;
}
const hv=p=>p>=80?'':p>=50?'mid':'low';
function healthCard(){
  const n=D.ov.counts,usable=n.total-n.disabled,p=usable?Math.round(n.ok/usable*100):null;
  return `<section class="stat glass fc"><div class="fc-h">${ic('shield')}<span>账号健康</span></div>
    ${p==null?`<div class="num faint">—</div>`:`<div class="num">${n.ok}<small>/ ${usable}</small></div>
    <div class="meter ${hv(p)}"><span style="width:${Math.max(p,1)}%"></span></div>`}
    <div class="legend">${['ok','cooldown','banned','disabled'].map(s=>`<span><i class="sdot ${ST[s][0]}"></i>${ST[s][1]} <b>${n[s]}</b></span>`).join('')}</div></section>`;
}
function banBanner(){
  const B=D.ov.bans;if(!B.length)return '';
  return `<section class="ban">${ic('alert')}<div class="ban-b"><b>${B.length} 个号被 Google 拒绝访问</b>
    ${B.map(b=>`<div class="ban-r"><span class="mono">${esc(b.email)}</span><small>${esc(b.reason)}</small>${b.action?`<a class="btn sm ghost" href="${esc(b.action.url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}${b.action.kind==='appeal'?'申诉':'验证'}</a>`:''}<button class="btn sm danger" data-act="banoff:${esc(b.id)}">${ic('power')}停用</button></div>`).join('')}</div>
    ${B.length>1?`<button class="btn sm danger ban-all" data-act="banall">全部停用</button>`:''}</section>`;
}
function autoBanner(){
  const A=D.ov.autoOff||[];if(!A.length)return '';
  return `<section class="ban auto">${ic('power')}<div class="ban-b"><b>自动停用了 ${A.length} 个号</b>
    ${A.map(b=>`<div class="ban-r"><span class="mono">${esc(b.email)}</span><small title="${esc(new Date(b.at).toLocaleString())}">${esc(b.reason)} · ${esc(ago(b.at))}</small>${b.action?`<a class="btn sm ghost" href="${esc(b.action.url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}${b.action.kind==='appeal'?'申诉':'验证'}</a>`:''}</div>`).join('')}</div></section>`;
}
const cssId=id=>String(id).replace(/[^A-Za-z0-9_-]/g,'_');
function riskCard(){
  const L=D.ov.dots;
  return `<section class="card glass"><div class="card-head"><h2>风控</h2><div class="legend">${['ok','cooldown','banned','disabled'].map(s=>`<span><i class="sdot ${ST[s][0]}"></i>${ST[s][1]}</span>`).join('')}</div></div>
    ${L.length?`<div class="dots">${L.map(d=>`<button class="rdot ${d.status}" data-act="jump:${esc(d.id)}" title="${esc(d.email+(d.reason?' · '+d.reason:''))}" aria-label="${esc(d.email)} ${ST[d.status][1]}"></button>`).join('')}</div>`:'<p class="faint">还没有账号</p>'}</section>`;
}
function recentCard(){
  const R=D.ov.recent;
  if(!D.ov.usageOK)return `<section class="card glass"><div class="card-head"><h2>最近请求</h2></div><p class="faint">请求记录不可用</p></section>`;
  const T=R.filter(r=>!r.failed&&r.ttft).map(r=>r.ttft),top=T.length?Math.max(...T):null,max=Math.max(1000,top||0);
  const bars=R.map(r=>{const h=r.failed?100:Math.max(6,Math.round((r.ttft||0)/max*100));
    const tip=[`${md(r.ts)} ${hms(r.ts)}`,r.account,r.model,r.failed?`${r.status} · ${r.error}`:`首字 ${sec(r.ttft)} · 耗时 ${sec(r.latency)}`].join('\n');
    return `<i class="rb ${r.failed?'bad':''}" style="height:${h}%" title="${esc(tip)}"></i>`;}).join('');
  const ok=R.filter(r=>!r.failed).length;
  return `<section class="card glass"><div class="card-head"><h2>最近请求</h2><small class="faint">${R.length?`${ok}/${R.length} 成功${top!=null?` · 最高 ${sec(top)}`:''}`:''}</small></div>
    ${R.length?`<div class="rbars" role="img" aria-label="最近 ${R.length} 次请求的首字时间">${bars}</div>`:'<p class="faint">还没有请求</p>'}</section>`;
}
function pageDash(){
  const o=D.ov,n=o.counts;
  const nums=`<div class="dnums"><div><small>总账号</small><b>${n.total}</b></div><div><small>可用</small><b class="good-t">${n.ok}</b></div><div><small>正常率</small><b>${o.healthy==null?'—':`${Math.round(o.healthy*100)}<small>%</small>`}</b></div></div>`;
  return head('仪表盘',nums+`<button class="btn primary" data-act="add">${ic('plus')}添加账号</button>`)+banBanner()+autoBanner()+
  `<div class="grid g4">${famCard('gemini','Gemini 3.8','gemini')}${famCard('claude','Claude / GPT','claude')}${famCard('argon','Gemini 4 Argon','gemini')}${famCard('carbon','Gemini 4 Carbon','gemini')}</div>
  <div class="grid dash-2">${healthCard()}${riskCard()}</div>
  ${recentCard()}`;
}

/* ============ 账号 ============ */
const visible=()=>AF.sort(AF.filter(D.accounts||[],ui.acc),ui.acc.sort);
function pageAccounts(){
  const acts=`<button class="btn" data-act="add">${ic('plus')}添加</button><button class="btn" data-act="import">${ic('upload')}导入</button><button class="btn" data-act="exportall">${ic('download')}导出</button>`;
  return head('我的凭证',acts)+`<div class="atool">
    <label class="srch">${ic('search')}<input class="input sm" data-accq value="${esc(ui.acc.q)}" placeholder="搜索邮箱" aria-label="搜索邮箱"></label>
    <div id="acc-chips" class="fchips">${accChips()}</div>
    ${seg('accview',[['list','列表'],['card','卡片']],ui.acc.view,'视图')}
  </div><div id="acc-batch">${batchBar()}</div><div id="acc-body">${accBody()}</div>`;
}
function accChips(){
  const L=D.accounts||[],T=AF.tierCounts(L,ui.acc),S=AF.statusCounts(L,ui.acc);
  const c=(k,v,l,n,cur)=>`<button type="button" class="fchip" aria-pressed="${cur===v}" data-act="${k}:${v}">${l}${n!=null?` <i>${n}</i>`:''}</button>`;
  return c('ftier','','全部',T.all,ui.acc.tier)+AF.TIERS.filter(t=>T[t]||t===ui.acc.tier).map(t=>c('ftier',t,t,T[t],ui.acc.tier)).join('')+
    '<span class="fsep"></span>'+AF.STATUSES.map(s=>c('fstatus',s,ST[s][1],S[s],ui.acc.status)).join('');
}
function batchBar(){
  const n=ui.acc.sel.size;if(!n)return '';
  return `<div class="batch glass"><b>已选 ${n} 个</b><span class="hstack">
    <button class="btn sm" data-act="batch:enable">${ic('play')}启用</button><button class="btn sm" data-act="batch:disable">${ic('pause')}停用</button>
    <button class="btn sm" data-act="exportsel">${ic('download')}导出</button>
    <button class="btn sm danger" data-act="batch:delete">${ic('trash')}删除</button></span>
    <button class="btn sm ghost icon" data-act="selnone" aria-label="取消选择" title="取消选择">${ic('x')}</button></div>`;
}
/* 账号页：一个号一张卡 / 一行 */
const A_cb=a=>`<input type="checkbox" class="cb" data-sel="${esc(a.id)}" ${ui.acc.sel.has(a.id)?'checked':''} aria-label="选择 ${esc(a.email)}">`;
const A_acts=a=>`<button class="btn sm ghost icon" data-act="detail:${esc(a.id)}" aria-label="详情" title="详情">${ic('sliders')}</button>`;
const A_who=a=>`<div class="aq-who"><div class="aq-mail" title="${esc(a.email)}">${esc(a.email)}</div><div class="aq-meta">${tierTag(a.tier)}${stTag(a)}<span class="aq-sep"></span><span title="最近使用">${a.lastUsed?esc(ago(a.lastUsed)):'从未'}</span>${a.note?`<span class="aq-sep"></span><span title="备注">${esc(a.note)}</span>`:''}</div></div>`;
const A_tog=a=>`<button type="button" role="switch" class="aq-tog" data-act="toggle:${esc(a.id)}" aria-label="启用 ${esc(a.email)}" aria-checked="${!a.disabled}"><span>${a.disabled?'停用':'启用'}</span><span class="aq-sw" aria-hidden="true"></span></button>`;
const accCard=a=>`<article class="aq-card aq-glass ${a.tier==='ULTRA'?'aq-ultra':''} ${a.disabled?'off':''}" id="acc-${cssId(a.id)}">
      <div><div class="aq-head">${A_cb(a)}${A_who(a)}</div>${quotaBlock(a)}</div>
      <div class="aq-foot"><span class="aq-foot-l"><span class="aq-clock"></span><span>${a.quotaAt?esc(ago(a.quotaAt))+'同步':'未同步'}</span></span><span class="aq-act">${A_acts(a)}${A_tog(a)}</span></div></article>`;
const accRow=a=>`<div class="aq-row ${a.disabled?'off':''}" id="acc-${cssId(a.id)}">${A_cb(a)}${A_who(a)}${quotaBlock(a)}<span class="aq-act">${A_acts(a)}${A_tog(a)}</span></div>`;
/* 分页：当前页的号；跳到某个号时翻到它所在的页 */
const ACC_SIZES=[10,20,50,100];
function pageList(){
  const L=visible(),n=ui.acc.size,pages=Math.max(1,Math.ceil(L.length/n));
  if(ui.acc.focus){const i=L.findIndex(a=>a.id===ui.acc.focus);if(i>=0)ui.acc.page=Math.floor(i/n)+1;}
  ui.acc.page=Math.min(Math.max(1,ui.acc.page|0),pages);
  return {L,P:L.slice((ui.acc.page-1)*n,ui.acc.page*n),pages};
}
function accPager(total,pages){
  const n=ui.acc.size,p=ui.acc.page,from=total?(p-1)*n+1:0,to=Math.min(total,p*n);
  return `<div class="pager aq-pager"><small class="faint">${from}–${to} / ${total}</small>
    <select class="select sm" data-accsize aria-label="每页显示">${ACC_SIZES.map(x=>`<option value="${x}" ${x===n?'selected':''}>${x} 个/页</option>`).join('')}</select>
    <button class="btn sm ghost" data-act="apg:${p-1}" ${p<=1?'disabled':''} aria-label="上一页">‹</button><span class="mono faint">${p} / ${pages}</span><button class="btn sm ghost" data-act="apg:${p+1}" ${p>=pages?'disabled':''} aria-label="下一页">›</button>
    <label class="aq-jump"><span>跳至</span><input class="input sm" type="number" min="1" max="${pages}" data-accjump value="${p}" aria-label="跳到第几页"><span>页</span></label></div>`;
}
function accBody(){
  const {L:LL,P:L,pages}=pageList();accIds=L.map(a=>a.id).join('\n');
  const pg=accPager(LL.length,pages);
  if(!(D.accounts||[]).length)return `<section class="card glass">${empty('key','还没有账号',`<button class="btn primary" data-act="add">${ic('plus')}添加账号</button>`)}</section>`;
  if(!LL.length)return `<section class="card glass">${empty('search','没有符合条件的账号')}</section>`;
  const QS=AF.QUOTA_SORTS;
  if(ui.acc.view==='card')return `<div class="acards-head"><label class="cb-l"><input type="checkbox" class="cb" id="selall" aria-label="全选当前筛选的账号"><span>全选</span></label><span class="sorts">${sortBtns(QS)}</span></div><div class="aq-cards">${L.map(accCard).join('')}</div>${pg}`;
  return `<section class="aq-list aq-glass"><div class="aq-row th"><input type="checkbox" class="cb" id="selall" aria-label="全选当前筛选的账号"><span class="aq-th-who"></span><span class="sorts aq-sorts">${sortBtns(QS)}</span><span></span></div>
    ${L.map(accRow).join('')}</section>${pg}`;
}
/* 静默更新：只换内容变了的号；可见的号或顺序变了才整块重画 */
let accIds='';
function patchAcc(prev){
  const b=$('#acc-body');if(!b)return;
  const {P:L}=pageList();
  if(L.map(a=>a.id).join('\n')!==accIds||!b.querySelector('.aq-card,.aq-row:not(.th)')){refreshAcc();return;}
  const old=new Map((prev||[]).map(a=>[a.id,JSON.stringify(a)])),f=ui.acc.view==='card'?accCard:accRow;
  for(const a of L){if(old.get(a.id)===JSON.stringify(a))continue;const el=document.getElementById('acc-'+cssId(a.id));if(el)el.outerHTML=f(a);}
  $('#acc-chips').innerHTML=accChips();
}
setInterval(async()=>{
  if(!me||page!=='accounts'||dialogOpen()||document.visibilityState!=='visible')return;
  let r;try{r=await api('GET','api/accounts');}catch(e){return;}
  if(page!=='accounts'||dialogOpen())return;
  const prev=D.accounts;D.accounts=r.accounts;syncSel(false);patchAcc(prev);
},60000);
/* 表头排序：点一下按这列排，再点反过来 */
const SORT_LABEL=Object.fromEntries(AF.SORTS);
function sortBtns(keys){
  const cur=ui.acc.sort||'',d=cur.startsWith('-'),k=d?cur.slice(1):cur;
  return keys.map(x=>`<button type="button" class="sorth${x===k?' on':''}" data-act="asort:${x}" aria-label="按${SORT_LABEL[x]}排序"${x===k?` aria-sort="${d?'descending':'ascending'}"`:''}>${SORT_LABEL[x]}<i>${x===k?(d?'↓':'↑'):'⇅'}</i></button>`).join('');
}
function syncHeadBox(){
  const h=$('#selall');if(!h)return;
  const s=AF.headState(ui.acc.sel,visible().map(a=>a.id));
  h.checked=s==='all';h.indeterminate=s==='some';
}
function syncSel(reset){const r=AF.reconcile(ui.acc.sel,ui.acc.anchor,visible().map(a=>a.id),reset);ui.acc.sel=r.sel;ui.acc.anchor=r.anchor;}
function refreshAcc(reset=false){
  if(reset)ui.acc.page=1;
  syncSel(reset);
  const b=$('#acc-body');if(!b)return;
  b.innerHTML=accBody();$('#acc-chips').innerHTML=accChips();$('#acc-batch').innerHTML=batchBar();syncHeadBox();
}
function refreshSel(){$$('[data-sel]').forEach(x=>x.checked=ui.acc.sel.has(x.dataset.sel));const b=$('#acc-batch');if(b)b.innerHTML=batchBar();syncHeadBox();}
function putAcc(v){if(!v||!D.accounts)return;D.accounts=D.accounts.map(x=>x.id===v.id?v:x);}

/* 查看原因：AGY 自己的弹窗，内容照样稿 */
function errMsg(raw){
  try{const i=raw.indexOf('{');if(i<0)return '';const p=JSON.parse(raw.slice(i));const e=typeof p.error==='string'?JSON.parse(p.error).error:p.error||p;return String(e?.message||'');}catch(e){return '';}
}
function reasonDialog(id){
  const a=D.accounts?.find(x=>x.id===id);if(!a)return;
  const fb=a.quota?.forbidden||'',raw=fb||a.quotaErr||'';
  const parsed=errMsg(raw)||a.reason||raw||'上游未提供具体原因',both=!!raw&&raw!==parsed;
  const tags=[];
  if(fb)tags.push(['bad',/TOS_VIOLATION|violation of Terms/i.test(fb)?'由于违规被禁用':'上游拒绝访问']);
  if(a.action?.kind==='verify')tags.push(['bad','需要验证账号']);
  if(a.status==='banned'&&!fb&&a.action?.kind!=='verify')tags.push(['bad','账号异常']);
  if(a.status==='cooldown')tags.push(['warn','冷却中']);
  if(a.disabled)tags.push(['',a.autoAt?'已自动停用':'账号已停用']);
  const url=a.action?.url||'',lab=a.action?.kind==='verify'?'验证':'申诉';
  const at=fb&&a.quotaAt?['额度检测时间',a.quotaAt]:a.autoAt?['自动停用时间',a.autoAt]:null;
  openDialog('错误详情','',`<div class="rs">
    <section><h3>账号</h3><div class="rs-acc">${esc(a.email)}</div></section>
    <section><h3>错误状态</h3><div class="rs-tags">${tags.length?tags.map(([c,t])=>`<span class="chip ${c}"><span class="dot"></span>${esc(t)}</span>`).join(''):esc(a.reason||'账号异常')}</div></section>
    <section><div class="rs-hd"><h3>原因</h3>${both?'<button type="button" class="link" data-act="rsraw">显示原始报文</button>':''}</div>
      <pre class="rs-body" id="rs-p">${esc(parsed)}</pre>${both?`<pre class="rs-body" id="rs-r" hidden>${esc(raw)}</pre>`:''}
      <div class="rs-acts">${url?`<a class="btn sm primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}前往${lab}</a><button type="button" class="btn sm" data-act="copy:${esc(url)}">${ic('copy')}复制${lab}链接</button>`:`<button type="button" class="btn sm" disabled title="上游报文未提供可用链接">前往${lab}</button><button type="button" class="btn sm" disabled title="上游报文未提供可用链接">复制${lab}链接</button>`}</div></section>
    <details><summary>账号自助排查指南</summary><p>先核对上方账号和原因。若上游要求验证，请使用该账号完成验证；若返回 TOS_VIOLATION，请通过上游提供的申诉入口提交申诉。处理后在账号页刷新额度。</p></details>
    ${at?`<section class="rs-meta"><span class="aq-clock"></span>${at[0]}：${esc(new Date(at[1]).toLocaleString())}</section>`:''}
  </div>`,`<button class="btn primary" data-act="close">关闭</button>`);
}
function accountDetail(id){
  const a=D.accounts?.find(x=>x.id===id);if(!a)return;
  const q=a.quota;
  const models=q?.models?.length?`<div class="mq">${q.models.map(m=>m.reset&&Date.parse(m.reset)<=Date.now()?{...m,pct:100,reset:null}:m).map(m=>`<div class="mq-r"><span class="mq-n" title="${esc(m.label)}">${famIc(m.name)}${esc(m.name)}</span><b class="${lv(m.pct)}-t">${m.pct}%</b><small>${esc(left(m.reset))}</small><i class="mq-bar ${lv(m.pct)}"><span style="width:${Math.max(m.pct,1)}%"></span></i></div>`).join('')}</div>`:'';
  const cds=a.cooldowns.length?`<ul class="cdl">${a.cooldowns.map(c=>`<li><b class="mono">${esc(c.model||'整个账号')}</b><span>${esc(c.text)}</span><i>${esc(left(c.retryAt))}</i></li>`).join('')}</ul>`:'';
  const act=a.action?`<span class="fix"><a class="btn sm primary" href="${esc(a.action.url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}${a.action.kind==='appeal'?'去申诉':'去验证'}</a>${me.browser?`<button class="btn sm" data-act="bropen:${esc(a.id)}">${ic('window')}内置浏览器打开</button>`:''}</span>`:'';
  openDialog(esc(a.email),'',
    `<div class="adt"><div class="adt-meta">${tierTag(a.tier)}${stChip(a)}${a.credits!=null?`<span class="chip">积分 ${Number(a.credits).toLocaleString()}</span>`:''}${a.lastUsed?`<span class="chip">${esc(ago(a.lastUsed))}使用</span>`:''}<span class="grow"></span><small class="faint">${a.quotaAt?esc(ago(a.quotaAt))+'同步':''}${a.quotaErr&&q?' · 上次失败':''}</small></div>
    ${a.reason&&a.status!=='ok'?`<div class="ac-alert ${a.status==='cooldown'?'warn':''} mt">${ic('alert')}<div class="ac-al-b"><b>${esc(a.reason)}</b>${a.autoAt?`<small class="faint">${esc(new Date(a.autoAt).toLocaleString())}</small>`:''}${cds}${act?`<div class="ac-fix">${act}</div>`:''}</div></div>`:cds?`<div class="ac-alert warn mt">${ic('alert')}<div class="ac-al-b"><b>模型冷却</b>${cds}</div></div>`:''}
    ${quotaBlock(a,'dq')}
    ${models}
    <div class="adt-row"><input class="input sm" id="f-note" maxlength="200" value="${esc(a.note)}" data-note="${esc(a.id)}" placeholder="备注" aria-label="备注">${A_tog(a)}</div></div>`,
    `<button class="btn sm ghost" data-act="exportone:${esc(a.id)}">${ic('download')}导出</button><button class="btn sm ghost danger" data-act="delone:${esc(a.id)}">${ic('trash')}删除</button><span class="grow"></span><button class="btn primary" data-act="close">完成</button>`,true);
}

function confirmDelete(ids){
  const L=ids.map(id=>D.accounts.find(a=>a.id===id)?.email||id);
  openDialog(`删除 ${ids.length} 个账号？`,'',`<div class="dlist">${L.slice(0,10).map(e=>`<span class="mono">${esc(e)}</span>`).join('')}${L.length>10?`<small class="faint">…还有 ${L.length-10} 个</small>`:''}</div>
    <div class="note bad mt">${ic('alert')}<span>会从 CPA 删掉凭证文件，删了就找不回来，需要的话先导出。</span></div>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary danger-fill" data-act="dodelete">${ic('trash')}删除</button>`);
  pendingDelete=ids;
}
let pendingDelete=null,pendingKey=null;

async function exportIds(ids){
  const r=await req('POST','api/accounts/export',{ids});
  const blob=await r.blob(),cd=r.headers.get('content-disposition')||'',name=(/filename="([^"]+)"/.exec(cd)||[])[1]||'auths.zip';
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
}

/* 添加：CPA 的 Antigravity OAuth 登录 */
let flow=null;
const errBox=t=>`<div class="result err">${ic('alert')}<div><b>${esc(t)}</b></div></div>`;
const RTERR={invalid_token:'Refresh Token 无效或已失效',duplicate:'已存在',failed:'导入失败'};
function addDialog(){
  const f=flow||(flow={});
  const tab=f.state||f.done?'oauth':ui.addTab;
  const tabs=f.state||f.done?'':seg('addtab',[['oauth','OAuth 登录'],['rt','Refresh Token'],['file','文件导入']],tab,'添加方式');
  if(tab==='rt'){
    const R=f.rt;
    const body=f.rtBusy?`<div class="result" style="background:var(--fill)"><span class="spin"></span><div><b>正在验证…</b></div></div>`
      :R?`<div class="ilist">${R.map(r=>`<div><span class="mono">${esc(r.email||r.name)}</span>${r.ok?'<span class="chip good">已添加</span>':`<span class="chip ${r.error==='duplicate'?'warn':'bad'}">${esc(RTERR[r.error]||ERR[r.error]||r.error||'导入失败')}</span>`}</div>`).join('')}</div>`
      :`<textarea class="input mono mt" id="f-rt" rows="5" placeholder="1//0g…" autocomplete="off" spellcheck="false" aria-label="Refresh Token，一行一个"></textarea>`;
    openDialog('添加账号','',`<div data-flow>${tabs}${body}</div>`,R?`<button class="btn" data-act="rtmore">继续添加</button><button class="btn primary" data-act="close">完成</button>`:`<button class="btn" data-act="oauthcancel">取消</button><button class="btn primary" data-act="rtimport" ${f.rtBusy?'disabled':''}>导入</button>`);
    return;
  }
  if(tab==='file'){
    openDialog('添加账号','',`<div data-flow>${tabs}<label class="drop mt" id="drop">${ic('upload')}<span>拖进来，或点这里选文件</span><small class="faint">JSON / ZIP，可多选</small><input type="file" id="f-files" accept=".json,.zip,application/json,application/zip" multiple></label></div>`,`<button class="btn" data-act="oauthcancel">取消</button>`);
    return;
  }
  let body;
  if(f.done)body=`<div class="result ok">${ic('check')}<div><b>${f.reauth?'已重新授权':'已添加'}</b><p class="mono">${esc(f.email||'')}</p></div></div>`;
  else if(!f.url)body=`${f.err?errBox(f.err):''}<button class="btn primary big mt" data-act="oauthstart" ${f.busy?'disabled':''}>${f.busy?'<span class="spin"></span>':ic('globe')}${f.err?'重新开始':'打开 Google 登录'}</button>`;
  else body=`<div class="field"><span>登录链接</span><button class="alink" data-act="copyurl" title="复制">${ic('copy')}<span class="mono">${esc(f.url)}</span><b>复制</b></button></div>
    <div class="hstack mt"><a class="btn primary" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}打开</a>${me.browser?`<button class="btn" data-act="oauthbr">${ic('window')}内置浏览器打开</button>`:''}<span class="hstack faint"><span class="spin"></span>等待登录</span></div>
    <div class="adiv"></div>
    <div class="acb-l">登录后跳到 localhost 打不开，就把地址栏的链接贴回来</div>
    <div class="acb"><input class="input mono" id="f-cb" placeholder="http://localhost:51121/oauth-callback?state=…&amp;code=…" autocomplete="off" spellcheck="false"><button class="btn" data-act="oauthcb">提交</button></div>
    ${f.err?errBox(f.err):''}`;
  openDialog('添加账号','',`<div data-flow>${tabs}${body}</div>`,f.done?`<button class="btn primary" data-act="close">完成</button>`:`<button class="btn" data-act="oauthcancel">取消</button>`);
}
/* 关掉弹窗（比如去浏览器页登录）不丢这次登录；回来点「添加」接着贴回调 */
const flowPending=()=>!!(flow?.state&&!flow.done&&!flow.err);
const flowShown=()=>!!$('#layer [data-flow]');
async function pollOAuth(){
  const f=flow;const t0=Date.now();
  while(flow===f&&Date.now()-t0<600000){
    await new Promise(r=>setTimeout(r,2000));
    if(flow!==f)return;
    let s;try{s=await api('GET','api/accounts/oauth/'+encodeURIComponent(f.state));}catch(e){continue;}
    if(s.status==='wait')continue;
    if(s.status==='ok'){f.done=true;f.email=s.email;f.reauth=s.reauth;if(flowShown())addDialog();else{flow=null;toast(`${s.reauth?'已重新授权':'已添加'} ${s.email||''}`);}reload();}
    else{f.err=s.message&&s.message!=='not_found'?`登录失败：${s.message}`:'登录失败，请重新开始';f.url=null;f.state=null;if(flowShown())addDialog();}
    return;
  }
  if(flow===f){f.err='等太久了，请重新开始';f.url=null;f.state=null;if(flowShown())addDialog();}
}

async function importTokens(){
  const f=flow;if(!f)return;
  const text=$('#f-rt')?.value||'',n=text.split(/[\s,;]+/).filter(Boolean).length;
  if(!n){toast('请粘贴 Refresh Token',true);return;}
  if(n>50){toast('一次最多 50 个',true);return;}
  f.rtBusy=true;addDialog();
  let results;
  try{results=(await api('POST','api/accounts/refresh-token',{tokens:text})).results;}
  catch(e){if(e.silent||!me)return;results=[{name:'Refresh Token',ok:false,error:e.code||'failed'}];}
  if(flow!==f)return;
  f.rtBusy=false;f.rt=results;if(flowShown())addDialog();
  if(results.some(r=>r.ok))reload();
}

/* 导入：拖进 CPA 的凭证文件（可多选，JSON / ZIP） */
let imp=null;
function importDialog(){
  const R=imp?.results;
  const body=imp?.busy?`<div class="result" style="background:var(--fill)"><span class="spin"></span><div><b>导入中…</b></div></div>`
    :R?`<div class="ilist">${R.map(r=>`<div><span class="mono">${esc(r.email||r.name)}</span>${r.ok?'<span class="chip good">已导入</span>':`<span class="chip ${r.error==='duplicate'?'warn':'bad'}">${esc(ERR[r.error]||r.error||'导入失败')}</span>`}</div>`).join('')}</div>`
    :`<label class="drop" id="drop">${ic('upload')}<span>拖进来，或点这里选文件</span><small class="faint">JSON / ZIP，可多选</small><input type="file" id="f-files" accept=".json,.zip,application/json,application/zip" multiple></label>`;
  openDialog('导入凭证','',body,R?`<button class="btn" data-act="importmore">继续导入</button><button class="btn primary" data-act="close">完成</button>`:`<button class="btn" data-act="close">取消</button>`);
}
async function importFiles(files){
  if(!files.length)return;
  imp={busy:true};importDialog();
  const results=[];
  for(const file of files){
    try{const r=await api('POST','api/accounts/import?name='+encodeURIComponent(file.name),undefined,await file.arrayBuffer());results.push(...r.results);}
    catch(e){if(e.silent)return;results.push({name:file.name,ok:false,error:e.code||'failed'});}
  }
  if(!me)return;
  imp={results};importDialog();
  if(results.some(r=>r.ok))reload();
}

/* ============ 请求日志 ============ */
const RANGES_L=[['1h','1 小时',36e5],['24h','24 小时',864e5],['7d','7 天',7*864e5],['all','全部',0]];
async function loadLogs(facets){
  const t=ui.logs,p=new URLSearchParams({page:t.page,size:t.size});
  for(const k of ['q','account','model','status'])if(t[k])p.set(k,t[k]);
  const span=RANGES_L.find(r=>r[0]===t.range)?.[2];if(span)p.set('from',Date.now()-span);
  if(facets||!D.logFacets)p.set('facets','1');
  const r=await api('GET','api/logs?'+p);
  if(r.facets)D.logFacets=r.facets;
  D.logs=r;
}
function stPill(r){const s=r.status,k=!r.failed?'good':s===499?'':s<500?'warn':'bad';return `<span class="code-pill ${k}">${s}</span>`;}
function logTable(){
  const T=D.logs;
  if(!T.available)return empty('alert','请求记录不可用');
  const from=(T.page-1)*T.size+1,to=from+T.rows.length-1,pages=Math.max(1,Math.ceil(T.total/T.size));
  const pager=`<div class="pager"><small class="faint">${T.rows.length?`${from}–${to}`:'—'} / ${T.total.toLocaleString()}</small>
    <button class="btn sm ghost" data-act="lpg:${Math.min(T.page-1,pages)}" ${T.page<=1?'disabled':''} aria-label="上一页">‹</button><span class="mono faint">${T.page} / ${pages}</span><button class="btn sm ghost" data-act="lpg:${T.page+1}" ${T.page>=pages?'disabled':''} aria-label="下一页">›</button></div>`;
  if(!T.rows.length)return empty('activity','没有记录')+(T.page>1?pager:'');
  return `<div class="tbl logt"><div class="tr th"><span>时间</span><span>状态</span><span>模型</span><span class="c-acc">账号</span><span class="num-r c-tok">Token</span><span class="num-r">首字</span><span class="num-r c-lat">耗时</span><span class="c-err">错误</span></div>
  ${T.rows.map(r=>`<div class="tr click ${r.failed?'bad-row':''}" data-act="log:${r.id}" role="button" tabindex="0">
    <span class="mono c-time">${hms(r.ts)}<span class="sub">${md(r.ts)}</span></span>
    <span>${stPill(r)}</span>
    <span class="c-model"><span class="tm-a">${famIc(r.model)}<span class="mono" title="${esc(r.model)}">${esc(r.model||'—')}</span></span>${r.upstream?`<span class="sub mono">→ ${esc(r.upstream)}</span>`:''}</span>
    <span class="c-acc mono" title="${esc(r.account)}">${esc(r.account)}</span>
    <span class="num-r mono c-tok">${r.failed?'—':`${tk(r.in)}<span class="sub">${tk(r.out)} out</span>`}</span>
    <span class="num-r mono">${sec(r.ttft)}</span>
    <span class="num-r mono c-lat">${sec(r.latency)}</span>
    <span class="c-err" title="${esc(r.error)}">${esc(r.error)}</span>
  </div>`).join('')}</div>${pager}`;
}
const logTot=()=>{const T=D.logs;return `<span>Total <b>${T.total.toLocaleString()}</b></span><span>OK <b class="good-t">${T.ok.toLocaleString()}</b></span><span>Error <b class="bad-t">${T.err.toLocaleString()}</b></span>`;};
function pageLogs(){
  const t=ui.logs,F=D.logFacets||{accounts:[],models:[]};
  const sel=(k,list,all)=>`<select class="select inline" data-lf="${k}" aria-label="${all}"><option value="">${all}</option>${list.map(v=>`<option value="${esc(v)}" ${t[k]===v?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
  return head('请求日志',seg('lrange',RANGES_L.map(r=>[r[0],r[1]]),t.range,'时间范围'))+`<section class="card glass">
    <div class="tr-bar">
      <input class="input sm tr-q" data-lq value="${esc(t.q)}" placeholder="搜索模型、账号、错误、状态码" aria-label="搜索">
      ${sel('account',F.accounts,'全部账号')}${sel('model',F.models,'全部模型')}
      ${seg('lstatus',[['','全部'],['ok','成功'],['err','失败']],t.status,'状态')}
      <span class="tr-tot" id="l-tot">${logTot()}</span>
      <span class="tr-tools"><button class="btn sm ghost icon" data-act="lrefresh" aria-label="刷新">${ic('refresh')}</button><span class="switch-field sm"><button class="switch" role="switch" aria-checked="${t.auto}" aria-label="自动刷新" data-act="lauto"></button><small>Auto</small></span></span>
    </div>
    <div id="l-body">${logTable()}</div></section>`;
}
async function refreshLogs(){
  await loadLogs(false);
  const b=$('#l-body');if(!b)return;b.innerHTML=logTable();$('#l-tot').innerHTML=logTot();
}
async function logDetail(id){
  const r=await api('GET','api/logs/'+id);
  const kv=(k,v)=>v===''||v==null?'':`<span>${k}</span><span class="mono">${esc(v)}</span>`;
  openDialog(`${esc(r.model)}`,`${md(r.ts)} ${hms(r.ts)}`,`<div class="kv mt">${kv('状态',r.status+(r.failed?' · 失败':''))}${kv('账号',r.account)}${kv('上游模型',r.upstream)}${kv('首字',sec(r.ttft))}${kv('耗时',sec(r.latency))}
    ${kv('流式',r.stream?'是':'否')}${kv('输入',r.in.toLocaleString())}${kv('输出',r.out.toLocaleString())}${kv('缓存读取',r.cache.toLocaleString())}${kv('思考',r.think.toLocaleString())}
    ${kv('思考强度',r.effort)}${kv('路径',r.path)}${kv('请求 ID',r.requestId)}${kv('会话',r.session)}${kv('客户端',r.userAgent)}</div>
    ${r.failBody?`<div class="field"><span>错误内容</span><pre class="code log-pre">${esc(r.failBody)}</pre></div>`:''}`,
    `<button class="btn primary" data-act="close">关闭</button>`,true);
}
setInterval(()=>{if(me&&page==='logs'&&ui.logs.auto&&!dialogOpen()&&document.visibilityState==='visible')refreshLogs().catch(()=>{});},10000);

/* ============ 用量 ============ */
const SCOL=['#0a7cff','#8b5cf6','#14b8a6','#f59e0b','#ec4899','#94a3b8'];
const sCol=(S,name)=>SCOL[name==='其他'?5:Math.max(0,S.series.indexOf(name))%5];
function trendBars(S){
  const max=Math.max(1,...S.trend.map(b=>Object.values(b.by).reduce((a,v)=>a+v,0)));
  const hourly=S.step<864e5,every=Math.ceil(S.trend.length/12);
  const lab=t=>{const d=new Date(t);return hourly?pad(d.getHours())+':00':`${d.getMonth()+1}/${d.getDate()}`;};
  return `<div class="st-trend" role="img" aria-label="用量趋势">${S.trend.map((b,i)=>{const sum=Object.values(b.by).reduce((a,v)=>a+v,0);
    const tip=`${lab(b.t)} · ${tk(sum)} · ${b.req} 次\n`+S.series.filter(n=>b.by[n]).map(n=>`${n}：${tk(b.by[n])}`).join('\n');
    return `<div class="st-col" title="${esc(tip)}"><div class="st-stack" style="height:${sum/max*100}%">${S.series.map(n=>b.by[n]?`<i style="flex:${b.by[n]};background:${sCol(S,n)}"></i>`:'').join('')}</div><small>${i%every===0?lab(b.t):''}</small></div>`;}).join('')}</div>
    <div class="legend mt-s">${S.series.map(n=>`<span><i class="sq" style="background:${sCol(S,n)}"></i>${esc(n)}</span>`).join('')}</div>`;
}
function rank(list){
  if(!list.length)return '<p class="faint">暂无数据</p>';
  const max=Math.max(1,...list.map(x=>x.tok));
  return `<div class="st-rank">${list.slice(0,30).map((x,i)=>`<div class="st-ri"><span class="st-no ${i<3?'st-top':''}">${i+1}</span><div class="st-rb"><div class="st-rh"><span class="mono" title="${esc(x.name)}">${esc(x.name)}</span><b>${tk(x.tok)}</b></div><div class="meter"><span style="width:${Math.max(x.tok/max*100,1)}%;background:var(--accent)"></span></div><small>${x.req.toLocaleString()} 次 · 成功 ${pctOf(x.ok,x.req)}%</small></div></div>`).join('')}</div>`;
}
function pageUsage(){
  const S=D.usage,T=S.totals;
  const ctl=seg('urange',[['24h','24 小时'],['7d','7 天'],['30d','30 天']],ui.usage.range,'时间段');
  if(!S.available)return head('用量统计',ctl)+`<section class="card glass">${empty('alert','请求记录不可用')}</section>`;
  const kpi=`<div class="grid g4">
    <div class="stat glass"><div class="label">${ic('chart')}Token</div><div class="num">${tk(T.tok)}</div><small>输入 ${tk(T.in)} · 输出 ${tk(T.out+T.think)}</small></div>
    <div class="stat glass"><div class="label">${ic('activity')}请求</div><div class="num">${T.req.toLocaleString()}</div><small>成功 ${pctOf(T.ok,T.req)}%</small></div>
    <div class="stat glass"><div class="label">${ic('layers')}缓存命中</div><div class="num">${tk(T.cache)}</div><small>占输入 ${pctOf(T.cache,T.in)}%</small></div>
    <div class="stat glass"><div class="label">${ic('play')}首字</div><div class="num">${sec(T.ttft)}</div><small>${T.accounts} 个号 · ${T.models} 个模型</small></div></div>`;
  const tbl=`<div class="tbl st-tbl"><div class="tr th"><span>模型</span><span class="num-r">请求</span><span class="num-r">输入</span><span class="num-r">输出</span><span class="num-r">缓存</span><span class="num-r">首字</span><span class="num-r">合计</span></div>
    ${S.models.map(m=>`<div class="tr"><span class="mono st-mn" title="${esc(m.name)}"><i style="background:${sCol(S,S.series.includes(m.name)?m.name:'其他')}"></i>${esc(m.name)}</span><span class="num-r mono">${m.req.toLocaleString()}</span><span class="num-r mono">${tk(m.in)}</span><span class="num-r mono">${tk(m.out+m.think)}</span><span class="num-r mono">${tk(m.cache)}</span><span class="num-r mono">${sec(m.ttft)}</span><span class="num-r mono"><b>${tk(m.tok)}</b></span></div>`).join('')||'<p class="faint">这段时间没有请求</p>'}</div>`;
  return head('用量统计',ctl)+kpi+`<section class="card glass"><div class="card-head"><h2>趋势</h2><small class="faint">${S.step<864e5?'按小时':'按天'}</small></div>${trendBars(S)}</section>
    <div class="grid g2"><section class="card glass"><div class="card-head"><h2>按模型</h2></div>${tbl}</section><section class="card glass"><div class="card-head"><h2>按账号</h2></div>${rank(S.accounts)}</section></div>`;
}

/* ============ 浏览器 ============ */
let brTimer=null;
function brWatch(){
  const want=page==='browser'&&D.br?.state==='starting';
  if(want&&!brTimer)brTimer=setInterval(async()=>{try{D.br=await api('GET','api/browser');}catch(e){return;}if(D.br.state!=='starting'){clearInterval(brTimer);brTimer=null;if(page==='browser')renderSoon();}},2000);
}
function pageBrowser(){
  const b=D.br||{state:'idle'};
  setTimeout(brWatch);
  if(b.state==='running')return `<div class="br-bar glass"><span class="chip good"><span class="dot"></span>运行中</span>
    <div class="hstack">${flowPending()?`<button class="btn sm primary" data-act="add">${ic('plus')}添加账号</button>`:''}<a class="btn sm" href="browser/" target="_blank" rel="noopener">${ic('ext')}新窗口打开</a><button class="btn sm danger" data-act="brstop">${ic('power')}关闭</button></div></div>
    <iframe class="br-frame" src="browser/" title="浏览器" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`;
  const body=b.state==='starting'?`<span class="spin"></span><h2>正在启动…</h2>`
    :`<div class="bubble">${ic('window')}</div><button class="btn primary" data-act="brstart">${ic('play')}启动浏览器</button>${b.error?`<small class="bad-t">${esc(b.error)}</small>`:''}`;
  return head('内置 Chrome')+`<section class="card glass"><div class="empty">${body}</div></section>`;
}

/* ============ 设置 ============ */
function tiersBody(){
  const T=D.tiers;
  if(!T)return `<div class="hstack"><span class="spin"></span><span class="dim">读取模型列表…</span></div>`;
  if(T.err)return `<p class="faint">读不到模型列表</p>`;
  const nm=n=>`<button class="tname ${n.listed?'':'miss'}" data-act="copy:${esc(n.name)}" title="${esc(n.target?n.name+' → '+n.target:n.name)}"><span class="mono">${esc(n.name)}</span>${ic('copy')}</button>`;
  return `<div class="tbl tiers"><div class="tr th"><span>默认</span><span>low</span><span>medium</span><span>high</span></div>
    ${T.families.map(f=>`<div class="tr">${f.names.map(nm).join('')}</div>`).join('')||'<p class="faint">还没有配置档位别名</p>'}</div>
    ${T.untiered.length?`<div class="untier"><h3>${ic('alert')}没配档位的模型</h3><div class="hstack">${T.untiered.map(u=>u.models.map(m=>`<button class="tname" data-act="copy:${esc(m)}"><span class="mono">${esc(m)}</span>${ic('copy')}</button>`).join('')).join('')}</div></div>`:''}`;
}
/* API 密钥：CPA 的 access.api-keys；明文只在点开 / 复制时向后端要 */
const drawKeys=()=>{if(page==='keys'&&!dialogOpen())render();};
async function keyText(id){return ui.keys.text[id]||(ui.keys.text[id]=(await api('GET','api/keys/'+id)).key);}
const keyShow=(id,key)=>{ui.keys.text[id]=key;ui.keys.shown.add(id);};
function pageKeys(){
  const K=D.keys||[],newBtn=`<button class="btn primary" data-act="knew">${ic('plus')}创建密钥</button>`;
  const list=K.length?K.map(k=>`<div class="key">
      <div class="key-m"><div class="hstack"><strong>${esc(k.note||'未命名')}</strong><button class="btn sm ghost icon" data-act="kname:${k.id}" aria-label="改备注">${ic('pen')}</button></div>
        <button class="kval" data-act="kshow:${k.id}" aria-label="${ui.keys.shown.has(k.id)?'隐藏':'显示'}密钥"><span class="mono">${esc(ui.keys.shown.has(k.id)?ui.keys.text[k.id]:k.masked)}</span></button></div>
      <div class="hstack"><button class="btn sm ghost" data-act="kcopy:${k.id}">${ic('copy')}复制</button><button class="btn sm ghost icon danger" data-act="kdel:${k.id}" aria-label="删除" ${K.length<2?'disabled':''}>${ic('trash')}</button></div>
    </div>`).join(''):empty('terminal','还没有密钥',newBtn);
  return head('API 密钥',newBtn)+`<section class="card glass"><div class="card-head"><h2>我的密钥</h2></div>${list}</section>`;
}
function newKeyDialog(){
  openDialog('创建 API 密钥','',
    `<label class="field"><span>备注</span><input class="input" id="f-knote" maxlength="40" placeholder="例如：酒馆" autofocus></label>
    <label class="field"><span>密钥</span><input class="input mono" id="f-key" maxlength="200" placeholder="留空自动生成" autocomplete="off" spellcheck="false"></label>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="kcreate">创建</button>`);
}
function keyCreated(key){
  pendingKey=key;
  openDialog('密钥已创建','',`<div class="code mt"><span>${esc(key)}</span><button class="btn sm ghost" data-act="kcopynew">${ic('copy')}复制</button></div>`,
    `<button class="btn primary" data-act="close">完成</button>`);
}
function keyNoteDialog(id){
  const k=D.keys?.find(x=>x.id===id);if(!k)return;pendingKey=id;
  openDialog('改备注','',`<label class="field"><span>备注</span><input class="input" id="f-knote" maxlength="40" value="${esc(k.note)}" autofocus></label>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="knotesave">保存</button>`);
}
function pwDialog(){
  openDialog('修改密码','',`<form id="pwchg" autocomplete="on">
    <label class="field"><span>旧密码</span><input class="input" id="f-old" type="password" autocomplete="current-password" required autofocus></label>
    <label class="field"><span>新密码</span><input class="input" id="f-new" type="password" autocomplete="new-password" minlength="8" required></label>
    <label class="field"><span>再输一次</span><input class="input" id="f-new2" type="password" autocomplete="new-password" minlength="8" required></label>
    <button type="submit" hidden></button></form>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="pwsave">保存</button>`);
}
/* 设置项的「?」说明 */
const HELP={
  cpa:'本面板连的 CPA 管理接口地址和响应时间。连不上时账号、额度、密钥都读不到，客户端请求不受本面板影响。',
  cpapanel:'在新标签页打开 CPA 自带的管理面板，能看到本面板没有的原始配置。在那边改的东西会直接生效。',
  usage:'请求日志和用量从 CPA 的用量队列读取。读不到时这段时间的请求记不下来，队列只保留 5 分钟。',
  qmin:'后台多久把所有启用的号的额度查一遍。调短数字更新更及时，但会更频繁地调 Google 接口；关掉后只能手动刷新。',
  autoDisable:'Google 回 403（封号、要验证、被停用）的号自动在 CPA 里停用，客户端请求不再分到它。429、401、额度用完不算。',
  autoEnable:'被自动停用的号每 30 分钟试一次，能用了就自动重新启用。你手动停用的号不会被打开。',
  password:'修改登录本面板的密码。改完后其他地方登录的会话都会退出。',
  logout:'退出当前浏览器的登录。',
  requestLog:'CPA 把每个请求的完整内容写进日志文件，排查问题时有用。会占磁盘，平时建议关闭。',
  disableCooling:'打开后号被限流（429）也不进冷却，CPA 会继续往它发请求，可能失败更多、更容易被风控。',
  keepalive:'流式输出时每隔这么多秒发一个空心跳，防止客户端或 nginx 因为长时间没数据断开。0 为不发。',
  bootstrapRetries:'流式请求还没输出任何内容就失败时，换号重试几次。调大更稳，但首字可能更慢。',
  requestRetry:'上游失败时同一请求最多重试几次。调大更稳但更慢，失败时客户端要等更久。',
  maxRetryCredentials:'一次请求失败后最多换几个号再试。号多时调大能提高成功率。',
  maxRetryInterval:'所有号都在冷却时最多等多少秒再重试，超过就直接返回错误。调大更不容易报错，但客户端可能要等很久。',
  tiers:'各模型「默认 / low / medium / high」四档对应的名字，客户端里填这些名字就能选思考强度。只读，来自 CPA 配置。',
};
const tip=k=>`<button type="button" class="qh" data-tip="${k}" aria-label="说明" aria-expanded="false">?</button>`;
let tipPinned=false;
function hideTip(){
  const t=$('#tip');if(t)t.outerHTML='';
  $$('.qh[aria-expanded=true]').forEach(b=>{b.setAttribute('aria-expanded','false');b.removeAttribute('aria-describedby');});
  tipPinned=false;
}
function showTip(b,pin){
  hideTip();
  const t=document.createElement('div');t.id='tip';t.className='tip';t.setAttribute('role','tooltip');t.textContent=HELP[b.dataset.tip]||'';
  document.body.append(t);b.setAttribute('aria-expanded','true');b.setAttribute('aria-describedby','tip');tipPinned=!!pin;
  const r=b.getBoundingClientRect(),w=t.offsetWidth,x=Math.max(8,Math.min(r.left+r.width/2-w/2,innerWidth-w-8));
  const below=r.bottom+8+t.offsetHeight<innerHeight;
  t.style.left=x+'px';t.style.top=(below?r.bottom+8:r.top-8-t.offsetHeight)+'px';
}
document.addEventListener('mouseover',e=>{const b=e.target.closest?.('.qh');if(b&&!tipPinned&&b.getAttribute('aria-expanded')!=='true')showTip(b,false);});
document.addEventListener('mouseout',e=>{const b=e.target.closest?.('.qh');if(b&&!tipPinned&&!b.contains(e.relatedTarget))hideTip();});
document.addEventListener('click',e=>{
  const b=e.target.closest?.('.qh');
  if(b){e.stopPropagation();if(tipPinned&&b.getAttribute('aria-expanded')==='true')hideTip();else showTip(b,true);return;}
  if($('#tip'))hideTip();
},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#tip')){e.stopPropagation();const b=$('.qh[aria-expanded=true]');hideTip();b?.focus();}},true);
addEventListener('scroll',()=>{if($('#tip'))hideTip();},{passive:true});
function pageSettings(){
  const S=D.set,V=S.values,mins=S.app.quotaRefreshMinutes;
  const H=(l,k)=>`<h3>${l}${tip(k)}</h3>`;
  const sw=(k,l)=>V[k]===undefined?'':`<div class="rule">${H(l,k)}<button class="switch" role="switch" aria-checked="${!!V[k]}" aria-label="${l}" data-act="cpasw:${k}"></button></div>`;
  const num=(k,l,max,unit='')=>V[k]===undefined?'':`<div class="rule">${H(l,k)}<div class="hstack"><input class="input" type="number" min="0" max="${max}" value="${esc(V[k])}" data-cpanum="${k}" aria-label="${l}">${unit?`<small>${unit}</small>`:''}</div></div>`;
  return head('设置')+`<div class="grid g2">
    <section class="card glass"><div class="card-head"><h2>连接</h2></div>
      <div class="rule">${H('CPA','cpa')}<div class="hstack"><span class="mono faint">${esc(S.cpa.url)}</span>${S.cpa.ok?`<span class="chip good"><span class="dot"></span>${S.cpa.ms} ms</span>`:`<span class="chip bad" title="${esc(S.cpa.error||'')}"><span class="dot"></span>连不上</span>`}</div></div>
      <div class="rule">${H('CPA 面板','cpapanel')}<a class="btn sm" href="cpa/" target="_blank" rel="noopener">${ic('cpa')}打开</a></div>
      <div class="rule">${H('请求记录','usage')}<div class="hstack"><span class="mono faint">CPA 用量队列</span>${S.usage.ok?'<span class="chip good"><span class="dot"></span>正常</span>':`<span class="chip bad" title="${esc(S.usage.error||'')}"><span class="dot"></span>读不到</span>`}</div></div>
      <div class="rule">${H('后台刷新额度','qmin')}${seg('qmin',[[0,'关'],[5,'5 分'],[15,'15 分'],[30,'30 分'],[60,'60 分']],[0,5,15,30,60].includes(mins)?mins:15,'后台刷新额度')}</div>
      <div class="rule">${H('自动停用','autoDisable')}<button class="switch" role="switch" aria-checked="${!!S.app.autoDisable}" aria-label="自动停用" data-act="appsw:autoDisable"></button></div>
      <div class="rule">${H('自动恢复','autoEnable')}<button class="switch" role="switch" aria-checked="${!!S.app.autoEnable}" aria-label="自动恢复" data-act="appsw:autoEnable"></button></div>
      <div class="rule">${H('密码','password')}<button class="btn sm" data-act="pwdlg">${ic('key')}修改</button></div>
      <div class="rule">${H('退出登录','logout')}<button class="btn sm" data-act="logout">${ic('logout')}退出</button></div>
    </section>
    <section class="card glass"><div class="card-head"><h2>CPA</h2></div>
      ${S.cpa.ok?sw('requestLog','请求日志')+sw('disableCooling','关闭冷却')+num('keepalive','流式保活',300,'秒')+num('bootstrapRetries','流式启动重试',10,'次')+num('requestRetry','请求重试',10,'次')+num('maxRetryCredentials','最多换号',50,'个')+num('maxRetryInterval','最长等待',600,'秒'):'<p class="faint">连不上 CPA</p>'}
    </section></div>
    <section class="card glass"><div class="card-head"><h2>模型档位${tip('tiers')}</h2></div><div id="tiers">${tiersBody()}</div></section>`;
}

/* ============ 弹窗 / 提示 ============ */
function openDialog(title,sub,body,foot,wide=false){
  if(!$('#layer').innerHTML)lastFocus=document.activeElement;
  $('#layer').innerHTML=`<div class="shade" data-shade><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
    <div class="dialog-head"><div><h2 id="dlg-t">${title}</h2>${sub?`<p>${sub}</p>`:''}</div><button class="btn icon ghost" data-act="close" aria-label="关闭">${ic('x')}</button></div>
    ${body}<div class="dialog-foot">${foot}</div></section></div>`;
  ($('#layer [autofocus]')||$('#layer .dialog-foot .btn.primary')||$('#layer [data-act=close]'))?.focus();
}
function closeDialog(){
  $('#layer').innerHTML='';if(!flowPending())flow=null;imp=null;pendingDelete=null;pendingKey=null;
  if(dirty){dirty=false;if(me)render();}
  if(lastFocus&&document.contains(lastFocus))lastFocus.focus();lastFocus=null;
}
const dialogOpen=()=>!!$('#layer .dialog');
function toast(text,err=false){
  const t=document.createElement('div');t.className='toast'+(err?' err':'');t.innerHTML=ic(err?'alert':'check')+esc(text);
  $('#toasts').append(t);setTimeout(()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),300);},err?6000:2600);
}
function copy(text){(navigator.clipboard?.writeText(text)||Promise.reject()).then(()=>toast('已复制'),()=>toast('当前环境不允许复制',true));}
function applyTheme(){
  const t=lsGet('agy-theme','auto');
  document.documentElement.dataset.theme=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';
  $('#themebtn')?.replaceWith(document.createRange().createContextualFragment(themeBtn()));
}

/* ============ 事件 ============ */
const act=fn=>async(...a)=>{try{await fn(...a);}catch(e){fail(e);}};
document.addEventListener('click',act(async e=>{
  if(e.target.matches('[data-shade]')){closeDialog();return;}
  const cb=e.target.closest('input[data-sel]');
  if(cb){
    const ids=visible().map(a=>a.id),id=cb.dataset.sel;
    ui.acc.sel=e.shiftKey&&ui.acc.anchor?AF.rangeSelect(ui.acc.sel,ids,ui.acc.anchor,id,cb.checked):AF.toggleAll(ui.acc.sel,[id],cb.checked);
    ui.acc.anchor=id;refreshSel();return;
  }
  if(e.target.id==='selall'){ui.acc.sel=AF.toggleAll(ui.acc.sel,visible().map(a=>a.id),e.target.checked);ui.acc.anchor=null;refreshSel();return;}
  const el=e.target.closest('[data-act]');if(!el||el.disabled)return;
  const i=el.dataset.act.indexOf(':');
  const a=i<0?el.dataset.act:el.dataset.act.slice(0,i),arg=i<0?'':el.dataset.act.slice(i+1);
  switch(a){
    case 'goto':go(arg);break;
    case 'reload':await reload();break;
    case 'close':closeDialog();break;
    case 'theme':lsSet('agy-theme',isDark()?'light':'dark');applyTheme();break;
    case 'logout':await api('POST','api/logout');me=null;closeDialog();render();break;
    case 'copy':copy(arg);break;
    case 'toggle':{const x=D.accounts?.find(y=>y.id===arg);if(!x)break;const v=await api('PATCH','api/accounts/'+encodeURIComponent(arg),{disabled:!x.disabled});const prev=D.accounts;putAcc(v);patchAcc(prev);if(dialogOpen()&&$('#f-note')?.dataset.note===arg)accountDetail(arg);break;}
    case 'detail':accountDetail(arg);break;
    case 'reason':reasonDialog(arg);break;
    case 'rsraw':{const p=$('#rs-p'),r=$('#rs-r');if(!p||!r)break;const show=r.hidden;r.hidden=!show;p.hidden=show;el.textContent=show?'显示解析结果':'显示原始报文';break;}
    case 'asort':ui.acc.sort=AF.nextSort(ui.acc.sort,arg);lsSet('agyme-accsort',ui.acc.sort);ui.acc.anchor=null;ui.acc.page=1;refreshAcc();break;
    case 'apg':ui.acc.page=+arg||1;refreshAcc();$('#acc-body')?.scrollIntoView({block:'start',behavior:'smooth'});break;
    case 'jump':ui.acc={...ui.acc,q:'',tier:'',status:'',focus:arg};go('accounts');break;
    case 'banoff':await api('PATCH','api/accounts/'+encodeURIComponent(arg),{disabled:true});toast('已停用');await reload();break;
    case 'banall':await api('POST','api/accounts/batch',{op:'disable',ids:D.ov.bans.map(b=>b.id)});toast('已全部停用');await reload();break;
    case 'add':if(!flowPending()&&!flow?.err)flow={};addDialog();break;
    case 'oauthcancel':flow=null;closeDialog();break;
    case 'rtimport':await importTokens();break;
    case 'rtmore':flow={};addDialog();break;
    case 'oauthstart':{flow.busy=true;flow.err=null;addDialog();try{const r=await api('POST','api/accounts/oauth');Object.assign(flow,{url:r.url,state:r.state,busy:false});addDialog();window.open(r.url,'_blank','noopener');pollOAuth();}catch(err){if(err.silent||!flow)break;flow.busy=false;flow.err=errText(err);addDialog();}break;}
    case 'copyurl':copy(flow?.url||'');break;
    case 'oauthbr':await api('POST','api/browser/start',{url:flow.url});closeDialog();go('browser');break;
    case 'oauthcb':{const v=$('#f-cb').value.trim();if(!v)break;await api('POST','api/accounts/oauth/callback',{state:flow.state,url:v});toast('已提交，等待 CPA 完成');break;}
    case 'import':imp=null;importDialog();break;
    case 'importmore':imp=null;importDialog();break;
    case 'exportall':await exportIds([]);break;
    case 'exportsel':await exportIds([...ui.acc.sel]);break;
    case 'exportone':await exportIds([arg]);break;
    case 'selnone':ui.acc.sel=new Set();ui.acc.anchor=null;refreshSel();break;
    case 'ftier':ui.acc.tier=arg;refreshAcc(true);break;
    case 'fstatus':ui.acc.status=ui.acc.status===arg?'':arg;refreshAcc(true);break;
    case 'batch':{
      const ids=[...ui.acc.sel];if(!ids.length)break;
      if(arg==='delete'){confirmDelete(ids);break;}
      const r=await api('POST','api/accounts/batch',{op:arg,ids});toast(`${arg==='enable'?'已启用':'已停用'} ${r.ok} 个${r.failed?`，${r.failed} 个失败`:''}${r.skipped?`，${r.skipped} 个已不在`:''}`,!!(r.failed||r.skipped));await reload();break;}
    case 'delone':confirmDelete([arg]);break;
    case 'dodelete':{const ids=pendingDelete||[];closeDialog();const r=await api('POST','api/accounts/batch',{op:'delete',ids});ui.acc.sel=new Set([...ui.acc.sel].filter(x=>!ids.includes(x)));ui.acc.anchor=null;toast(`已删除 ${r.ok} 个${r.failed?`，${r.failed} 个失败`:''}`,!!r.failed);await reload();break;}
    case 'bropen':{const x=D.accounts?.find(y=>y.id===arg);if(!x?.action)break;await api('POST','api/browser/start',{url:x.action.url});closeDialog();go('browser');break;}
    case 'log':await logDetail(arg);break;
    case 'lpg':ui.logs.page=Math.max(1,+arg);await refreshLogs();break;
    case 'lrefresh':await refreshLogs();break;
    case 'lauto':ui.logs.auto=!ui.logs.auto;el.setAttribute('aria-checked',ui.logs.auto);break;
    case 'brstart':D.br=await api('POST','api/browser/start',{});render();break;
    case 'brstop':D.br=await api('POST','api/browser/stop');render();if(D.br.state!=='idle')toast('没关掉：'+(D.br.error||''),true);break;
    case 'pwdlg':pwDialog();break;
    case 'pwsave':await savePassword();break;
    case 'kshow':if(ui.keys.shown.has(arg))ui.keys.shown.delete(arg);else keyShow(arg,await keyText(arg));drawKeys();break;
    case 'kcopy':copy(await keyText(arg));break;
    case 'knew':newKeyDialog();break;
    case 'kcreate':{const v=$('#f-key').value.trim(),note=$('#f-knote').value.trim();const r=await api('POST','api/keys',v?{key:v,note}:{generate:true,note});D.keys=r.keys;keyShow(r.id,r.key);closeDialog();render();keyCreated(r.key);break;}
    case 'kcopynew':if(pendingKey)copy(pendingKey);break;
    case 'kname':keyNoteDialog(arg);break;
    case 'knotesave':{const id=pendingKey;const v=$('#f-knote').value.trim();closeDialog();if(!id)break;D.keys=(await api('PATCH','api/keys/'+id,{note:v})).keys;render();toast('备注已保存');break;}
    case 'kdel':{const k=D.keys?.find(x=>x.id===arg);if(!k)break;pendingKey=arg;
      openDialog('删除这个密钥？','',`<div class="dlist"><span class="mono">${esc(k.masked)}</span>${k.note?`<span>${esc(k.note)}</span>`:''}</div>
        <div class="note bad mt">${ic('alert')}<span>用这个密钥的客户端会立刻连不上 CPA。</span></div>`,
        `<button class="btn" data-act="close">取消</button><button class="btn primary danger-fill" data-act="kdodel">${ic('trash')}删除</button>`);break;}
    case 'kdodel':{const id=pendingKey;closeDialog();if(!id)break;D.keys=(await api('DELETE','api/keys/'+id)).keys;delete ui.keys.text[id];ui.keys.shown.delete(id);drawKeys();toast('已删除');break;}
    case 'appsw':{const v=!D.set.app[arg];await api('PATCH','api/settings',{key:arg,value:v});D.set.app[arg]=v;el.setAttribute('aria-checked',v);toast('已保存');break;}
    case 'cpasw':{const v=!D.set.values[arg];await api('PATCH','api/settings',{key:arg,value:v});D.set.values[arg]=v;el.setAttribute('aria-checked',v);toast('已保存');break;}
  }
}));
document.addEventListener('change',act(async e=>{
  const t=e.target;
  if(t.id==='f-files'){await importFiles([...t.files]);return;}
  if(t.dataset.note){const id=t.dataset.note,v=await api('PATCH','api/accounts/'+encodeURIComponent(id),{note:t.value});putAcc(v);refreshAcc();toast('备注已保存');return;}
  if(t.dataset.lf){ui.logs[t.dataset.lf]=t.value;ui.logs.page=1;await refreshLogs();return;}
  if(t.dataset.cpanum){const r=await api('PATCH','api/settings',{key:t.dataset.cpanum,value:+t.value});D.set.values[t.dataset.cpanum]=r.value;t.value=r.value;toast('已保存');return;}
  if(t.name==='addtab'){ui.addTab=t.value;lsSet('agyme-addtab',t.value);if(flow){flow.err=null;flow.rt=null;}addDialog();return;}
  if(t.dataset.accsize!==undefined){ui.acc.size=+t.value||10;lsSet('agyme-accsize',String(ui.acc.size));ui.acc.page=1;refreshAcc();return;}
  if(t.dataset.accjump!==undefined){ui.acc.page=+t.value||1;refreshAcc();$('#acc-body')?.scrollIntoView({block:'start',behavior:'smooth'});return;}
  if(t.name==='accview'){ui.acc.view=t.value;lsSet('agyme-accview',t.value);refreshAcc(true);return;}
  if(t.name==='lstatus'){ui.logs.status=t.value;ui.logs.page=1;await refreshLogs();return;}
  if(t.name==='lrange'){ui.logs.range=t.value;ui.logs.page=1;await refreshLogs();return;}
  if(t.name==='urange'){ui.usage.range=t.value;await reload();return;}
  if(t.name==='qmin'){await api('PATCH','api/settings',{key:'quotaRefreshMinutes',value:+t.value});D.set.app.quotaRefreshMinutes=+t.value;toast('已保存');return;}
}));
let qT=null;
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.dataset.accq!==undefined){ui.acc.q=t.value;refreshAcc(true);return;}
  if(t.dataset.lq!==undefined){clearTimeout(qT);qT=setTimeout(()=>{ui.logs.q=t.value.trim();ui.logs.page=1;refreshLogs().catch(fail);},300);}
});
async function savePassword(){
  const o=$('#f-old').value,n=$('#f-new').value,n2=$('#f-new2').value;
  if(!o){$('#f-old').focus();return;}
  if(n.length<8){toast(ERR.password_too_short,true);$('#f-new').focus();return;}
  if(n!==n2){toast(ERR.password_mismatch,true);$('#f-new2').focus();return;}
  await api('POST','api/password',{old:o,password:n,confirm:n2});
  closeDialog();toast('密码已修改，其他设备已退出');
}
document.addEventListener('submit',act(async e=>{
  if(e.target.id==='pwchg'){e.preventDefault();await savePassword();return;}
  if(e.target.id!=='pwform')return;e.preventDefault();
  await api('POST','api/login',{password:$('#f-pass').value});
  await boot();
}));
document.addEventListener('dragover',e=>{const d=e.target.closest?.('#drop');if(d){e.preventDefault();d.classList.add('on');}});
document.addEventListener('dragleave',e=>{e.target.closest?.('#drop')?.classList.remove('on');});
document.addEventListener('drop',act(async e=>{const d=e.target.closest?.('#drop');if(!d)return;e.preventDefault();await importFiles([...e.dataTransfer.files]);}));
document.addEventListener('keydown',e=>{
  const dlg=$('#layer .dialog');
  if(e.key==='Escape'&&dlg){closeDialog();return;}
  if(e.key==='Enter'&&e.target.id==='f-cb'){$('[data-act=oauthcb]')?.click();return;}
  if(e.key==='Enter'&&(e.target.id==='f-key'||e.target.id==='f-knote')){$('[data-act=kcreate],[data-act=knotesave]')?.click();return;}
  if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('.tr.click')){e.preventDefault();e.target.click();return;}
  if(e.key==='Tab'&&dlg){
    const f=$$('button:not(:disabled),input:not(:disabled),select,a[href],[tabindex]:not([tabindex="-1"])',dlg).filter(x=>x.offsetParent!==null);
    if(!f.length)return;const first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(lsGet('agy-theme','auto')==='auto')applyTheme();});
// 仪表盘每分钟自己刷新一次
setInterval(()=>{if(me&&page==='dash'&&!dialogOpen()&&document.visibilityState==='visible')reload();},60000);

async function boot(){
  try{me=await api('GET','api/me');}catch(e){me=null;}
  if(me)await load(page);else render();
}
applyTheme();
boot();
})();
