import {initializeApp} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {getAuth,createUserWithEmailAndPassword,signInWithEmailAndPassword,sendPasswordResetEmail,signOut,onAuthStateChanged,updateProfile} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {getFirestore,collection,addDoc,query,orderBy,onSnapshot,deleteDoc,doc,serverTimestamp,setDoc,getDocs} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {getMessaging,getToken,isSupported,onMessage} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js";
import {firebaseConfig,vapidKey} from "./firebase-config.js";

const app=initializeApp(firebaseConfig);
const auth=getAuth(app);
const db=getFirestore(app);
let unsub=null;
let messaging=null;
let swRegistration=null;
let foregroundHandlerInstalled=false;

const $=x=>document.getElementById(x);
const say=(x,id="authMsg")=>$(id).textContent=x;

async function registerMessagingWorker(){
  if(!("serviceWorker" in navigator)) throw Error("Chrome เครื่องนี้ไม่รองรับ Service Worker");
  if(swRegistration) return swRegistration;
  swRegistration=await navigator.serviceWorker.register("./firebase-messaging-sw.js",{scope:"./"});
  await navigator.serviceWorker.ready;
  return swRegistration;
}

async function deviceIdForToken(token){
  const data=new TextEncoder().encode(token);
  const hash=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function removeDuplicateTokenDocs(uid,token,keepId){
  const snap=await getDocs(collection(db,"users",uid,"devices"));
  const jobs=[];
  snap.forEach(d=>{
    if(d.id!==keepId && d.data()?.token===token) jobs.push(deleteDoc(d.ref));
  });
  if(jobs.length) await Promise.all(jobs);
}

async function ensureNotificationPermission(){
  if(!window.isSecureContext) throw Error("การแจ้งเตือนต้องเปิดผ่าน HTTPS");
  if(!("Notification" in window)) throw Error("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");

  if(Notification.permission==="denied"){
    throw Error("Chrome บล็อกการแจ้งเตือนเว็บนี้อยู่ ให้เปิดเมนูเว็บไซต์ > สิทธิ์/Permissions > การแจ้งเตือน/Notifications > อนุญาต/Allow แล้วกลับมากดอีกครั้ง");
  }

  if(Notification.permission!=="granted"){
    const permission=await Notification.requestPermission();
    if(permission==="denied"){
      throw Error("การแจ้งเตือนถูกบล็อก ให้เปิดเมนูเว็บไซต์ > สิทธิ์/Permissions > การแจ้งเตือน/Notifications > อนุญาต/Allow");
    }
    if(permission!=="granted") throw Error("ยังไม่ได้อนุญาตการแจ้งเตือน");
  }
}

async function ensureMessaging(){
  const u=auth.currentUser;
  if(!u) throw Error("กรุณาเข้าสู่ระบบก่อน");
  if(!(await isSupported())) throw Error("Chrome เครื่องนี้ไม่รองรับ Firebase Push");

  await ensureNotificationPermission();

  const registration=await registerMessagingWorker();
  messaging=getMessaging(app);
  const token=await getToken(messaging,{vapidKey,serviceWorkerRegistration:registration});
  if(!token) throw Error("สร้าง FCM token ไม่สำเร็จ กรุณาลองใหม่");

  const deviceId=await deviceIdForToken(token);
  await setDoc(doc(db,"users",u.uid,"devices",deviceId),{
    token,
    updatedAt:serverTimestamp(),
    userAgent:navigator.userAgent
  },{merge:true});
  await removeDuplicateTokenDocs(u.uid,token,deviceId);

  if(!foregroundHandlerInstalled){
    foregroundHandlerInstalled=true;
    onMessage(messaging,async(payload)=>{
      const title=payload.notification?.title||"My Planner";
      const body=payload.notification?.body||"มีการแจ้งเตือนใหม่";
      try{
        const r=await registerMessagingWorker();
        await r.showNotification(title,{body,tag:payload.messageId||"my-planner"});
      }catch(e){
        console.error("Foreground notification failed",e);
      }
    });
  }

  return registration;
}

$("signup").onclick=async()=>{try{let n=$("name").value.trim(),e=$("email").value.trim(),p=$("password").value;if(!n||!e||!p)throw Error("กรอกข้อมูลให้ครบ");let c=await createUserWithEmailAndPassword(auth,e,p);await updateProfile(c.user,{displayName:n});await setDoc(doc(db,"users",c.user.uid),{name:n,email:e,createdAt:serverTimestamp()},{merge:true});say("สมัครสมาชิกสำเร็จ")}catch(e){say(e.message)}};
$("login").onclick=async()=>{try{await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value);say("เข้าสู่ระบบแล้ว")}catch(e){say(e.message)}};
$("reset").onclick=async()=>{try{await sendPasswordResetEmail(auth,$("email").value.trim());say("ส่งอีเมลแล้ว")}catch(e){say(e.message)}};
$("logout").onclick=()=>signOut(auth);

$("save").onclick=async()=>{
  try{
    const u=auth.currentUser,t=$("time").value,a=$("activity").value.trim();
    if(!u)return say("กรุณาเข้าสู่ระบบ","msg");
    if(!t||!a)return say("กรอกเวลาและกิจกรรม","msg");
    const enabled=$("enabled").checked;
    await addDoc(collection(db,"users",u.uid,"activities"),{day:$("day").value,time:t,activity:a,enabled,lastNotifiedKey:null,createdAt:serverTimestamp()});
    $("activity").value="";
    say(`บันทึกแล้ว (${enabled?"เปิดเตือน":"ไม่เตือน"})`,"msg");
  }catch(e){say(e.message||"บันทึกไม่สำเร็จ","msg")}
};

function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function load(u){
  if(unsub)unsub();
  const q=query(collection(db,"users",u.uid,"activities"),orderBy("time"));
  unsub=onSnapshot(q,s=>{
    $("list").innerHTML="";
    s.forEach(x=>{
      const d=x.data(),el=document.createElement("div");
      el.className="activity";
      el.innerHTML=`<b>${esc(d.day)}</b> · ${esc(d.time)} ${d.enabled!==false?"🔔":"🔕"}<br>${esc(d.activity)}<br><button class="secondary">ลบ</button>`;
      el.querySelector("button").onclick=()=>deleteDoc(doc(db,"users",u.uid,"activities",x.id));
      $("list").appendChild(el);
    });
  });
}

$("notify").onclick=async()=>{
  try{
    await ensureMessaging();
    say("✅ เปิดการแจ้งเตือนให้มือถือเครื่องนี้แล้ว ปิดหน้าเว็บได้ ระบบยังส่ง Web Push ได้","msg");
  }catch(e){say(`❌ ${e?.message||"เปิดการแจ้งเตือนไม่สำเร็จ"}`,"msg")}
};

$("testNotify").onclick=async()=>{
  try{
    const registration=await ensureMessaging();
    await registration.showNotification("My Planner 🔔",{body:"ทดสอบสำเร็จ เว็บนี้ส่งการแจ้งเตือนได้แล้ว",tag:"my-planner-local-test"});
    say("✅ ส่งการแจ้งเตือนทดสอบบนมือถือเครื่องนี้แล้ว","msg");
  }catch(e){say(`❌ ${e?.message||"ทดสอบแจ้งเตือนไม่สำเร็จ"}`,"msg")}
};

onAuthStateChanged(auth,u=>{
  if(u){
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("userName").textContent=u.displayName||u.email;
    load(u);
    if("Notification" in window){
      if(Notification.permission==="granted") say("✅ Chrome อนุญาตการแจ้งเตือนแล้ว","msg");
      else if(Notification.permission==="denied") say("⚠️ Chrome บล็อกการแจ้งเตือนเว็บนี้อยู่ กรุณาเปิดสิทธิ์ Notifications ของเว็บไซต์","msg");
      else say("กด “🔔 เปิดการแจ้งเตือนบนมือถือเครื่องนี้” เพื่ออนุญาต Web Push","msg");
    }
  }else{
    $("auth").classList.remove("hidden");
    $("app").classList.add("hidden");
  }
});
