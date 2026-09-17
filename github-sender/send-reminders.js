const admin = require("firebase-admin");

const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON GitHub secret");

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (e) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();
const manualTest = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

const DAY_MAP = {
  Mon: "จันทร์", Tue: "อังคาร", Wed: "พุธ", Thu: "พฤหัสบดี",
  Fri: "ศุกร์", Sat: "เสาร์", Sun: "อาทิตย์",
};

function parts(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return {
    year: get("year"), month: get("month"), day: get("day"),
    weekday: get("weekday"), hour: get("hour"), minute: get("minute"),
  };
}

function normalizeDay(value) {
  return String(value || "")
    .trim()
    .replace(/^วัน/, "");
}

function normalizeTime(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function minutes(hm) {
  const n = normalizeTime(hm);
  if (!n) return NaN;
  const [h, m] = n.split(":").map(Number);
  return h * 60 + m;
}

function maskToken(token) {
  if (!token) return "(empty)";
  return token.length > 18 ? `${token.slice(0, 8)}...${token.slice(-6)}` : "(token present)";
}

async function sendToUser(uid, title, body) {
  const snap = await db.collection("users").doc(uid).collection("devices").get();
  const docsWithTokens = snap.docs.filter((d) => typeof d.data()?.token === "string" && d.data().token.trim());

  const uniqueByToken = new Map();
  const duplicateDocs = [];
  for (const d of docsWithTokens) {
    const token = d.data().token.trim();
    if (uniqueByToken.has(token)) duplicateDocs.push(d.ref.delete());
    else uniqueByToken.set(token, d);
  }
  if (duplicateDocs.length) {
    await Promise.all(duplicateDocs);
    console.log(`[FCM] removed duplicate device docs=${duplicateDocs.length} user=${uid}`);
  }

  const deviceDocs = [...uniqueByToken.values()];
  console.log(`[FCM] user=${uid} deviceDocs=${snap.size} uniqueTokens=${deviceDocs.length}`);
  if (!deviceDocs.length) {
    console.warn(`[FCM] NO TOKEN for user=${uid}. Open the website in Chrome, log in, and press the notification button.`);
    return { success: 0, failure: 0 };
  }

  let success = 0;
  let failure = 0;

  for (let i = 0; i < deviceDocs.length; i += 500) {
    const group = deviceDocs.slice(i, i + 500);
    const tokens = group.map((d) => d.data().token.trim());

    console.log(`[FCM] sending to ${tokens.length} token(s): ${tokens.map(maskToken).join(", ")}`);

    const r = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: {
        notification: { title, body, requireInteraction: false },
        fcmOptions: { link: "https://my-planner-test.netlify.app/" },
      },
    });

    success += r.successCount;
    failure += r.failureCount;
    console.log(`[FCM] result success=${r.successCount} failure=${r.failureCount}`);

    const cleanup = [];
    r.responses.forEach((response, j) => {
      if (response.success) {
        console.log(`[FCM] OK token=${maskToken(tokens[j])} messageId=${response.messageId || "(none)"}`);
        return;
      }

      const code = response.error?.code || "unknown";
      const message = response.error?.message || "Unknown FCM error";
      console.error(`[FCM] FAILED token=${maskToken(tokens[j])} code=${code} message=${message}`);

      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) cleanup.push(group[j].ref.delete());
    });

    if (cleanup.length) await Promise.all(cleanup);
  }

  return { success, failure };
}

async function getUsers() {
  const users = await db.collection("users").get();
  console.log(`[DB] users=${users.size}`);
  return users.docs;
}

async function runManualTest() {
  console.log("=== MANUAL WEB PUSH TEST ===");
  const users = await getUsers();
  let usersWithTokens = 0, sent = 0, failed = 0;

  for (const user of users) {
    const result = await sendToUser(user.id, "My Planner 🔔", "ทดสอบ Web Push สำเร็จจาก My Planner");
    if (result.success + result.failure > 0) usersWithTokens++;
    sent += result.success;
    failed += result.failure;
  }

  console.log(`=== TEST RESULT users=${users.length} usersWithTokens=${usersWithTokens} sent=${sent} failed=${failed} ===`);
}

async function runScheduled() {
  const now = parts();
  const current = Number(now.hour) * 60 + Number(now.minute);
  const today = `${now.year}-${now.month}-${now.day}`;
  const expectedDay = DAY_MAP[now.weekday];

  // GitHub scheduled workflows can be delayed. Look back 35 minutes so reminders are not missed.
  const LOOKBACK_MINUTES = 35;
  const minTime = Math.max(0, current - LOOKBACK_MINUTES);
  const maxTime = current;

  console.log(`=== SCHEDULED Bangkok ${expectedDay} ${now.hour}:${now.minute} window=${minTime}-${maxTime} lookback=${LOOKBACK_MINUTES}m ===`);

  const users = await getUsers();
  let activities = 0, matched = 0, sent = 0, failed = 0;

  for (const user of users) {
    const activitySnap = await user.ref.collection("activities").get();
    activities += activitySnap.size;

    for (const d of activitySnap.docs) {
      const a = d.data() || {};
      const activityDay = normalizeDay(a.day);
      const activityTime = normalizeTime(a.time);
      const enabled = a.enabled !== false; // old records without enabled are treated as enabled
      const t = minutes(activityTime);
      const key = activityTime ? `${today}_${activityTime}` : null;

      console.log(`[ACTIVITY] user=${user.id} id=${d.id} day=${JSON.stringify(a.day)} normalizedDay=${activityDay} time=${JSON.stringify(a.time)} normalizedTime=${activityTime} enabled=${a.enabled} effectiveEnabled=${enabled} lastNotifiedKey=${a.lastNotifiedKey || "(none)"}`);

      if (!enabled) {
        console.log(`[SKIP] ${d.id} reason=disabled`);
        continue;
      }
      if (activityDay !== expectedDay) {
        console.log(`[SKIP] ${d.id} reason=day expected=${expectedDay} actual=${activityDay}`);
        continue;
      }
      if (!activityTime || !Number.isFinite(t)) {
        console.log(`[SKIP] ${d.id} reason=invalid-time`);
        continue;
      }
      if (t < minTime || t > maxTime) {
        console.log(`[SKIP] ${d.id} reason=time activityMinutes=${t} window=${minTime}-${maxTime}`);
        continue;
      }
      if (a.lastNotifiedKey === key) {
        console.log(`[SKIP] ${d.id} reason=already-notified key=${key}`);
        continue;
      }

      matched++;
      console.log(`[MATCH] user=${user.id} activity=${a.activity || d.id} time=${activityTime}`);

      const result = await sendToUser(
        user.id,
        "My Planner 🔔",
        `${a.activity || "ถึงเวลากิจกรรมแล้ว"} · ${activityTime}`
      );

      sent += result.success;
      failed += result.failure;
      if (result.success > 0) await d.ref.update({ lastNotifiedKey: key });
    }
  }

  console.log(`=== RESULT users=${users.length} activities=${activities} matched=${matched} sent=${sent} failed=${failed} ===`);
}

(async () => {
  console.log(`[START] event=${process.env.GITHUB_EVENT_NAME || "unknown"} manualTest=${manualTest}`);
  if (manualTest) await runManualTest();
  else await runScheduled();
})().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
