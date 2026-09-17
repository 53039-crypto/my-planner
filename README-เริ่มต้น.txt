MY PLANNER V4 — ฟรี ไม่ใช้ Firebase Blaze

โครงสร้างนี้ใช้ Firebase สำหรับ Login/Firestore/FCM และใช้ GitHub Actions เป็นตัวตรวจเวลาแทน Cloud Functions

ขั้นตอน:
1) อัปโหลดโฟลเดอร์ site/ ขึ้น Netlify แทนไฟล์เว็บเดิม
2) สร้าง GitHub repository ใหม่ (แนะนำ Public เพื่อไม่เสียค่า Actions สำหรับงานนี้)
3) อัปโหลดโฟลเดอร์ github-sender/ และ .github/workflows/send-reminders.yml
4) ใน Firebase Console สร้าง Service Account key (JSON) จาก Project settings > Service accounts > Generate new private key
5) ใน GitHub repo ไป Settings > Secrets and variables > Actions > New repository secret
   Name: FIREBASE_SERVICE_ACCOUNT_JSON
   Value: วางเนื้อหา JSON ทั้งก้อน
   ห้ามส่ง JSON นี้ให้ใครหรือใส่ในเว็บ/Netlify
6) Actions > My Planner reminders > Run workflow เพื่อทดสอบทันที
7) Schedule จะตรวจทุก 5 นาที และดูย้อนหลัง 10 นาทีเพื่อช่วยลดโอกาสพลาดจากการหน่วงของ GitHub

หมายเหตุ: GitHub Actions schedule อาจเริ่มช้ากว่าเวลาที่กำหนดได้ จึงไม่รับประกันเด้งตรงวินาที และอาจคลาดเคลื่อนหลายนาที
