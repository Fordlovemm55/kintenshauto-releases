# วิธีสร้างไฟล์ติดตั้ง (.exe) ด้วยตัวเอง

มี **3 วิธี** จากง่ายที่สุดไปหายากที่สุด เลือกตามความสะดวก:

---

## 🥇 วิธีที่ 1: GitHub Actions (แนะนำที่สุด — ฟรีและง่าย)

**เหมาะกับ**: คนที่ไม่อยากติดตั้ง dev tools บนเครื่องตัวเอง

**GitHub** จะ build ไฟล์ `.exe` ให้คุณบนเครื่อง Windows ของ GitHub ใช้เวลา 10-20 นาที คุณแค่รอ แล้วกดดาวน์โหลด

### ขั้นตอน (ครั้งแรก — ~15 นาที)

**1. สมัคร GitHub** (ถ้ายังไม่มี account)
- ไปที่ https://github.com/signup
- สมัครด้วย email (ฟรี)

**2. ติดตั้ง GitHub Desktop** (ง่ายกว่าคำสั่ง git)
- ดาวน์โหลดจาก https://desktop.github.com/
- ติดตั้งและ login

**3. สร้าง repository ใหม่**
- เปิด GitHub Desktop
- เมนู **File → New Repository**
- Name: `kintenshauto`
- Local path: เลือกโฟลเดอร์ที่มีโค้ดทั้งหมด (ที่ผมให้คุณ)
- **⚠ เลือก "Private"** เพื่อความปลอดภัย (อย่าเปิด public)
- กด "Create Repository"

**4. Push โค้ดขึ้น GitHub**
- ใน GitHub Desktop → กด "Publish repository"
- ติ๊ก "Keep this code private"
- กด "Publish Repository"
- รอสักครู่ (10-30 วินาที)

**5. Trigger build**
- ไปที่ **https://github.com/YOUR_USERNAME/kintenshauto**
- กดแทป **"Actions"** (ด้านบน)
- กด **"Build Installer"** (ซ้ายมือ)
- กด **"Run workflow"** (ขวามือ) → กด **"Run workflow"** อีกครั้ง
- รอ 10-20 นาที (ดูสถานะได้ที่หน้า Actions)

**6. ดาวน์โหลดไฟล์**
- เมื่อ build เสร็จ (✅ สีเขียว) กดเข้าไปดู
- ลงไปล่างสุดจะเห็น **"Artifacts"**
- กดที่ **"KINTENSHAUTO-Windows"** → จะดาวน์โหลด `.zip`
- แตก zip → จะได้ `KINTENSHAUTO-Setup-1.0.0.exe` 🎉

### ขั้นตอนครั้งต่อไป (ถ้ามีการแก้โค้ด)

ผมส่งไฟล์แก้ให้ → คุณเปลี่ยนไฟล์ใน GitHub Desktop → Push → GitHub build ใหม่ให้ ใช้เวลาแค่ 5 นาที

### ข้อดี
- ✅ ไม่ต้องติดตั้ง Node.js, Build Tools อะไรบนเครื่อง
- ✅ Build ได้ทั้ง Windows + Mac + Linux พร้อมกัน
- ✅ ฟรี (GitHub ให้ 2,000 นาที/เดือน — เหลือเฟือ)
- ✅ มี log ให้ดู error ถ้ามีปัญหา

---

## 🥈 วิธีที่ 2: Build ที่เครื่องตัวเอง (Windows)

**เหมาะกับ**: คนที่มี Windows อยู่แล้วและอยากควบคุมเอง

### ต้องติดตั้งก่อน (ครั้งเดียว)

**1. Node.js 18+**
- ดาวน์โหลดจาก https://nodejs.org/ (เลือก "LTS")
- ติดตั้งแบบ default — ตอนติดตั้งให้ **ติ๊ก "Automatically install necessary tools"**

**2. Visual Studio Build Tools** (สำหรับ better-sqlite3)
- ถ้าขั้นตอนที่ 1 ติ๊กไว้แล้ว ข้ามขั้นนี้ได้
- ถ้ายัง: ดาวน์โหลดจาก https://visualstudio.microsoft.com/visual-cpp-build-tools/
- ติดตั้ง → เลือก "Desktop development with C++"

### ขั้นตอน build

**ง่ายที่สุด** — ดับเบิลคลิก `build.bat`

หรือพิมพ์ใน Command Prompt:
```bat
cd C:\path\to\kintenshauto-full
build.bat
```

ใช้เวลา 15-45 นาที (ครั้งแรก) ระหว่างนั้นจะเห็น:
- [1/5] Checking Node.js
- [2/5] Checking npm
- [3/5] Checking project state
- [4/5] Installing dependencies (ช้าสุดตรงนี้)
- [5/5] Building installer

เสร็จแล้วไฟล์จะอยู่ที่ `dist-installer\KINTENSHAUTO-Setup-1.0.0.exe`

### ถ้าเจอ error

เปิดไฟล์ `build-log.txt` ในโฟลเดอร์เดียวกัน → copy error มาบอกผมในแชตใหม่ ผมจะช่วยแก้

---

## 🥉 วิธีที่ 3: Build บน Mac / Linux

**เหมาะกับ**: คุณหรือเพื่อนมี Mac / Linux

### Mac (สร้าง `.dmg`)
```bash
cd kintenshauto-full
chmod +x build.sh
./build.sh
```

### Linux (สร้าง `.AppImage`)
```bash
# ติดตั้ง deps ก่อน
sudo apt install nodejs npm libgtk-3-dev libnss3-dev

cd kintenshauto-full
chmod +x build.sh
./build.sh
```

⚠ **Mac ไม่สามารถ build ไฟล์ `.exe` Windows ได้** (ต้องใช้ Windows หรือ GitHub Actions)

---

## 🤔 ถ้าไม่เคยใช้ GitHub / Command Line เลย

**วิธีง่ายที่สุด** — หาคนที่ทำได้ช่วย:
1. ส่งโฟลเดอร์ `kintenshauto-full` ให้เพื่อน/น้อง/ช่างคอม
2. บอกเขาเปิดไฟล์ `build.bat` (บน Windows) หรือใช้ GitHub Actions (วิธีที่ 1)
3. ขอไฟล์ `.exe` กลับมา

เมื่อได้ `.exe` มาแล้ว คุณใช้ได้เหมือนกัน ไม่ต้องเข้าใจอะไรอีก

---

## 🔄 เมื่อมีการอัปเดต (ผมแก้ code ให้)

1. **บอกปัญหาในแชต**: ผมส่งไฟล์ที่แก้แล้วให้
2. **เอาไฟล์ไปวางทับ**: เปิดโฟลเดอร์ `kintenshauto-full` → แทนไฟล์เก่า
3. **Build ใหม่**:
   - วิธีที่ 1: Push ไป GitHub → กด Run workflow
   - วิธีที่ 2: ดับเบิลคลิก `build.bat` อีกครั้ง (จะเร็วขึ้นมากเพราะมี node_modules แล้ว)
4. **แจกไฟล์ใหม่** ให้ user

ถ้าใช้ GitHub + **ตั้งเป็น "version" (tag) เวอร์ชันใหม่** → **auto-update** ในโปรแกรมจะทำงานให้เอง user ไม่ต้องดาวน์โหลดใหม่!

---

## 💡 เคล็ดลับ

- **อย่าลบโฟลเดอร์ `node_modules`** หลัง build ครั้งแรก — การ build ครั้งต่อไปจะเร็วมาก (2-5 นาที)
- **โฟลเดอร์ `bin`** ก็อย่าลบ — ไม่ต้องโหลด FFmpeg ใหม่
- ถ้าโค้ดอัปเดตนิดเดียว แค่รัน `build.bat` อีกครั้ง มันเช็คให้ว่าติดตั้งไว้แล้ว
- เก็บไฟล์ `dist-installer\*.exe` ของแต่ละเวอร์ชันไว้ด้วย (v1.0.0, v1.0.1, ...) — เผื่อต้อง rollback
