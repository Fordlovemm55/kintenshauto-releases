---
name: user-preferences
description: "Chat in Thai with user, but write all product content (UI/spec/code) in English"
metadata:
  node_type: memory
  type: user
  originSessionId: bb88b3ff-311f-4e43-a220-ae303eeac8f4
---

- **Chat language:** Thai (user สื่อสารเป็นไทย — ตอบเป็นไทย)
- **Product language:** **English** for everything inside the codebase (declared 2026-05-16):
  - UI text (login screen, dashboard, wizards, error messages, toast notifications)
  - Spec docs, design docs, README, planning docs
  - Code comments (new code in English; existing Thai stays until refactored)
  - Database column comments + migration descriptions
  - Admin panel UI

  **Why:** User decided during Supabase integration planning — project for organizational use, wants international look
  **How to apply:** Write all new product content in English from now on. Respond to user in Thai chat. When editing files with existing Thai text, migrate to English as part of the edit.

- **Style:** ห้ามใส่ emoji ใน response เว้นแต่ user ขอ (per system instruction global)
- **Project:** KINTENSHAUTO — Electron app for FB Reel automation v1.0.0
- **Working dir:** `C:\Users\Pc2026\Desktop\KINTENSHAUTO-Source-v1.0.0`
