const admin = require("firebase-admin");

// ---------- 1) Firebase Admin ----------
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

// workflow_dispatch exists only when Run workflow is pressed manually.
const manualTest = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

// ---------- 2) Bangkok time ----------
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

function minutes(hm) {
  if (!/^\d{1,2}:\d{2}$/.test(hm || "")) return NaN;
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function maskToken(token) {
  if (!token) return "(empty)";
  return token.length > 18 ? `${token.slice(0, 8)}...${token.slice(-6)}` : "(token present)";
}

// ---------- 3) Send push to devices ----------
async function sendToUser(uid, title, body) {
  const snap = await db.collection("users").doc(uid).collection("devices").get();
  const deviceDocs = snap.docs.filter((d) => typeof d.data()?.token === "string" && d.data().token.trim());

  console.log(`[FCM] user=${uid} deviceDocs=${snap.size} validTokens=${deviceDocs.length}`);
  if (!deviceDocs.length) {
    console.warn(`[FCM] NO TOKEN for user=${uid}. Open the PWA on Android, allow notifications, and make sure the token is saved under users/${uid}/devices.`);
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
        notification: {
          title,
          body,
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          requireInteraction: false,
        },
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
      ) {
        console.warn(`[FCM] deleting invalid device document ${group[j].ref.path}`);
        cleanup.push(group[j].ref.delete());
      }
    });

    if (cleanup.length) await Promise.all(cleanup);
  }

  return { success, failure };
}

// ---------- 4) Read users without Collection Group index ----------
async function getUsers() {
  const users = await db.collection("users").get();
  console.log(`[DB] users=${users.size}`);
  return users.docs;
}

// ---------- 5) Manual notification test ----------
async function runManualTest() {
  console.log("=== MANUAL FCM TEST ===");
  const users = await getUsers();

  let usersWithTokens = 0;
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    const result = await sendToUser(
      user.id,
      "My Planner 🔔",
      "ทดสอบการแจ้งเตือนสำเร็จจาก GitHub Actions"
    );
    if (result.success + result.failure > 0) usersWithTokens++;
    sent += result.success;
    failed += result.failure;
  }

  console.log(`=== TEST RESULT users=${users.length} usersWithTokens=${usersWithTokens} sent=${sent} failed=${failed} ===`);

  if (!users.length) console.warn("[TEST] Firestore collection 'users' is empty.");
  else if (!usersWithTokens) console.warn("[TEST] No FCM device tokens were found for any user.");
  else if (!sent) console.error("[TEST] Tokens were found, but FCM did not deliver any message successfully. Check FAILED lines above.");
  else console.log(`[TEST] FCM accepted ${sent} notification(s). Check the Android device now.`);
}

// ---------- 6) Scheduled reminders ----------
async function runScheduled() {
  const now = parts();
  const current = Number(now.hour) * 60 + Number(now.minute);
  const today = `${now.year}-${now.month}-${now.day}`;
  const day = DAY_MAP[now.weekday];
  const minTime = Math.max(0, current - 10);
  const maxTime = current;

  console.log(`=== SCHEDULED Bangkok ${day} ${now.hour}:${now.minute} window=${minTime}-${maxTime} ===`);

  const users = await getUsers();
  let activities = 0;
  let matched = 0;
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    const activitySnap = await user.ref.collection("activities").get();
    activities += activitySnap.size;

    for (const d of activitySnap.docs) {
      const a = d.data();
      if (!a || a.enabled !== true || a.day !== day || typeof a.time !== "string") continue;

      const t = minutes(a.time);
      if (!Number.isFinite(t) || t < minTime || t > maxTime) continue;

      const key = `${today}_${a.time}`;
      if (a.lastNotifiedKey === key) continue;

      matched++;
      console.log(`[MATCH] user=${user.id} activity=${a.activity || d.id} time=${a.time}`);

      const result = await sendToUser(
        user.id,
        "My Planner 🔔",
        `${a.activity || "ถึงเวลากิจกรรมแล้ว"} · ${a.time}`
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
