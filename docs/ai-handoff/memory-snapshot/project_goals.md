---
name: project-goals
description: เป้าหมายหลักของ KINTENSHAUTO project — จัดระเบียบไฟล์ + zero bugs
metadata: 
  node_type: memory
  type: project
  originSessionId: bb88b3ff-311f-4e43-a220-ae303eeac8f4
---

User goal สำหรับ project นี้ (declared 2026-05-16):

1. **จัดระเบียบไฟล์** — ทำให้โครงสร้างโฟลเดอร์/ไฟล์เป็นระเบียบเรียบร้อย
2. **Zero bugs** — กำจัด bug ทุกตัวให้ระบบเสถียร

**Why:** User เพิ่งให้ Claude อ่านทุกไฟล์ในโปรเจกต์ (ทำ codebase priming) แล้วประกาศเป้าหมายนี้ — บอกว่าจะใช้ Claude ช่วยปรับปรุงคุณภาพและความเรียบร้อยของ codebase

**How to apply:**
- เมื่อแก้ไขหรือเพิ่มไฟล์ → คำนึงถึงโครงสร้างโดยรวม (ไฟล์ควรอยู่ใน folder ที่ถูกต้องตาม pattern เดิม — `src/backend/`, `src/backend/services/`, `electron/`, `scripts/`, `dist/assets/` ฯลฯ)
- เมื่อเจอ bug → fix ที่ root cause ไม่ใช่ patch ผิวเผิน
- ก่อน claim ว่า "เสร็จแล้ว" → verify ด้วย test/build จริง ไม่ใช่แค่อ่าน diff
- ทุก code edit → follow build/deploy workflow จาก HANDOFF-v2 (`taskkill` → `npx electron-builder --win --dir` → robocopy → PowerShell `Start-Process`)
- ห้ามแก้ไฟล์ที่ marked critical-don't ใน HANDOFF-v2: `dist/assets/index-*.js`, `COMPOSER_URL` ใน poster.js, UNIQUE constraint ของ pending_approvals, `bin/win32/*`

ดู [[codebase-architecture]] สำหรับโครงสร้างทั้งระบบที่อ่านไว้แล้ว
