# 🔄 วิธีการอัปเดต/แก้ปัญหา

> เนื่องจากผมไม่สามารถ push update ให้คุณอัตโนมัติได้
> นี่คือวิธีทำงานจริงที่ใช้ได้ผล

---

## 🎯 Flow การทำงาน

```
คุณเจอปัญหา / อยากเพิ่ม feature
      ↓
เปิดแชต Claude ใหม่ (หรือต่อแชตเดิม)
      ↓
อธิบายปัญหา + ส่ง error log / screenshot
      ↓
ผม (Claude) ส่งไฟล์ที่แก้แล้วให้
      ↓
คุณเอาไฟล์ไปวางทับในโฟลเดอร์
      ↓
Build ใหม่ (ดู BUILD_YOURSELF.md)
      ↓
แจกให้ user
```

---

## 📝 วิธีบอกปัญหาให้ผมเข้าใจเร็วที่สุด

เมื่อคุณมาหาผม ให้เตรียมข้อมูลนี้มา:

### 1. อธิบายสถานการณ์
- เกิดอะไรขึ้น? (เช่น "โปรแกรมเปิดไม่ขึ้น", "กดโพสต์แล้ว error")
- ตอนไหน? (เช่น "ตอน login FB", "ตอน build")
- เครื่องไหน? (Windows/Mac + version)

### 2. แนบ error log
- **ถ้าเป็นปัญหาตอน build**: copy ข้อความจาก `build-log.txt` มาให้
- **ถ้าเป็นปัญหาตอนใช้งาน**:
  - Windows: เปิด `%APPDATA%\KINTENSHAUTO\logs\`
  - Mac: `~/Library/Application Support/KINTENSHAUTO/logs/`
  - Copy เนื้อหาไฟล์ `backend.log` และ `app.log` มาให้

### 3. Screenshot (ถ้ามี)
- ช่วยให้ผมเห็นปัญหาจริง

### ตัวอย่างข้อความที่ดี:
```
Hi Claude — KINTENSHAUTO ผมใช้ตอน build บน Windows 11
เจอ error ตอน npm install:

gyp ERR! stack Error: Could not find any Python installation

นี่ log เต็ม: [paste log here]

ช่วยแก้ให้หน่อยครับ
```

---

## 📦 วิธีเอาไฟล์ใหม่ไปวางทับ

### กรณีผมส่งไฟล์เดียว
1. ดาวน์โหลดไฟล์จากแชต (กดที่ไฟล์ → Download)
2. เปิดโฟลเดอร์ `kintenshauto-full` ในเครื่อง
3. ไปยังโฟลเดอร์ย่อยที่ตรงกับ path ของไฟล์
   เช่น ถ้าไฟล์คือ `src/backend/server.js` → เข้า `kintenshauto-full\src\backend\`
4. ลากไฟล์ใหม่ไปวางทับไฟล์เก่า (เลือก "Replace")

### กรณีผมส่งหลายไฟล์
- ทำแบบเดียวกัน ทีละไฟล์
- หรือ copy ทั้งโฟลเดอร์ `kintenshauto-full` ใหม่ที่ผมส่งให้ไปทับของเก่า
  (⚠ **ยกเว้น**: `node_modules/`, `bin/`, `.setup-complete` — **อย่าลบ**)

### ไฟล์สำคัญที่ไม่ควรลบทิ้ง
เมื่ออัปเดต ถ้ามี folder เหล่านี้อยู่แล้ว **เก็บไว้ อย่าลบ**:
- `node_modules/` — ไม่งั้นต้อง `npm install` ใหม่ (30 นาที)
- `bin/` — binaries (FFmpeg, yt-dlp) ที่โหลดไว้แล้ว
- `dist-installer/` — installer เวอร์ชันเก่า (เก็บไว้ rollback)

---

## 🔨 Build ใหม่หลังอัปเดต

### Windows (local)
```bat
cd kintenshauto-full
build.bat
```
ครั้งนี้จะเร็วกว่ามาก (2-5 นาที) เพราะข้าม `npm install`

### GitHub Actions
1. เปิด GitHub Desktop
2. จะเห็น files ที่เปลี่ยนแปลง (สีเหลือง/เขียว)
3. ใส่ commit message เช่น `"Fix: X ตามที่ Claude ให้มา"`
4. กด **Commit to main** → **Push origin**
5. ไปที่ GitHub → Actions → Run workflow ใหม่

---

## 🎁 Auto-update ในตัวโปรแกรมเอง

ตอนนี้โปรแกรมมีระบบ auto-update อยู่แล้ว (`electron-updater`) **แต่**ต้องตั้งค่าเพิ่ม:

### ตั้งครั้งเดียว

**1. แก้ `package.json`** — ตั้ง URL ของ update server:
```json
"publish": [
  {
    "provider": "github",
    "owner": "YOUR_GITHUB_USERNAME",
    "repo": "kintenshauto"
  }
]
```

**2. ทุกครั้งที่ปล่อยเวอร์ชันใหม่**:
- แก้ `"version": "1.0.1"` ใน `package.json` (เพิ่มทีละขั้น)
- Commit + push ไป GitHub
- GitHub Desktop → Repository → **Create tag** → ตั้งชื่อ `v1.0.1`
- Push tag ขึ้นไป

**3. GitHub Actions จะ**:
- Build installer ใหม่
- สร้าง GitHub Release ให้อัตโนมัติ
- ใส่ไฟล์ `latest.yml` (ที่โปรแกรมใช้เช็คว่ามี update)

**4. ในมือของ user**:
- เปิดโปรแกรม → โปรแกรมเช็ค update อัตโนมัติ 5 วินาทีแรก
- ถ้าเจอเวอร์ชันใหม่ → notification แสดง
- user กด "Update" → โปรแกรมดาวน์โหลด + ติดตั้งทับ + restart

**→ user ไม่ต้องดาวน์โหลด .exe ใหม่เอง ไม่ต้องลบของเก่า**

---

## 🚨 กรณีฉุกเฉิน — โปรแกรมพังทั้งหมด

**ถ้า user บ่นว่าโปรแกรมเปิดไม่ขึ้น / ใช้ไม่ได้**:

### 1. Rollback ก่อน (เร็วสุด)
- ส่ง `.exe` เวอร์ชันก่อนหน้าให้ user ติดตั้งทับ
- โปรแกรม **จะไม่ลบข้อมูลเก่า** (DB, cookies, settings เก็บใน `%APPDATA%\KINTENSHAUTO\`)

### 2. ดึง log มาให้ผมดู
- บอก user เปิด `%APPDATA%\KINTENSHAUTO\logs\`
- ส่งไฟล์ `backend.log` + `app.log` มาให้
- ผมวิเคราะห์และส่ง patch ให้

### 3. User reinstall
- Uninstall โปรแกรม
- ติดตั้ง `.exe` ใหม่ (เวอร์ชันที่แก้แล้ว)
- **ข้อมูลเก่ายังอยู่** — ไม่ต้องตั้งค่าใหม่

---

## 💡 Best Practices

1. **ทดสอบก่อนแจก** — ทุกเวอร์ชันใหม่ ให้ test บนเครื่องตัวเอง 5-10 นาทีก่อน
2. **เก็บ installer ทุกเวอร์ชัน** — เผื่อต้อง rollback
3. **เริ่มจาก user 1-2 คนก่อน** — อย่าเพิ่งแจกทุกคน ถ้ายังไม่ stable
4. **เขียน CHANGELOG** — จด version history ให้ user เห็น (สร้างไฟล์ CHANGELOG.md)
5. **ใช้ semantic version** — v1.0.0 → v1.0.1 (bug fix) → v1.1.0 (feature ใหม่) → v2.0.0 (เปลี่ยนใหญ่)

---

## ❓ FAQ

**Q: ผมต้องรัน `npm install` ใหม่ทุกครั้งที่ได้ไฟล์จาก Claude ไหม?**
A: **ไม่** ยกเว้นผมบอกว่าเปลี่ยน `package.json` ด้วย

**Q: ต้อง build ใหม่ทุกครั้งไหม?**
A: **ใช่** — เพราะ installer เป็น snapshot ของ code ณ เวลานั้น

**Q: ระหว่างที่ผมอัปเดต user ที่เปิดโปรแกรมอยู่จะเป็นไง?**
A: โปรแกรมยังทำงานปกติจน user restart → ตอน restart จะเช็ค update

**Q: Auto-update ปลอดภัยไหม?**
A: ปลอดภัย ถ้าใช้ GitHub Releases (electron-updater จะตรวจ signature)
