# KINTENSHAUTO · 剣天照

**เครื่องมือโพสต์ Reel อัตโนมัติสำหรับ Facebook**

![Version](https://img.shields.io/badge/version-1.0.0-d4af37) ![Platform](https://img.shields.io/badge/platform-Windows%20|%20Mac%20|%20Linux-a23b3b)

---

## 📖 เอกสาร

- 📘 **[INSTALLATION.md](./INSTALLATION.md)** — คู่มือติดตั้งสำหรับผู้ใช้ (ภาษาไทย)
- 🛠 **[BUILD.md](./BUILD.md)** — คู่มือ build installer สำหรับ developer

---

## ✨ คุณสมบัติหลัก

| หัวข้อ | รายละเอียด |
|--------|------------|
| 🎬 **Scout + Download** | ค้นและดาวน์โหลดคลิปจาก bilibili / YouTube อัตโนมัติ |
| ✂️ **Smart Clipping** | ตัดคลิปยาวเป็นคลิปสั้น พร้อมสร้าง 2 version (Set 1 / Set 2) |
| 🎨 **Banner Layers** | ซ้อนแบนเนอร์ได้ไม่จำกัด พร้อม z-index, opacity, timing |
| ✦ **AI Caption** | รองรับ OpenAI / Claude / Gemini — เลือกได้ตามต้องการ |
| 💬 **Auto Comment** | คอมเม้นอัตโนมัติหลังโพสต์ ด้วย template engine |
| ⚠ **Copyright Shield** | ตรวจลิขสิทธิ์ + แจ้งเตือน + ปุ่มใช้ Set 2 เมื่อติด |
| 🛡 **Anti-Detect** | 1 เฟส = 1 Chrome, proxy แยก, warm-up session, human-like delays |
| 🎐 **Samurai UI** | ธีมซามูไร พื้นหลังเคลื่อนไหว ฟอนต์ไทย-ญี่ปุ่น |

---

## 🏛 สถาปัตยกรรม

```
┌─────────────────────────────────────────────────────┐
│  Electron Main Process (main.js)                    │
│  ├─ Splash screen                                    │
│  ├─ First-run detection                              │
│  ├─ IPC handlers (deps, update, paths)               │
│  └─ System tray + auto-updater                       │
└──────────────┬──────────────────┬───────────────────┘
               │                  │
   ┌───────────▼─────────┐  ┌─────▼────────────────┐
   │  React Frontend     │  │  Express Backend     │
   │  (Vite + Samurai)   │  │  (port 3003)         │
   │  ├─ Setup Wizard    │  │  ├─ REST API         │
   │  ├─ Dashboard       │◄─┼─►├─ Socket.IO        │
   │  ├─ Managers        │  │  └─ Services         │
   │  └─ Queue UI        │  │      ├─ AI           │
   └─────────────────────┘  │      ├─ Banner       │
                            │      ├─ Copyright    │
                            │      ├─ Session      │
                            │      └─ Comment      │
                            └──┬───────────────────┘
                               │
                   ┌───────────┼────────────┐
                   │           │            │
           ┌───────▼──┐  ┌─────▼─────┐  ┌──▼────────┐
           │ SQLite   │  │ FFmpeg    │  │ yt-dlp    │
           │ (15 tbl) │  │ (overlays)│  │ (download)│
           └──────────┘  └───────────┘  └───────────┘
                   │
           ┌───────▼──────┐
           │ Puppeteer    │
           │ (1 Chrome    │
           │  per profile)│
           └──────────────┘
```

---

## 🎯 Pipeline 8 ด่าน

```
1. Scout       → ค้นคลิปจาก bilibili ด้วย keyword
2. Download    → yt-dlp ดาวน์โหลดคลิปเต็ม
3. Slice       → FFmpeg ตัดเป็น 3-5 คลิปสั้น
4. Banner      → ซ้อนแบนเนอร์ (unlimited layers)
5. Dual Set    → สร้าง Set 1 (ปกติ) + Set 2 (mirror + pitch shift)
6. Caption     → AI สร้างแคปชั่น
7. Warm-up     → เปิด FB scroll feed 60-120 วิ
8. Post        → โพสต์ใน reels_composer
9. Monitor     → เช็คลิขสิทธิ์ 30-60 วิหลังโพสต์
10. Comment    → คอมเม้นอัตโนมัติตาม template
```

---

## 🚀 Quick Start (Developer)

```bash
# 1. Clone
git clone <repo> && cd kintenshauto

# 2. Install
npm install

# 3. Dev mode
npm run dev      # Terminal 1 — Vite
npm start        # Terminal 2 — Electron

# 4. Build installer
npm run dist:win    # หรือ dist:mac, dist:linux
```

---

## 🔐 ความปลอดภัย

- ✅ API keys + FB passwords encrypted (AES-256-CBC)
- ✅ Chrome profile แยกต่อเฟส (ไม่ปนกัน)
- ✅ ไม่มี telemetry / analytics
- ✅ ทุกข้อมูลเก็บใน local DB ของเครื่อง user
- ✅ Checkpoint / captcha → หยุดและให้ user ยืนยันเอง

---

## ⚖ License & Disclaimer

โปรแกรมนี้ใช้ browser automation ผู้ใช้ต้อง:
- ทำตาม Facebook Terms of Service
- เคารพลิขสิทธิ์เนื้อหา
- ใช้เฉพาะ account ของตนเอง

**ผู้พัฒนาไม่รับผิดชอบ**การแบน account หรือความเสียหายจากการใช้งาน

---

## 🙏 Credits

- **FFmpeg** — video processing
- **yt-dlp** — video downloader
- **Chromaprint (fpcalc)** — audio fingerprinting
- **Electron** — desktop app framework
- **Puppeteer** — browser automation
- ฟอนต์: **Sarabun**, **Noto Serif JP**, **Yuji Syuku** (Google Fonts)

---

**剣天照 · KINTENSHAUTO** — _"ดาบแห่งเทพสุริยา"_
