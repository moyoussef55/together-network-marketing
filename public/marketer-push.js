(()=>{"use strict";
const IS_MARKETING_SITE=String(location.hostname||"").toLowerCase()==="marketing.together-v-egp.com";
const CONFIG_URL=IS_MARKETING_SITE?"/api/marketer/push-config?site=marketing":"/api/marketer/push-config";
let readyPromise=null,oneSignal=null,userId=null,appId=null;
const $=s=>document.querySelector(s);
function status(text){const el=$("#pushStatus");if(el)el.textContent=text}
function isIOS(){return /iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)}
function isStandalone(){return window.matchMedia("(display-mode: standalone)").matches||navigator.standalone===true}
function unsupportedMessage(){
 if(!window.isSecureContext)return "يجب فتح توجيذر عبر اتصال HTTPS آمن لتفعيل الإشعارات.";
 if(isIOS()&&!isStandalone())return "على iPhone وiPad لا تعمل إشعارات الويب من تبويب عادي؛ هذا قيد من iOS/iPadOS. لا تحتاج إلى Safari: من Chrome اضغط مشاركة ثم «إضافة إلى الشاشة الرئيسية»، وبعدها افتح توجيذر من الأيقونة الجديدة وفعّل الإشعارات. يلزم iOS/iPadOS 16.4 أو أحدث.";
 if(!("Notification" in window)||!("serviceWorker" in navigator)||!("PushManager" in window)){
  const ua=String(navigator.userAgent||"");
  if(/FBAN|FBAV|Instagram|WhatsApp|Telegram|Line\/|;\s?wv\)|WebView/i.test(ua))return "يبدو أنك فتحت توجيذر من داخل تطبيق آخر. افتح قائمة المتصفح واختر «فتح في Chrome» أو افتح الرابط مباشرة في Chrome المحدث، ثم فعّل الإشعارات.";
  if(isIOS())return "على iPhone/iPad لا تعمل إشعارات الويب من تبويب عادي. من Chrome نفسه اضغط مشاركة ثم «إضافة إلى الشاشة الرئيسية»، وبعدها افتح توجيذر من الأيقونة. يلزم iOS/iPadOS 16.4 أو أحدث.";
  return "هذا المتصفح لا يوفّر واجهات إشعارات الويب اللازمة. افتح الموقع مباشرةً في Chrome محدث على Android (وليس داخل Facebook أو WhatsApp أو تطبيق آخر)، وتأكد من السماح بالإشعارات للموقع.";
 }
 return "";
}
function loadSdk(){
 if(readyPromise)return readyPromise;
 readyPromise=(async()=>{
  const r=await fetch(CONFIG_URL,{credentials:"include",cache:"no-store"});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||"تعذر تحميل إعدادات الإشعارات");
  if(!d.configured||!d.app_id||!d.user_id)throw new Error("إعدادات إشعارات الهاتف غير مكتملة");
  appId=String(d.app_id||"").trim();userId=String(d.user_id||"").trim();
  if(!appId)throw new Error("OneSignal App ID لم يصل إلى الصفحة من إعدادات المشروع.");
  window.OneSignalDeferred=window.OneSignalDeferred||[];
  const initialized=new Promise((resolve,reject)=>{
   window.OneSignalDeferred.push(async OneSignal=>{
    try{
     oneSignal=OneSignal;
     await OneSignal.init({appId:String(appId||"").trim(),serviceWorkerPath:"/OneSignalSDKWorker.js",serviceWorkerParam:{scope:"/"},notifyButton:{enable:false},allowLocalhostAsSecureOrigin:false});
     await OneSignal.login(userId);
     resolve(OneSignal);
    }catch(e){reject(e)}
   });
  });
  let script=document.querySelector('script[data-onesignal-sdk="together"]');
  if(!script){
   script=document.createElement("script");script.dataset.onesignalSdk="together";script.src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";script.defer=true;
   script.onerror=()=>status("تعذر تحميل خدمة الإشعارات. تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.");
   document.head.appendChild(script);
  }
  return await Promise.race([initialized,new Promise((_,reject)=>setTimeout(()=>reject(new Error("تأخر تحميل خدمة الإشعارات. أعد تحميل الصفحة وحاول مرة أخرى.")),15000))]);
 })();
 readyPromise.catch(()=>{readyPromise=null});
 return readyPromise;
}
async function confirmPushSubscription(s){
 const sub=s&&s.User&&s.User.PushSubscription;
 if(!sub||typeof sub.optIn!=="function")throw new Error("واجهة اشتراك OneSignal غير متاحة بعد التهيئة.");
 await sub.optIn();
 const started=Date.now();
 while(Date.now()-started<15000){
  const opted=typeof sub.optedIn==="boolean"?sub.optedIn:null;
  const id=sub.id||null,token=sub.token||null;
  if(opted===true&&id&&token)return {ok:true};
  await new Promise(resolve=>setTimeout(resolve,750));
 }
 const opted=typeof sub.optedIn==="boolean"?sub.optedIn:null;
 const id=sub.id||null,token=sub.token||null;
 if(opted===false)return {ok:false,reason:"opted_out"};
 if(!id)return {ok:false,reason:"missing_subscription_id"};
 if(!token)return {ok:false,reason:"missing_push_token"};
 return {ok:false,reason:"subscription_pending"};
}
async function requestPermission(){
 const unsupported=unsupportedMessage();if(unsupported)throw new Error(unsupported);
 if(Notification.permission==="denied")throw new Error("إشعارات توجيذر محظورة في إعدادات المتصفح. افتح إعدادات الموقع واجعل الإشعارات «سماح»، ثم استخدم زر التفعيل في صفحة رسائلي.");
 // Trigger the native browser permission dialog directly from the click, before
 // awaiting SDK/network work. Browsers require this user gesture.
 if(Notification.permission!=="granted"){
  if(typeof Notification.requestPermission==="function")await Notification.requestPermission();
 }
 if(Notification.permission!=="granted"){
  if(Notification.permission==="denied")throw new Error("لم يتم السماح بالإشعارات. غيّر الإذن من إعدادات المتصفح.");
  return false;
 }
 // Permission is granted; finish SDK initialization/subscription asynchronously.
 try{
  status("تم السماح من المتصفح؛ جارٍ انتظار تسجيل الاشتراك الفعلي في OneSignal…");
  const s=await loadSdk();
  const result=await confirmPushSubscription(s);
  if(result.ok){status("تم تأكيد اشتراك الجهاز في OneSignal.");return true;}
  const reasons={opted_out:"OneSignal يعتبر هذا الجهاز غير مشترك رغم إذن المتصفح. أعد فتح توجيذر من أيقونة الشاشة الرئيسية وتحقق من إعدادات إشعارات التطبيق.",missing_subscription_id:"لم ينشئ OneSignal معرّف اشتراك لهذا الجهاز خلال 15 ثانية؛ يرجح وجود مشكلة في تسجيل Web Push أو إعدادات الموقع/Service Worker.",missing_push_token:"تم العثور على معرّف الاشتراك لكن لم يصدر رمز Push من خدمة Apple بعد.",subscription_pending:"ما زال اشتراك OneSignal قيد المعالجة ولم يكتمل بعد."};
  status(reasons[result.reason]||"لم يكتمل تسجيل الجهاز في OneSignal.");
  return false;
 }catch(e){status("فشل تهيئة أو تسجيل OneSignal: "+(e.message||"خطأ غير معروف"));throw e}
 return true;
}
async function showFirstVisitDialog(){
 if(!document.body||!location.pathname.startsWith("/marketer/dashboard"))return;
 let promptUserId="unknown";try{const cr=await Promise.race([fetch(CONFIG_URL,{credentials:"include",cache:"no-store"}),new Promise((_,reject)=>setTimeout(()=>reject(new Error("push-config-timeout")),1400))]);const cd=await cr.json().catch(()=>({}));if(cr.ok&&cd.user_id)promptUserId=String(cd.user_id)}catch{}
 const key="tn_push_prompt_seen_v5:"+promptUserId;
 try{
  const params=new URLSearchParams(location.search);
  if(params.get("resetPushPrompt")==="1"){
   localStorage.removeItem(key);
   params.delete("resetPushPrompt");
   const query=params.toString();
   history.replaceState(null,"",location.pathname+(query?"?"+query:"")+location.hash);
  }
  if(localStorage.getItem(key))return;
 }catch{}
 if("Notification" in window&&Notification.permission==="granted"){loadSdk().then(async s=>{const result=await confirmPushSubscription(s);if(result.ok)status("تم تأكيد اشتراك الجهاز في OneSignal.");else status("تعذر إكمال اشتراك OneSignal تلقائيًا: "+result.reason)}).catch(e=>status("تعذر تأكيد تسجيل الجهاز في OneSignal: "+(e.message||"خطأ غير معروف")))}
 const unsupported=unsupportedMessage();
 // Render the prompt immediately after login; initialize OneSignal in parallel.
 // Do not hide the dialog just because the SDK/network is slow.
 if(!unsupported)loadSdk().catch(e=>status(e.message||"سيتم تجهيز خدمة الإشعارات عند الموافقة."));
 try{if(localStorage.getItem(key))return}catch{}
 const overlay=document.createElement("div");overlay.id="tnPushPermissionDialog";
 overlay.innerHTML='<style>#tnPushPermissionDialog #tnPushTitle{color:#000!important}#tnPushPermissionDialog #tnPushIntro{color:#000!important}#tnPushPermissionDialog #tnPushAllow{background:#16a34a!important;background-color:#16a34a!important;color:#fff!important;border:0!important}#tnPushPermissionDialog #tnPushLater{background:#dc2626!important;background-color:#dc2626!important;color:#fff!important;border:0!important}</style><div role="dialog" aria-modal="true" aria-labelledby="tnPushTitle" style="width:min(430px,calc(100vw - 24px));max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:auto;background:#fff;color:#000;border-radius:18px;padding:clamp(16px,5vw,25px);box-shadow:0 18px 70px #0005;text-align:center;font-family:Arial,sans-serif"><div style="font-size:42px;margin-bottom:8px">🔔</div><h2 id="tnPushTitle" style="margin:0 0 12px;font-size:22px;color:#000!important">تفعيل إشعارات الهاتف</h2><p id="tnPushIntro" style="line-height:1.9;margin:0 0 20px;color:#000!important">هل تسمح لتوجيذر بإرسال إشعارات مهمة إليك حتى عندما يكون الموقع مغلقًا؟ سيظهر هذا الطلب مرة واحدة على هذا المتصفح.</p><div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button id="tnPushAllow" type="button" style="appearance:none;-webkit-appearance:none;border:0!important;border-radius:10px;background:#16a34a!important;background-color:#16a34a!important;background-image:none!important;color:#ffffff!important;padding:12px 22px;font-weight:700;cursor:pointer;box-shadow:none!important;opacity:1!important;filter:none!important">موافق، تفعيل الإشعارات</button><button id="tnPushLater" type="button" style="appearance:none;-webkit-appearance:none;border:0!important;border-radius:10px;background:#dc2626!important;background-color:#dc2626!important;background-image:none!important;color:#ffffff!important;padding:12px 22px;font-weight:700;cursor:pointer;box-shadow:none!important;opacity:1!important;filter:none!important">رفض الإشعارات</button></div><p id="tnPushDialogStatus" style="font-size:13px;color:#b42318;margin:12px 0 0" aria-live="polite"></p></div>';
 Object.assign(overlay.style,{position:"fixed",inset:"0",background:"#071426b8",zIndex:"2147483000",display:"flex",alignItems:"center",justifyContent:"center",padding:"18px"});
 document.body.appendChild(overlay);
 const msg=$("#tnPushDialogStatus"),allow=$("#tnPushAllow");
 if(unsupported){msg.textContent=unsupported;allow.textContent="حسنًا";allow.onclick=()=>{try{localStorage.setItem(key,"1")}catch{};overlay.remove()};}
 $("#tnPushLater").onclick=()=>{try{localStorage.setItem(key,"1")}catch{};overlay.remove()};
 if(!unsupported)allow.onclick=async()=>{
  allow.disabled=true;allow.textContent="جارٍ السماح…";msg.textContent="";
  try{
   const ok=await requestPermission();
   if(ok){try{localStorage.setItem(key,"1")}catch{};overlay.remove()}
   else{allow.disabled=false;allow.textContent="إعادة المحاولة";msg.textContent="أكمل السماح من نافذة المتصفح إذا ظهرت."}
  }catch(e){
   msg.textContent=e.message||"تعذر تفعيل الإشعارات.";
   allow.disabled=false;allow.textContent="إعادة المحاولة";
   if(Notification.permission==="denied"){try{localStorage.setItem(key,"1")}catch{}}
  }
 };
}
window.TogetherPush={ready:loadSdk,enable:requestPermission};
function launchPrompt(){showFirstVisitDialog().catch(e=>{try{status(e.message||"تعذر عرض رسالة الإشعارات.")}catch{}})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",launchPrompt,{once:true});else launchPrompt();
})();