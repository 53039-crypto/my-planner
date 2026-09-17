import {initializeApp} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {getAuth,createUserWithEmailAndPassword,signInWithEmailAndPassword,sendPasswordResetEmail,signOut,onAuthStateChanged,updateProfile} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {getFirestore,collection,addDoc,query,orderBy,onSnapshot,deleteDoc,doc,serverTimestamp,setDoc} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import {getMessaging,getToken,isSupported,onMessage} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js";
import {firebaseConfig,vapidKey} from "./firebase-config.js";

const app=initializeApp(firebaseConfig);
const auth=getAuth(app);
const db=getFirestore(app);
let unsub=null;
let messaging=null;

const $=x=>document.getElementById(x);
const say=(x,id="authMsg")=>$(id).textContent=x;

async function deviceIdForToken(token){
  const data=new TextEncoder().encode(token);
  const hash=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function ensureMessaging(){
  if(!("Notification" in window)) throw Error("เบราว์เซอร์ไม่รองรับการแจ้งเตือน");
  const p=await Notification.requestPermission();
  if(p!=="granted") throw Error("ยังไม่ได้อนุญาตการแจ้งเตือน");
  if(!(await isSupported())) throw Error("อุปกรณ์นี้ไม่รองรับ Firebase Push");
  messaging=getMessaging(app);
  const r=await navigator.serviceWorker.register("./firebase-messaging-sw.js");
  const token=await getToken(messaging,{vapidKey,serviceWorkerRegistration:r});
  if(!token) throw Error("ยังไม่ได้ตั้ง VAPID Key");
  const u=auth.currentUser;
  if(!u) throw Error("กรุณาเข้าสู่ระบบก่อน");
  const deviceId=await deviceIdForToken(token);
  await setDoc(doc(db,"users",u.uid,"devices",deviceId),{token,updatedAt:serverTimestamp(),userAgent:navigator.userAgent},{merge:true});
  try{
    onMessage(messaging,(payload)=>{
      const title=payload.notification?.title||"My Planner";
      const body=payload.notification?.body||"มีการแจ้งเตือนใหม่";
      new Notification(title,{body});
    });
  }catch{}
  return token;
}

$("signup").onclick=async()=>{try{let n=$("name").value.trim(),e=$("email").value.trim(),p=$("password").value;if(!n||!e||!p)throw Error("กรอกข้อมูลให้ครบ");let c=await createUserWithEmailAndPassword(auth,e,p);await updateProfile(c.user,{displayName:n});await setDoc(doc(db,"users",c.user.uid),{name:n,email:e,createdAt:serverTimestamp()},{merge:true});say("สมัครสมาชิกสำเร็จ")}catch(e){say(e.message)}};
$("login").onclick=async()=>{try{await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value);say("เข้าสู่ระบบแล้ว")}catch(e){say(e.message)}};
$("reset").onclick=async()=>{try{await sendPasswordResetEmail(auth,$("email").value.trim());say("ส่งอีเมลแล้ว")}catch(e){say(e.message)}};
$("logout").onclick=()=>signOut(auth);

$("save").onclick=async()=>{
  try{
    let u=auth.currentUser,t=$("time").value,a=$("activity").value.trim();
    if(!u)return say("กรุณาเข้าสู่ระบบ","msg");
    if(!t||!a)return say("กรอกเวลาและกิจกรรม","msg");
    const enabled=$("enabled").checked;
    const ref=await addDoc(collection(db,"users",u.uid,"activities"),{day:$("day").value,time:t,activity:a,enabled,lastNotifiedKey:null,createdAt:serverTimestamp()});
    $("activity").value="";
    say(`บันทึกแล้ว (${enabled?"เปิดเตือน":"ไม่เตือน"})` ,"msg");
  }catch(e){say(e.message||"บันทึกไม่สำเร็จ","msg")}
};

function esc(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function load(u){
  if(unsub)unsub();
  let q=query(collection(db,"users",u.uid,"activities"),orderBy("time"));
  unsub=onSnapshot(q,s=>{
    $("list").innerHTML="";
    s.forEach(x=>{
      let d=x.data(),el=document.createElement("div");
      el.className="activity";
      el.innerHTML=`<b>${d.day}</b> · ${d.time} ${d.enabled!==false?"🔔":"🔕"}<br>${esc(d.activity)}<br><button class="secondary">ลบ</button>`;
      el.querySelector("button").onclick=()=>deleteDoc(doc(db,"users",u.uid,"activities",x.id));
      $("list").appendChild(el)
    })
  })
}

$("notify").onclick=async()=>{try{await ensureMessaging();say("ลงทะเบียนแจ้งเตือนเครื่องนี้แล้ว","msg")}catch(e){say(e.message,"msg")}};
$("testNotify").onclick=async()=>{
  try{
    await ensureMessaging();
    say("ลงทะเบียนเครื่องนี้แล้ว — การทดสอบการเด้งจริงทำจาก GitHub Actions หลังตั้งค่าระบบส่งแล้ว","msg");
  }catch(e){say(e?.message||"ลงทะเบียนแจ้งเตือนไม่สำเร็จ","msg")}
};

onAuthStateChanged(auth,u=>{
  if(u){
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("userName").textContent=u.displayName||u.email;
    load(u)
  }else{
    $("auth").classList.remove("hidden");
    $("app").classList.add("hidden")
  }
});
