(function(){
  if(window.__togetherThemeToggleInstalled)return;window.__togetherThemeToggleInstalled=true;
  const key='together-network-theme';
  let saved='dark';try{saved=localStorage.getItem(key)||'dark'}catch(e){}
  const style=document.createElement('style');
  style.textContent=`
  body[data-theme="light"]{background:#f3f6fb!important;color:#182230!important}
  body[data-theme="light"] .main-content{background:#f3f6fb!important;color:#182230!important}
  body[data-theme="light"] .shell,body[data-theme="light"] main,body[data-theme="light"] .wrap{color:#182230}
  body[data-theme="light"] .card,body[data-theme="light"] .dash-card,body[data-theme="light"] .product-card,body[data-theme="light"] .chart-card,body[data-theme="light"] .rule-grid>div{background:#fff!important;color:#182230!important;border-color:#d9e1ec!important;box-shadow:0 5px 20px #1720330d}
  body[data-theme="light"] .muted,body[data-theme="light"] .muted2,body[data-theme="light"] .lead,body[data-theme="light"] .chart-subtitle,body[data-theme="light"] .empty-chart{color:#596579!important}
  body[data-theme="light"] input:not([type="checkbox"]):not([type="radio"]),body[data-theme="light"] select,body[data-theme="light"] textarea{background:#fff!important;color:#182230!important;border-color:#cbd5e1!important}
  body[data-theme="light"] table th,body[data-theme="light"] table td{border-color:#dbe2ea!important}
  body[data-theme="light"] .top{background:#fff!important;border-color:#d9e1ec!important}
  body[data-theme="light"] .side-nav a{color:#39465a}
  body[data-theme="light"] .side-nav a.active,body[data-theme="light"] .side-nav a:hover{background:#e7edf6!important;color:#152238!important}
  body[data-theme="light"] .metric.id-card{background:#fff!important;color:#182230!important}
  body[data-theme="light"] .admin-sidebar{background:#e8edf5!important;color:#182230!important;border-color:#d3dce8!important}
  body[data-theme="light"] .admin-sidebar a{color:#334155!important}
  body[data-theme="light"] .admin-sidebar .side-title{border-color:#cbd5e1!important}
  body[data-theme="light"] .admin-sidebar .side-group{color:#111827!important}
  body[data-theme="light"] h1,body[data-theme="light"] h2,body[data-theme="light"] h3,body[data-theme="light"] h4,body[data-theme="light"] p,body[data-theme="light"] label,body[data-theme="light"] li,body[data-theme="light"] td,body[data-theme="light"] th,body[data-theme="light"] strong,body[data-theme="light"] small{color:#111827}
  body[data-theme="light"] span:not(.metric-value):not(.metric-label):not(.status-light):not(.legend-dot):not(.brand-mark){color:#111827}
  body[data-theme="light"] a:not(.btn):not(.messages-shortcut):not(.top-profile){color:#1d4ed8}
  body[data-theme="light"] .side-nav a.active,body[data-theme="light"] .side-nav a:hover{color:#111827!important}
  body[data-theme="light"] .metric-value,body[data-theme="light"] .metric-label{color:#111827}
  body[data-theme="light"] .wallet-card.primary,body[data-theme="light"] .wallet-card.primary *{color:#fff!important}
  body[data-theme="light"] .messages-shortcut,body[data-theme="light"] .top-profile{color:#fff!important}
  body[data-theme="light"] button:not(#togetherThemeToggle),body[data-theme="light"] .btn{color:#111827}
  body[data-theme="light"] input::placeholder,body[data-theme="light"] textarea::placeholder{color:#4b5563!important;opacity:1}
  #togetherThemeToggle{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:42px;padding:9px 13px;border:1px solid #64748b;border-radius:999px;background:#111827;color:#fff;font:700 13px/1.2 "Segoe UI",Tahoma,Arial,sans-serif;box-shadow:0 4px 14px #0003;cursor:pointer;touch-action:manipulation}
  #togetherThemeToggle:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}
  body[data-theme="light"] #togetherThemeToggle{background:#fff;color:#111827;border-color:#cbd5e1}
  @media(max-width:600px){#togetherThemeToggle{top:10px;left:50%;transform:translateX(-50%);min-height:38px;padding:8px 10px;font-size:12px}}
  `;
  (document.head||document.documentElement).appendChild(style);
  const accountStyle=document.createElement('style');
  accountStyle.id='tnAccountThemeOverrides';
  accountStyle.textContent=`
    body{background:var(--tn-account-bg,#071426)!important;color:var(--tn-account-text,#f5f7fb)}
    body .main-content{background:var(--tn-account-bg,#071426)!important;color:var(--tn-account-text,#f5f7fb)}
    body .side-nav a.active,body .side-nav a:hover{background:color-mix(in srgb,var(--tn-account-primary,#42d6a4) 20%,transparent)!important}
    body .side-nav a.active .tn-menu-icon{background:color-mix(in srgb,var(--tn-account-primary,#42d6a4) 28%,transparent)!important}
    body .btn.primary,body button.btn.primary,body .form-actions .btn.primary{background:var(--tn-account-button,#1683ff)!important;color:#fff!important;border-color:transparent!important}
    body button:not(#togetherThemeToggle),body .btn{background:#ffffff08!important;color:var(--tn-account-text,#f5f7fb)!important;border-color:color-mix(in srgb,var(--tn-account-primary,#42d6a4) 38%,#64748b)!important}body .btn.primary,body button.btn.primary,body .form-actions .btn.primary{background:var(--tn-account-button,#5ca8ff)!important;color:#06121b!important;border-color:transparent!important}
    body .eyebrow,body .badge{border-color:color-mix(in srgb,var(--tn-account-primary,#42d6a4) 35%,transparent)!important}
    body .field input:focus,body .field textarea:focus{border-color:var(--tn-account-primary,#42d6a4)!important}
    body[data-theme="light"]{background:var(--tn-account-bg,#f3f6fb)!important;color:var(--tn-account-text,#182230)!important}
    body[data-theme="light"] .main-content{background:var(--tn-account-bg,#f3f6fb)!important;color:var(--tn-account-text,#182230)!important}
    body[data-theme="light"] h1,body[data-theme="light"] h2,body[data-theme="light"] h3,body[data-theme="light"] p,body[data-theme="light"] label,body[data-theme="light"] li,body[data-theme="light"] td,body[data-theme="light"] th,body[data-theme="light"] strong{color:var(--tn-account-text,#182230)}
  `;
  (document.head||document.documentElement).appendChild(accountStyle);
  function applyAccountTheme(s){if(!s)return;const primary=s.theme_primary_color||'#42d6a4',button=s.theme_button_color||'#1683ff',text=s.theme_text_color||(s.theme_mode==='light'?'#182230':'#f5f7fb'),bg=s.theme_bg_color||(s.theme_mode==='light'?'#f3f6fb':'#071426');document.documentElement.style.setProperty('--tn-account-primary',primary);document.documentElement.style.setProperty('--tn-account-button',button);document.documentElement.style.setProperty('--tn-account-text',text);document.documentElement.style.setProperty('--tn-account-bg',bg);document.documentElement.style.setProperty('--brand',primary);document.documentElement.style.setProperty('--brand2',button);document.documentElement.style.setProperty('--text',text);document.documentElement.style.setProperty('--bg',bg);try{localStorage.setItem('tn_account_theme',JSON.stringify(s))}catch(e){}}
  async function loadAccountTheme(){try{const r=await fetch('/api/marketer-settings',{credentials:'include',cache:'no-store'});if(!r.ok)return;const d=await r.json();if(d.settings){applyAccountTheme(d.settings);apply(d.settings.theme_mode||'dark')}}catch(e){}}
  function apply(theme){theme=theme==='light'?'light':'dark';document.body.setAttribute('data-theme',theme);const b=document.getElementById('togetherThemeToggle');if(b){b.innerHTML=theme==='dark'?'☀️ الوضع النهاري':'🌙 الوضع الليلي';b.setAttribute('aria-label',theme==='dark'?'التبديل إلى الوضع النهاري':'التبديل إلى الوضع الليلي');b.setAttribute('aria-pressed',String(theme==='light'))}try{localStorage.setItem(key,theme)}catch(e){}}
  function init(){if(!document.body)return;const b=document.createElement('button');b.id='togetherThemeToggle';b.type='button';b.addEventListener('click',function(){apply(document.body.getAttribute('data-theme')==='dark'?'light':'dark')});document.body.appendChild(b);apply(saved);loadAccountTheme()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
  // Preserve the user's place when navigating away and returning with Back/Forward.
  (function installPageState(){
    const key='tn-page-state:'+location.pathname;
    const navType=()=>{try{return performance.getEntriesByType('navigation')[0]?.type||''}catch(e){return ''}};
    const getControlKey=el=>el.id?'#'+el.id:(el.name?'[name="'+el.name.replace(/"/g,'\\\\"')+'"]':null);
    function snapshot(){
      try{
        const controls={};document.querySelectorAll('input,select,textarea').forEach(el=>{if(!el.matches('[type="password"],[type="file"]')){const k=getControlKey(el);if(k)controls[k]=el.type==='checkbox'||el.type==='radio'?{checked:el.checked,value:el.value}:{value:el.value}}});
        const previous=JSON.parse(sessionStorage.getItem(key)||'{}');const activePage=document.querySelector('.page-numbers button.active,.pager button.active,[aria-current="page"]');const pagination=activePage?{text:(activePage.textContent||'').trim(),page:activePage.getAttribute('data-page'),container:activePage.parentElement?.id||'',at:Date.now()}:previous.pagination;const state={x:window.scrollX||0,y:window.scrollY||0,controls,tab:document.querySelector('[data-tab].active')?.getAttribute('data-tab')||null,pagination,at:Date.now()};
        sessionStorage.setItem(key,JSON.stringify(state));
      }catch(e){}
    }
    document.addEventListener('click',e=>{if(e.target.closest('a[href]'))snapshot();const p=e.target.closest('.page-numbers button,.pager button,[id$="Pager"] button,[data-page],[aria-current="page"]');if(p){try{const st=JSON.parse(sessionStorage.getItem(key)||'{}');st.pagination={text:(p.textContent||'').trim(),page:p.getAttribute('data-page'),container:p.parentElement?.id||'',at:Date.now()};sessionStorage.setItem(key,JSON.stringify(st))}catch(err){}}},true);
    window.addEventListener('pagehide',snapshot);
    window.addEventListener('pageshow',()=>{
      if(navType()!=='back_forward')return;
      try{const st=JSON.parse(sessionStorage.getItem(key)||'null');if(!st||Date.now()-Number(st.at||0)>30*60*1000)return;
        Object.entries(st.controls||{}).forEach(([selector,v])=>{let el;try{el=document.querySelector(selector)}catch(e){}if(!el)return;if(typeof v==='object'&&('checked'in v)){el.checked=!!v.checked;if(v.value!=null)el.value=v.value}else if(v&&typeof v.value==='string')el.value=v.value});
        if(st.tab){const tab=document.querySelector('[data-tab="'+CSS.escape(st.tab)+'"]');if(tab&& !tab.classList.contains('active'))tab.click()}
        if(st.pagination){setTimeout(()=>{const p=st.pagination;let container=p.container?document.getElementById(p.container):null;let candidates=container?container.querySelectorAll('button,[data-page]'):document.querySelectorAll('.page-numbers button,.pager button,[id$="Pager"] button,[data-page]');let target=null;for(const b of candidates){if(p.page!=null&&b.getAttribute('data-page')===p.page){target=b;break}}if(!target&&p.text)for(const b of candidates){if((b.textContent||'').trim()===p.text){target=b;break}}if(target&&!target.disabled&&!target.classList.contains('active')&&target.getAttribute('aria-current')!=='page')target.click()},250)}
        setTimeout(()=>window.scrollTo({left:Number(st.x||0),top:Number(st.y||0),behavior:'auto'}),80);
      }catch(e){}
    });
  })();
})();