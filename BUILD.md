# BUILD GUIDE · คู่มือ build installer

> สำหรับ developer ที่จะสร้างไฟล์ติดตั้ง `.exe` / `.dmg` / `.AppImage` เพื่อแจกจ่าย

---

## 🛠 สิ่งที่ต้องติดตั้งก่อน

1. **Node.js 18+** — https://nodejs.org
2. **Git** — https://git-scm.com
3. **Python 3** (สำหรับ native modules) — Windows จะต้องมี Build Tools:
   ```bash
   npm install --global windows-build-tools
   ```

### สำหรับ Windows
- ติดตั้ง Visual Studio Build Tools (รุ่น Desktop development with C++)
- หรือ: `npm install --global windows-build-tools` (admin)

### สำหรับ Mac
- ติดตั้ง Xcode Command Line Tools: `xcode-select --install`

### สำหรับ Linux
```bash
sudo apt install build-essential libgconf-2-4
```

---

## 🚀 ขั้นตอน build

### 1. Clone / download โปรเจกต์

```bash
git clone <repo-url> kintenshauto
cd kintenshauto
```

### 2. ติดตั้ง dependencies

```bash
npm install
```

Script `postinstall` จะดาวน์โหลด FFmpeg, yt-dlp, fpcalc ให้อัตโนมัติ
(ถ้าล้มเหลว ข้ามได้: `SKIP_POSTINSTALL=1 npm install`)

### 3. ทดสอบ dev

```bash
# Terminal 1: Vite dev server
npm run dev

# Terminal 2: Electron
npm start
```

เปิดโปรแกรมแล้วต้องเห็น Setup Wizard

### 4. Build installer

#### Windows (.exe)
```bash
npm run dist:win
```
ไฟล์ออกที่: `dist-installer/KINTENSHAUTO-Setup-1.0.0.exe`

#### Mac (.dmg)
```bash
npm run dist:mac
```
ไฟล์ออกที่: `dist-installer/KINTENSHAUTO-1.0.0.dmg`

#### Linux (.AppImage)
```bash
npm run dist:linux
```

#### ทุก platform (ต้อง build บนเครื่องนั้น ๆ)
```bash
npm run dist
```

---

## 📦 ขนาดไฟล์ติดตั้ง (ประมาณ)

| Platform | Installer size | หลังติดตั้ง |
|----------|---------------|-------------|
| Windows | ~180 MB | ~550 MB |
| Mac | ~200 MB | ~600 MB |
| Linux | ~170 MB | ~500 MB |

ส่วนใหญ่เป็น Electron runtime + FFmpeg + yt-dlp

---

## 🎨 ตั้งค่าก่อน build (สำคัญ!)

### 1. ใส่ไอคอน
วางไฟล์ที่ `assets/`:
- `icon.ico` — Windows (256x256)
- `icon.icns` — Mac
- `icon.png` — Linux (512x512)
- `tray-icon.png` — system tray (16x16 หรือ 32x32)

ไม่มีไฟล์เหล่านี้ก็ build ได้ แต่จะใช้ไอคอนเริ่มต้นของ Electron

### 2. Code signing (แนะนำ — ลด false-positive ของ antivirus)

#### Windows (EV Code Signing Certificate)
```json
"build": {
  "win": {
    "certificateFile": "path/to/cert.pfx",
    "certificatePassword": "..."
  }
}
```

ไม่ sign ก็ใช้ได้ แต่ user จะเห็นคำเตือน "Windows protected your PC" ครั้งแรก

#### Mac (Apple Developer ID)
```bash
export APPLE_ID="you@example.com"
export APPLE_ID_PASSWORD="app-specific-password"
npm run dist:mac
```

### 3. Auto-update server

แก้ `package.json`:
```json
"build": {
  "publish": [
    { "provider": "generic", "url": "https://your-server.com/releases/" }
  ]
}
```

จากนั้น upload `dist-installer/*` ไปไว้บน server
ไฟล์ `latest.yml` จำเป็นสำหรับ auto-update

---

## 📁 โครงสร้างโปรเจกต์

```
kintenshauto/
├── package.json              # Electron builder config
├── vite.config.js            # Frontend build config
├── index.html                # Vite entry
├── schema.sql                # Database schema
│
├── electron/
│   ├── main.js               # Electron main process
│   ├── preload.js            # IPC bridge
│   └── splash.html           # Loading screen
│
├── scripts/
│   ├── check-dependencies.js # ตรวจ FFmpeg/yt-dlp/Chrome
│   └── download-deps.js      # ดาวน์โหลด dependencies
│
├── src/
│   ├── main.jsx              # React entry
│   ├── App.jsx               # Top-level (first-run routing)
│   ├── Dashboard.jsx         # หน้าหลัก
│   │
│   ├── theme/
│   │   └── samurai.css       # Theme CSS + fonts
│   │
│   ├── components/
│   │   └── SamuraiBackground.jsx  # พื้นหลังเคลื่อนไหว
│   │
│   ├── setup-wizard/
│   │   └── SetupWizard.jsx   # 5-step wizard
│   │
│   └── backend/
│       ├── server.js         # Express API
│       └── services/
│           ├── captionService.js          # AI captions
│           ├── commentTemplateEngine.js   # Comment templates
│           ├── copyrightManager.js        # Copyright detection
│           ├── bannerLayerSystem.js       # Banner layers
│           └── sessionManager.js          # FB session cookies
│
├── assets/
│   ├── icon.ico / icon.icns / icon.png
│   └── tray-icon.png
│
├── bin/                      # Binaries (auto-downloaded)
│   ├── win32/                ├── darwin/                └── linux/
│   │   ├── ffmpeg.exe        │   ├── ffmpeg            │   ├── ffmpeg
│   │   ├── yt-dlp.exe        │   ├── yt-dlp            │   ├── yt-dlp
│   │   └── fpcalc.exe        │   └── fpcalc            │   └── fpcalc
│
├── dist/                     # Vite build output (สร้างตอน build-frontend)
└── dist-installer/           # Final installers (สร้างตอน dist)
```

---

## 🧪 ทดสอบก่อนแจก

### 1. ทดสอบ fresh install
```bash
# ลบ user data ที่เก่า
rm -rf ~/.config/KINTENSHAUTO      # Linux
# หรือ Windows: ลบ %APPDATA%\KINTENSHAUTO

# รันจาก installer
./dist-installer/KINTENSHAUTO-Setup-1.0.0.exe
```

**ต้องเห็น**:
- Splash screen (剣天照) 1-2 วินาที
- Setup Wizard 5 ขั้นตอน
- Dependency check ทำงานได้
- เข้า Dashboard ได้ พื้นหลังเคลื่อนไหว ซามูไรหายใจ ซากุระร่วง

### 2. ทดสอบบนเครื่องอื่น
- ส่ง installer ให้เพื่อน 1-2 คน
- สังเกต: FFmpeg ดาวน์โหลดสำเร็จไหม / Chrome เจอไหม

---

## 🐛 Troubleshooting (Developer)

### `better-sqlite3` build error
```bash
npm rebuild better-sqlite3
# หรือ
npm install --build-from-source better-sqlite3
```

### Electron build ช้ามาก
```bash
# ใช้ mirror ของ electron
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

### `puppeteer` ดาวน์โหลด Chromium ซ้ำ
```bash
# เราใช้ puppeteer-core (ไม่ดาวน์โหลด) — ถ้าใช้ puppeteer:
export PUPPETEER_SKIP_DOWNLOAD=true
```

### Vite v8 rolldown parser errors
```bash
# ตรึง Vite เป็น v5.4.19
npm install vite@5.4.19 --save-dev
```

---

## 📤 การ distribute

### แนะนำ
1. **GitHub Releases** — ฟรี, มี auto-update integration
2. **AWS S3 + CloudFront** — ถ้ามีคนดาวน์โหลดเยอะ
3. **Cloudflare R2** — เท่า S3 แต่ถูกกว่า

### ขั้นตอน
1. Build installer ทั้ง 3 platform (ต้อง build บนเครื่องนั้น ๆ)
2. Upload ไปยัง server
3. สร้าง `latest.yml`, `latest-mac.yml`, `latest-linux.yml` (electron-builder สร้างให้)
4. แชร์ลิงก์ให้ user
5. ใช้ **INSTALLATION.md** เป็นคู่มือให้ user

---

## 🔄 Auto-update workflow

เมื่อปล่อย version ใหม่:
1. แก้ `version` ใน `package.json` เป็นเวอร์ชันใหม่
2. `npm run dist:win` (หรือ platform อื่น)
3. Upload ไฟล์ใหม่ทับเก่าบน update server
4. User ที่เปิดโปรแกรมจะได้ notification อัตโนมัติภายใน 5 วินาที

---

**ดูเอกสารเพิ่มเติม**:
- Electron Builder: https://www.electron.build/
- Electron Auto-Update: https://www.electron.build/auto-update
