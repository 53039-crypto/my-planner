const admin = require("firebase-admin");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON secret");
const serviceAccount = JSON.parse(raw);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();

const DAY_MAP = { Mon:"จันทร์", Tue:"อังคาร", Wed:"พุธ", Thu:"พฤหัสบดี", Fri:"ศุกร์", Sat:"เสาร์", Sun:"อาทิตย์" };
function parts(date=new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Bangkok",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date);
  const get=t=>p.find(x=>x.type===t)?.value;
  return {year:get("year"),month:get("month"),day:get("day"),weekday:get("weekday"),hour:get("hour"),minute:get("minute")};
}
function minutes(hm){ const [h,m]=hm.split(":").map(Number); return h*60+m; }
async function sendToUser(uid,title,body){
  const snap=await db.collection("users").doc(uid).collection("devices").get();
  const docs=snap.docs.filter(d=>d.data()?.token);
  if(!docs.length) return 0;
  let sent=0;
  for(let i=0;i<docs.length;i+=500){
    const group=docs.slice(i,i+500), tokens=group.map(d=>d.data().token);
    const r=await messaging.sendEachForMulticast({tokens,notification:{title,body},webpush:{notification:{title,body,requireInteraction:false},fcmOptions:{link:"https://my-planner-test.netlify.app/"}}});
    sent+=r.successCount;
    const bad=[];
    r.responses.forEach((x,j)=>{const c=x.error?.code||""; if(c==="messaging/registration-token-not-registered"||c==="messaging/invalid-registration-token") bad.push(group[j].ref.delete());});
    if(bad.length) await Promise.all(bad);
  }
  return sent;
}

(async()=>{
  const now=parts();
  const current=Number(now.hour)*60+Number(now.minute);
  const today=`${now.year}-${now.month}-${now.day}`;
  const day=DAY_MAP[now.weekday];
  // Look back 10 minutes so a delayed GitHub run doesn't miss a reminder.
  const minTime=Math.max(0,current-10);
  const maxTime=current;
  const snap=await db.collectionGroup("activities").where("enabled","==",true).get();
  let matched=0,sent=0;
  for(const d of snap.docs){
    const a=d.data(); if(!a || a.day!==day || typeof a.time!=="string") continue;
    const t=minutes(a.time); if(t<minTime || t>maxTime) continue;
    const userRef=d.ref.parent.parent; if(!userRef) continue;
    const key=`${today}_${a.time}`;
    if(a.lastNotifiedKey===key) continue;
    matched++;
    const n=await sendToUser(userRef.id,"My Planner 🔔",`${a.activity||"ถึงเวลากิจกรรมแล้ว"} · ${a.time}`);
    if(n>0){ await d.ref.update({lastNotifiedKey:key}); sent+=n; }
  }
  console.log(`Bangkok ${day} ${now.hour}:${now.minute} matched=${matched} sent=${sent}`);
})().catch(e=>{console.error(e);process.exit(1)});
