const admin = require("firebase-admin");

// ---------- 1) Load service account from GitHub Secret ----------
const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
if (!raw) {
  throw new Error(
    "Missing FIREBASE_SERVICE_ACCOUNT_JSON secret. " +
    "Check GitHub repo Settings > Secrets and variables > Actions > Repository secrets " +
    "and make sure the name matches exactly (all caps, no spaces)."
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (e) {
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT_JSON exists but is not valid JSON. " +
    "Make sure the whole file content (from { to }) was pasted, nothing cut off, and no extra quotes added around it."
  );
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();

// ---------- 2) Time helpers (Asia/Bangkok) ----------
const DAY_MAP = { Mon: "จันทร์", Tue: "อังคาร", Wed: "พุธ", Thu: "พฤหัสบดี", Fri: "ศุกร์", Sat: "เสาร์", Sun: "อาทิตย์" };

function parts(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return { year: get("year"), month: get("month"), day: get("day"), weekday: get("weekday"), hour: get("hour"), minute: get("minute") };
}

function minutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

// ---------- 3) Send push to every device of one user ----------
async function sendToUser(uid, title, body) {
  const snap = await db.collection("users").doc(uid).collection("devices").get();
  const docs = snap.docs.filter((d) => d.data()?.token);
  if (!docs.length) return 0;

  let sent = 0;
  for (let i = 0; i < docs.length; i += 500) {
    const group = docs.slice(i, i + 500);
    const tokens = group.map((d) => d.data().token);
    const r = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: {
        notification: { title, body, requireInteraction: false },
        fcmOptions: { link: "https://my-planner-test.netlify.app/" },
      },
    });
    sent += r.successCount;

    const cleanup = [];
    r.responses.forEach((x, j) => {
      const code = x.error?.code || "";
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        cleanup.push(group[j].ref.delete());
      }
    });
    if (cleanup.length) await Promise.all(cleanup);
  }
  return sent;
}

// ---------- 4) Main ----------
(async () => {
  const now = parts();
  const current = Number(now.hour) * 60 + Number(now.minute);
  const today = `${now.year}-${now.month}-${now.day}`;
  const day = DAY_MAP[now.weekday];

  // Look back 10 minutes so a delayed GitHub Actions run doesn't miss a reminder.
  const minTime = Math.max(0, current - 10);
  const maxTime = current;

  let snap;
  try {
    snap = await db.collectionGroup("activities").where("enabled", "==", true).get();
  } catch (e) {
    if (String(e.message || "").includes("index")) {
      console.error(
        "Firestore needs a Collection Group index for 'activities' on field 'enabled'.\n" +
        "Open Firebase Console > Firestore Database > Indexes > Single field, " +
        "find 'activities' / 'enabled', and set Query scope to 'Collection group'.\n" +
        "The original error message below usually also contains a direct link to create it:"
      );
    }
    throw e;
  }

  let matched = 0, sent = 0;
  for (const d of snap.docs) {
    const a = d.data();
    if (!a || a.day !== day || typeof a.time !== "string") continue;

    const t = minutes(a.time);
    if (t < minTime || t > maxTime) continue;

    const userRef = d.ref.parent.parent;
    if (!userRef) continue;

    const key = `${today}_${a.time}`;
    if (a.lastNotifiedKey === key) continue;

    matched++;
    const n = await sendToUser(userRef.id, "My Planner 🔔", `${a.activity || "ถึงเวลากิจกรรมแล้ว"} · ${a.time}`);
    if (n > 0) {
      await d.ref.update({ lastNotifiedKey: key });
      sent += n;
    }
  }

  console.log(`Bangkok ${day} ${now.hour}:${now.minute} matched=${matched} sent=${sent}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
