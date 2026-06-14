/**
 * Channel Watcher — UI injection (vanilla JS)
 *
 * วิธีทำงาน:
 *  - ไม่แตะ React bundle ของหลัก
 *  - MutationObserver คอย watch sidebar — เมื่อ React render ใหม่ → re-inject เมนู "ตามช่อง"
 *  - คลิกเมนูของเรา → render overlay เต็ม .app-main (z-index ทับ React content)
 *  - คลิกเมนู React อื่นๆ → ซ่อน overlay อัตโนมัติ
 *  - ใช้ CSS class เดิมของระบบ (.panel, .btn-primary, .badge ฯลฯ) — สีและฟอนต์ตรงกัน
 */
(function() {
  'use strict';

  // ✅ Dynamic API URL — รองรับ port อื่นกรณี electron main spawn backend ที่ port อื่น
  // อ่านจาก window.kintenshauto.apiBase (preload script) หรือ window.__KINTENSHAUTO_API__
  // ถ้าไม่มี → fallback localhost:3003 (default ใน server.js)
  const API = (typeof window !== 'undefined' && (
    (window.kintenshauto && window.kintenshauto.apiBase) ||
    window.__KINTENSHAUTO_API__
  )) || 'http://localhost:3003';
  const NAV_KEY = 'watcher';
  // ไอคอนเมนูแบบรูป (ไทล์ 3D สีเต็มใบ — มุมโค้ง) ให้เข้ากับ sidebar ฝั่ง React
  const NAV_ICON = '<svg class="icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const NAV_TH = 'ตามช่องอัตโนมัติ';

  let myNavItem = null;
  let overlay = null;
  let myActive = false;
  let backendOk = false;

  // ============================================================
  // ✅ IME FREEZE FIX (universal): user-typing guard
  //
  // Bug: polling refresh ทุก 2.5–12s เรียก renderRoot() ซึ่งทำ overlay.innerHTML='' →
  //      input element ถูก destroy ระหว่าง user พิมพ์ → IME ไทย (และ JP/CN/etc.)
  //      composition session ตาย → ต้องกด PrtSc ถึงจะ reset Chromium IME state
  //
  // Fix: ก่อน renderRoot() ตรวจว่า user กำลังพิมพ์อยู่หรือเปล่า:
  //   1. compositionstart/end → set _imeComposing flag
  //   2. activeElement = INPUT/TEXTAREA/SELECT ใน overlay หรือ modal → skip
  //   ถ้า skip → ตั้ง _pendingRender = true → จะ render หลัง user หยุดพิมพ์
  //   (compositionend หรือ blur)
  // ============================================================
  let _imeComposing = false;
  let _pendingRender = false;
  let _pendingFormRender = false;
  let _currentFormRender = null;     // closure ของ renderForm() ใน modal ปัจจุบัน (ถ้ามี)
  let _imeListenersAttached = false;

  function _isUserTyping() {
    if (_imeComposing) return true;
    const ae = document.activeElement;
    if (!ae) return false;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false;
    // skip เฉพาะถ้า input อยู่ใน overlay/modal ของเรา (กันกระทบ input อื่นใน React UI)
    if (overlay && overlay.contains(ae)) return true;
    const modal = document.getElementById('watcher-overlay-modal');
    if (modal && modal.contains(ae)) return true;
    return false;
  }

  function _attachImeListeners() {
    if (_imeListenersAttached) return;
    _imeListenersAttached = true;
    // ใช้ capture phase + global — ครอบคลุมทุก input ที่อาจ mount/unmount
    document.addEventListener('compositionstart', () => { _imeComposing = true; }, true);
    document.addEventListener('compositionend', () => {
      _imeComposing = false;
      _flushPendingRender();
    }, true);
    // blur ก็ flush ด้วย — user ออกจาก input
    document.addEventListener('focusout', () => {
      // delay เล็กน้อย เผื่อ focus กระโดดไป input อื่นใน overlay
      setTimeout(_flushPendingRender, 100);
    }, true);
  }

  function _flushPendingRender() {
    if (_isUserTyping()) return;
    if (_pendingFormRender && _currentFormRender) {
      _pendingFormRender = false;
      try { _currentFormRender(); } catch (e) { console.warn('[ime] form render flush', e); }
    }
    if (_pendingRender) {
      _pendingRender = false;
      if (myActive && overlay && overlay.style.display === 'block') {
        const sy = overlay.scrollTop;
        renderRoot();
        overlay.scrollTop = sy;
      }
    }
  }

  // Wrapper: ใช้แทน renderRoot() ใน path ที่มาจาก polling/auto-refresh
  function safeRenderRoot() {
    if (_isUserTyping()) {
      _pendingRender = true;
      return false;
    }
    renderRoot();
    return true;
  }

  // ============================================================
  // Backend probe — ถ้า backend ไม่มี endpoint นี้ ก็ไม่ inject
  // ============================================================
  async function probeBackend() {
    try {
      const r = await fetch(API + '/api/watcher/meta');
      if (!r.ok) return false;
      await r.json();
      return true;
    } catch { return false; }
  }

  // ============================================================
  // API helper
  // ============================================================
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  // ============================================================
  // Toast (ใช้ class .toast ของระบบเดิม)
  // ============================================================
  function showToast(title, body, kind = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML =
      '<div class="toast-title"></div>' +
      '<div class="toast-body"></div>';
    t.querySelector('.toast-title').textContent = title;
    t.querySelector('.toast-body').textContent = body || '';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ============================================================
  // YOUTUBE LOGIN MODAL
  // เมื่อ yt-dlp เจอ "Sign in to confirm you're not a bot" — anonymous retry
  // ก็ไม่ผ่าน — โชว์โมดัลให้ user เปิด YouTube login แล้วกด "ตกลง" ลองใหม่
  // ============================================================
  let _ytLoginModalNode = null;
  let _ytLoginUserDismissed = false;  // user กดยกเลิก → ไม่ auto-เด้งอีกจนกว่าจะมี fail ใหม่
  let _ytLoginLastFailKey = '';        // ใช้ track ว่ามี fail ใหม่หลัง user dismiss หรือยัง

  function _maybeShowYouTubeLoginModal(pending) {
    const needsLogin = (pending || []).filter(p =>
      p.status === 'failed' && /^\[NEEDS_YT_LOGIN\]/.test(p.download_error || '')
    );
    if (needsLogin.length === 0) {
      _ytLoginUserDismissed = false;  // เคลียร์ flag เมื่อไม่มีคลิป fail แล้ว
      _ytLoginLastFailKey = '';
      return;
    }
    // ถ้า user เพิ่ง dismiss + ไม่มี fail ใหม่ → ไม่เด้งซ้ำ
    const key = needsLogin.map(p => p.id).sort((a, b) => a - b).join(',');
    if (_ytLoginUserDismissed && key === _ytLoginLastFailKey) return;
    _ytLoginLastFailKey = key;
    _ytLoginUserDismissed = false;
    _showYouTubeLoginModal(needsLogin);
  }

  function _showYouTubeLoginModal(items) {
    if (_ytLoginModalNode) return;  // เปิดอยู่แล้ว
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(4px)';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:520px;width:100%;background:var(--surface-1);border:1px solid var(--gold);' +
      'box-shadow:0 24px 48px rgba(0,0,0,0.6);padding:28px 32px;color:var(--text-primary);font-size:14px';
    const titleRow = document.createElement('div');
    titleRow.innerHTML =
      '<div style="font-size:11px;letter-spacing:4px;color:var(--gold);margin-bottom:6px">เข้าสู่ระบบยูทูบ</div>' +
      '<div style="font-size:20px;font-weight:600;margin-bottom:12px">ต้องเข้าสู่ระบบยูทูบก่อนดาวน์โหลด</div>' +
      '<div style="font-size:13px;line-height:1.6;color:var(--text-muted);margin-bottom:8px">ยูทูบขอให้ยืนยันว่าไม่ใช่บอท สำหรับ ' + items.length + ' คลิป<br>วิธีแก้:</div>' +
      '<ol style="font-size:13px;line-height:1.8;margin:0 0 18px 22px;color:var(--text-primary)">' +
        '<li>กดปุ่ม "🌐 เปิดยูทูบ" ด้านล่าง</li>' +
        '<li>เข้าสู่ระบบบัญชียูทูบของคุณในโครม</li>' +
        '<li>กลับมาที่นี่แล้วกด "✓ เข้าสู่ระบบแล้ว — ลองใหม่"</li>' +
      '</ol>';
    card.appendChild(titleRow);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-top:18px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = 'ยกเลิก';
    cancelBtn.onclick = () => {
      _ytLoginUserDismissed = true;
      _closeYouTubeLoginModal();
    };

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-ghost';
    openBtn.textContent = '🌐 เปิดยูทูบ';
    openBtn.onclick = () => {
      try { window.kintenshauto?.openExternal?.('https://www.youtube.com/'); }
      catch (e) { console.warn('openExternal failed', e); }
    };

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-primary';
    retryBtn.textContent = '✓ เข้าสู่ระบบแล้ว — ลองใหม่';
    retryBtn.onclick = async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = '⏳ กำลังลองใหม่...';
      try {
        const r = await api('/api/watcher/pending/retry-needs-login', { method: 'POST' });
        showToast('เริ่มดาวน์โหลดใหม่', `เริ่ม ${r.retried} คลิป (ผ่าน ${r.ok}, ติด ${r.failed})`, r.failed === 0 ? 'success' : 'info');
        _closeYouTubeLoginModal();
        await refresh();
      } catch (e) {
        showToast('ลองใหม่ไม่สำเร็จ', e.message || 'ติดปัญหา', 'danger');
        retryBtn.disabled = false;
        retryBtn.textContent = '✓ เข้าสู่ระบบแล้ว — ลองใหม่';
      }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(openBtn);
    btnRow.appendChild(retryBtn);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    _ytLoginModalNode = overlay;
  }

  function _closeYouTubeLoginModal() {
    if (!_ytLoginModalNode) return;
    _ytLoginModalNode.remove();
    _ytLoginModalNode = null;
  }

  // ============================================================
  // SIDEBAR INJECTION
  // ============================================================
  function injectNavItem() {
    const sidebar = document.querySelector('.app-sidebar');
    if (!sidebar) return;

    // ถ้ามีอยู่แล้วและยังอยู่ใน DOM — ไม่ต้องทำซ้ำ
    if (myNavItem && sidebar.contains(myNavItem)) return;

    // สร้างใหม่
    myNavItem = document.createElement('div');
    myNavItem.className = 'nav-item watcher-nav-injected' + (myActive ? ' active' : '');
    myNavItem.dataset.watcherInject = '1';
    myNavItem.innerHTML =
      NAV_ICON +
      '<span style="flex:1">' + NAV_TH + '</span>' +
      '<span class="watcher-badge" style="display:none;font-size:10px;padding:1px 7px;border-radius:10px;background:rgba(232,123,123,.15);border:1px solid var(--danger);color:var(--danger);"></span>';

    myNavItem.addEventListener('click', (e) => {
      e.stopPropagation();
      activateMyView();
    });

    // วางไว้แถวบน — หลัง "เพิ่มคลิปเอง" (กลุ่มใช้ประจำ) ; fallback เป็นหลังตรวจสอบ แล้วค่อยท้ายสุด
    const navItems = Array.from(sidebar.querySelectorAll('.nav-item:not(.watcher-nav-injected)'));
    const anchor = navItems.find(n => (n.textContent || '').includes('เพิ่มคลิปเอง'))
      || navItems.find(n => (n.textContent || '').includes('ตรวจสอบ'))
      || (navItems.length ? navItems[navItems.length - 1] : null);
    if (anchor) {
      anchor.parentNode.insertBefore(myNavItem, anchor.nextSibling);
    } else {
      sidebar.appendChild(myNavItem);
    }
  }

  function activateMyView() {
    myActive = true;
    // remove active จากเมนู React อื่นๆ (visual only — React จะ override แต่เราจะ re-inject)
    document.querySelectorAll('.nav-item.active').forEach(n => {
      if (n !== myNavItem) n.classList.remove('active');
    });
    myNavItem.classList.add('active');
    showOverlay();
  }

  function deactivateMyView() {
    myActive = false;
    if (myNavItem) myNavItem.classList.remove('active');
    hideOverlay();
  }

  // ============================================================
  // OVERLAY (ครอบ .app-main)
  // ============================================================
  // ✅ FIX UI: ฉีด stylesheet ครั้งเดียว — override ปุ่ม/spacing ใน overlay ให้ใหญ่ขึ้น
  function injectStyles() {
    if (document.getElementById('watcher-styles')) return;
    const s = document.createElement('style');
    s.id = 'watcher-styles';
    s.textContent = `
      #watcher-overlay .panel { padding: 28px 32px; margin-bottom: 24px; }
      #watcher-overlay .panel-header { gap: 16px; padding-bottom: 18px; margin-bottom: 24px; }
      #watcher-overlay .panel-title { font-size: 22px; font-weight: 600; }
      #watcher-overlay .panel-subtitle { font-size: 14px; line-height: 1.6; }
      #watcher-overlay .label-jp { font-size: 12px; letter-spacing: 4px; margin-bottom: 6px; }

      /* main action buttons (header right side) */
      #watcher-overlay .panel-header > button.btn-primary,
      #watcher-overlay .panel-header > button.btn-gold {
        padding: 13px 26px !important;
        font-size: 15px !important;
        font-weight: 600 !important;
        letter-spacing: 0.5px;
        min-height: 44px;
        white-space: nowrap;
      }

      /* ✅ table action buttons (เช็คเลย / แก้ / เปิด-ปิด) — group ปลอดภัย */
      #watcher-overlay .watcher-act-btn {
        padding: 8px 14px !important;
        font-size: 13px !important;
        font-weight: 500 !important;
        min-height: 36px;
        min-width: 70px;
        white-space: nowrap;
      }
      /* ✅ ปุ่มลบ — เด่นชัด แยกออกจากกลุ่ม + hover effect ชัด */
      #watcher-overlay .watcher-del-btn {
        padding: 8px 16px !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        min-height: 36px;
        min-width: 70px;
        opacity: .75;
        transition: all .15s ease;
      }
      #watcher-overlay .watcher-del-btn:hover {
        opacity: 1;
        background: rgba(232,123,123,.15) !important;
        transform: scale(1.04);
      }
      /* legacy fallback for any old buttons (shouldn't apply but defensive) */
      #watcher-overlay table button:not(.watcher-act-btn):not(.watcher-del-btn) {
        padding: 8px 14px !important;
        font-size: 13px !important;
        font-weight: 500 !important;
        margin-right: 6px !important;
        min-height: 34px;
      }
      #watcher-overlay table { font-size: 14px !important; }
      #watcher-overlay table th { padding: 14px 10px !important; font-size: 12px !important; }
      #watcher-overlay table td { padding: 14px 10px !important; }

      /* pending card buttons */
      #watcher-overlay .pending-card { padding: 0; }
      #watcher-overlay .pending-card .pc-actions { display: flex; gap: 8px; margin-top: 10px; }
      #watcher-overlay .pending-card .pc-actions button,
      #watcher-overlay .pending-card .pc-actions a {
        padding: 10px 14px !important;
        font-size: 13px !important;
        min-height: 38px;
        font-weight: 500;
      }
      #watcher-overlay .pending-card .pc-actions button.btn-primary { flex: 1; }

      /* card content tighter */
      #watcher-overlay .pending-card .pc-body { padding: 14px 14px 14px 14px; }

      /* badge ใน injected nav-item ใหญ่ขึ้นนิด */
      .watcher-nav-injected .watcher-badge {
        font-size: 11px !important;
        padding: 2px 8px !important;
        min-width: 20px;
        text-align: center;
      }

      /* ✅ "ใหม่" badge pulse — เด่นชัด user เห็นทันที */
      @keyframes watcher-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(212,175,55,.7); }
        50%      { box-shadow: 0 0 0 6px rgba(212,175,55,0); }
      }
      #watcher-overlay .watcher-new-badge {
        animation: watcher-pulse 1.8s ease-in-out infinite;
      }

      /* modal */
      #watcher-overlay-modal .panel { max-width: 720px; }
      #watcher-overlay-modal input,
      #watcher-overlay-modal select,
      #watcher-overlay-modal textarea {
        font-size: 14px !important;
        padding: 11px 14px !important;
      }
      #watcher-overlay-modal label { font-size: 13px; margin-bottom: 8px; font-weight: 500; }
      #watcher-overlay-modal button[type="submit"],
      #watcher-overlay-modal button.btn-primary,
      #watcher-overlay-modal button.btn-ghost {
        padding: 12px 22px !important;
        font-size: 14px !important;
        font-weight: 600 !important;
        min-height: 42px;
      }
    `;
    document.head.appendChild(s);
  }

  // ✅ FIX bleed-through: overlay = position:fixed pinned ที่ขอบ .app-main จริง
  // (เดิม position:absolute;inset:0 ใน main → background สูงแค่ viewport ของ main
  //  → React content ใต้ overlay scroll bleed ออกมาด้านล่าง)
  let _overlayMain = null;
  let _overlayPositionTimer = null;
  function updateOverlayPosition() {
    if (!overlay || !_overlayMain || overlay.style.display === 'none') return;
    const r = _overlayMain.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }

  function ensureOverlay() {
    const main = document.querySelector('.app-main');
    if (!main) return null;
    injectStyles();
    _overlayMain = main;

    if (overlay && document.body.contains(overlay)) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'watcher-overlay';
    // ใส่ใน document.body + position:fixed → ไม่ขึ้นกับ scroll/overflow ของ .app-main
    // → ครอบเต็มพื้นที่ main ตลอดเวลา (ไม่มี bleed-through)
    overlay.style.cssText =
      'position:fixed;z-index:100;' +
      'background:radial-gradient(900px 520px at 50% -10%,rgba(99,102,241,0.10),transparent 60%),#0f172a;' +
      'overflow-y:auto;padding:32px 40px;display:none;' +
      'box-shadow:inset 0 0 60px rgba(0,0,0,.5)';
    document.body.appendChild(overlay);

    // เก็บ listener สำหรับ reposition (resize, scroll, sidebar collapse, etc.)
    window.addEventListener('resize', updateOverlayPosition);
    // ResizeObserver บน .app-main — กรณี layout grid เปลี่ยน (sidebar collapse)
    try {
      const ro = new ResizeObserver(() => updateOverlayPosition());
      ro.observe(main);
    } catch {}

    return overlay;
  }

  function showOverlay() {
    const o = ensureOverlay();
    if (!o) return;
    o.style.display = 'block';
    updateOverlayPosition();   // ✅ pin to current main bbox immediately
    // ✅ poll position ทุก 500ms — กัน drift จาก animation/transition ของ React
    if (_overlayPositionTimer) clearInterval(_overlayPositionTimer);
    _overlayPositionTimer = setInterval(updateOverlayPosition, 500);
    renderRoot();
    startPolling();
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (_overlayPositionTimer) {
      clearInterval(_overlayPositionTimer);
      _overlayPositionTimer = null;
    }
    stopPolling();
  }

  // ============================================================
  // STATE + POLLING
  // ============================================================
  let state = { channels: [], pending: [], pages: [] };
  let pollTimer = null;

  // ✅ FIX flicker: state hash — render เฉพาะถ้า data เปลี่ยน
  // (เดิม poll ทุก 2.5/8s → re-render destroyed/recreated DOM ทุกครั้ง = กระพริบ)
  let lastStateHash = '';
  function hashState(s) {
    try {
      // hash เฉพาะส่วนที่ส่งผลต่อ UI — ลด false-changes (เช่น created_at อย่าใส่)
      const c = (s.channels || []).map(ch => `${ch.id}|${ch.label}|${ch.enabled}|${ch.last_checked_at}|${ch.next_check_at}|${ch.error_count}|${(ch.pages||[]).map(p=>p.id).join(',')}`).join(';');
      const p = (s.pending || []).map(x => `${x.id}|${x.status}|${x.download_progress}|${x.download_error||''}`).join(';');
      const pg = (s.pages || []).map(x => `${x.id}|${x.name}`).join(';');
      return c + '||' + p + '||' + pg;
    } catch { return Math.random().toString(); }
  }

  async function refresh() {
    try {
      const [c, p, pg] = await Promise.all([
        api('/api/watcher/channels').catch(() => []),
        api('/api/watcher/pending').catch(() => []),
        api('/api/pages').catch(() => [])
      ]);
      state = { channels: c, pending: p, pages: pg };
      updateBadge();
      _maybeShowYouTubeLoginModal(p);
      // ✅ FIX flicker: render เฉพาะถ้ามีอะไรเปลี่ยน
      const newHash = hashState(state);
      const changed = newHash !== lastStateHash;
      lastStateHash = newHash;
      if (myActive && overlay && overlay.style.display === 'block' && changed) {
        // ✅ FIX flicker: เก็บ scroll position ก่อน re-render → restore หลัง
        // ✅ FIX IME: ถ้า user กำลังพิมพ์ (composition active / focused input ใน overlay)
        //   → defer render — กัน input element ถูก destroy ระหว่าง IME composition
        if (_isUserTyping()) {
          _pendingRender = true;
        } else {
          const sy = overlay.scrollTop;
          renderRoot();
          overlay.scrollTop = sy;
        }
      }
    } catch (e) {
      console.warn('[watcher] refresh', e);
    }
  }

  function updateBadge() {
    if (!myNavItem) return;
    const b = myNavItem.querySelector('.watcher-badge');
    if (!b) return;
    const count = (state.pending || []).filter(p => p.status === 'pending').length;
    if (count > 0) {
      b.textContent = count;
      b.style.display = 'inline';
    } else {
      b.style.display = 'none';
    }
  }

  // ✅ FIX: await refresh() ก่อนคำนวณ interval — เดิมใช้ state เก่า (ก่อน fetch)
  // ทำให้ตอนเริ่ม download ใหม่ poller ยังเป็น 8s (ควรเป็น 2.5s)
  async function startPolling() {
    await refresh();
    schedulePoll();
  }
  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    const hasDownloading = (state.pending || []).some(p => p.status === 'downloading');
    pollTimer = setInterval(async () => {
      await refresh();
      // re-evaluate interval หลัง refresh — ถ้า hasDownloading flip ปรับ interval
      const nowDownloading = (state.pending || []).some(p => p.status === 'downloading');
      if (nowDownloading !== hasDownloading) schedulePoll();
    }, hasDownloading ? 2500 : 8000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // Background poll สำหรับ badge แม้ไม่ได้เปิดหน้า watcher
  // ✅ FIX: เก็บ handle ไว้เพื่อ cleanup
  let bgBadgeTimer = null;
  function startBackgroundBadgePoll() {
    if (bgBadgeTimer) clearInterval(bgBadgeTimer);
    bgBadgeTimer = setInterval(async () => {
      try {
        const r = await fetch(API + '/api/watcher/pending/count');
        if (r.ok) {
          const { count } = await r.json();
          const b = myNavItem?.querySelector('.watcher-badge');
          if (b) {
            if (count > 0) { b.textContent = count; b.style.display = 'inline'; }
            else b.style.display = 'none';
          }
        }
      } catch {}
    }, 30000);
  }

  // ============================================================
  // HELPERS
  // ============================================================
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
      else if (Array.isArray(c)) c.forEach(x => x && e.appendChild(x));
      else e.appendChild(c);
    }
    return e;
  }

  const PLATFORM_LABEL = {
    youtube: 'ยูทูบ', bilibili: 'บิลิบิลิ', tiktok: 'ติ๊กต็อก',
    facebook: 'เฟซบุ๊ก', other: 'อื่นๆ'
  };
  const CONTENT_TYPE_OPTIONS = [
    { value: 'all', label: 'ทุกคลิปทั่วไป (วิดีโอ)' },
    { value: 'shorts', label: 'ช็อตส์ (ยูทูบ)' },
    { value: 'reels', label: 'รีล (เฟซบุ๊ก / ช็อตส์ของยูทูบ)' },
    { value: 'longform', label: 'คลิปยาว (>1 นาที)' },
    { value: 'live', label: 'ไลฟ์ / สตรีม' }
  ];
  function detectPlatform(url) {
    const u = (url || '').toLowerCase();
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('bilibili.com')) return 'bilibili';
    if (u.includes('tiktok.com')) return 'tiktok';
    if (u.includes('facebook.com') || u.includes('fb.com') || u.includes('fb.watch')) return 'facebook';
    return 'other';
  }
  function fmtDuration(sec) {
    if (!sec) return '-';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtDateTime(s) {
    if (!s) return '-';
    return s.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
  }
  function timeFromNow(iso) {
    if (!iso) return '-';
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    const diff = (d.getTime() - Date.now()) / 1000;
    if (isNaN(diff)) return '-';
    const abs = Math.abs(diff);
    const txt = abs < 60 ? Math.round(abs) + ' วิ'
              : abs < 3600 ? Math.round(abs / 60) + ' นาที'
              : Math.round(abs / 3600) + ' ชม.';
    return diff > 0 ? 'อีก ' + txt : 'เมื่อ ' + txt + 'ที่แล้ว';
  }

  // ✅ FIX timezone: backend's Electron Node บางเครื่องเรียก getHours() ได้ค่า UTC (TZ bug)
  //   → toSqlLocal() เก็บค่า UTC แทน local → UI ต้อง parse เป็น UTC ด้วย ('Z' suffix)
  // เดิม parse เป็น local → off ~7 ชม. → "🆕 ใหม่" badge หาย, "เพิ่ง X นาที" ผิด
  function fmtRelative(sqlLocal) {
    if (!sqlLocal) return '-';
    // ถือเป็น UTC เสมอ (consistent with backend's toSqlLocal output)
    const t = new Date(sqlLocal.replace(' ', 'T') + 'Z').getTime();
    if (isNaN(t)) return '-';
    const sec = Math.max(0, (Date.now() - t) / 1000);
    if (sec < 60)   return 'เมื่อ ' + Math.round(sec) + ' วินาที';
    if (sec < 3600) return 'เมื่อ ' + Math.round(sec / 60) + ' นาที';
    if (sec < 86400)return 'เมื่อ ' + Math.round(sec / 3600) + ' ชม.';
    return 'เมื่อ ' + Math.round(sec / 86400) + ' วัน';
  }
  function contentTypeLabel(t) {
    const o = CONTENT_TYPE_OPTIONS.find(x => x.value === t);
    return o ? o.label : t;
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderRoot() {
    if (!overlay) return;
    overlay.innerHTML = '';
    overlay.appendChild(renderChannelsPanel());
    overlay.appendChild(renderPendingPanel());
    overlay.appendChild(renderCaptionSettingsPanel());   // ✅ NEW
  }

  // ✅ Caption settings — แบบง่าย: ใส่ prompt ตัวเดียว ใช้ได้กับทุกเพจ
  // (advanced: System prompt / temperature / max tokens ซ่อนใน <details>)
  function renderCaptionSettingsPanel() {
    const panel = el('details', { class: 'panel fade-in', style: 'cursor:pointer' });

    const summary = el('summary', { style: 'list-style:none;outline:none;cursor:pointer' });
    summary.appendChild(el('div', { class: 'panel-header', style: 'margin-bottom:0;padding-bottom:0;border:none' },
      el('div', {},
        el('div', { class: 'label-jp' }, 'แคปชั่นช่อง'),
        el('div', { class: 'panel-title' }, '⚙ คำสั่ง AI สำหรับสร้างแคปชั่น'),
        el('div', { class: 'panel-subtitle' },
          'ใส่ครั้งเดียวใช้กับทุกเพจ · แยกจากแคปชั่นหลัก (เมนู "AI แคปชั่น") · คลิกเพื่อเปิด/ปิด')
      )
    ));
    panel.appendChild(summary);

    const form = el('div', { style: 'margin-top:18px' });

    // hint variables
    form.appendChild(el('div', {
      style: 'background:rgba(212,175,55,.08);border:1px solid var(--border-soft);padding:12px 14px;font-size:13px;color:var(--text-secondary);border-radius:4px;margin-bottom:14px;line-height:1.8'
    },
      el('div', { style: 'font-weight:600;color:var(--gold);margin-bottom:6px' },
        '💡 ใส่ตัวแปรในคำสั่งได้ — AI จะแทนค่าจริงให้:'),
      el('div', {},
        el('code', { style: 'color:var(--gold);background:rgba(0,0,0,.3);padding:3px 8px;margin-right:6px;font-size:12px' }, '{video_title}'),
        ' ชื่อคลิปต้นฉบับ'),
      el('div', {},
        el('code', { style: 'color:var(--gold);background:rgba(0,0,0,.3);padding:3px 8px;margin-right:6px;font-size:12px' }, '{channel_label}'),
        ' ชื่อช่องยูทูบ/ติ๊กต็อก ที่ตามดู'),
      el('div', {},
        el('code', { style: 'color:var(--gold);background:rgba(0,0,0,.3);padding:3px 8px;margin-right:6px;font-size:12px' }, '{page_name}'),
        ' ชื่อเพจเฟซบุ๊กปลายทาง'),
      el('div', {},
        el('code', { style: 'color:var(--gold);background:rgba(0,0,0,.3);padding:3px 8px;margin-right:6px;font-size:12px' }, '{niche}'),
        ' แนวหมวดหมู่ที่ตั้งให้เพจ (ถ้ามี)'),
      el('div', {},
        el('code', { style: 'color:var(--gold);background:rgba(0,0,0,.3);padding:3px 8px;margin-right:6px;font-size:12px' }, '{source_url}'),
        ' ลิงก์คลิปต้นฉบับ')
    ));

    // ─── ONE main textarea ───
    const usrTa = el('textarea', {
      rows: 8,
      placeholder:
        'ตัวอย่าง:\n\nเขียนแคปชั่นรีลภาษาไทยสั้นๆ 2-3 บรรทัด สำหรับคลิปชื่อ "{video_title}"\nให้ดึงดูดน่าคลิก ใช้อิโมจิ + แฮชแท็ก 3-5 อัน\nลงท้ายเชิญชวนให้กดติดตาม',
      style: 'min-height:200px;font-family:Sarabun, sans-serif;font-size:14px;line-height:1.7'
    });
    form.appendChild(el('div', {},
      el('label', { style: 'font-weight:600;font-size:14px' }, '✏️ คำสั่ง AI ของคุณ'),
      usrTa
    ));

    // ─── Advanced (collapsed) ───
    const adv = el('details', { style: 'margin-top:14px' });
    adv.appendChild(el('summary', {
      style: 'cursor:pointer;font-size:12px;color:var(--text-muted);padding:8px 0;font-weight:500'
    }, '⚙ ตั้งค่าขั้นสูง (โดยทั่วไปไม่ต้องแตะ)'));

    const sysTa = el('textarea', {
      rows: 3,
      placeholder: '(เว้นว่างได้ — ระบบจะใช้คำสั่งระบบเริ่มต้นที่เหมาะสม)',
      style: 'min-height:80px;font-family:monospace;font-size:12px;opacity:.85'
    });
    const tempInput = el('input', { type: 'number', min: '0.1', max: '1.5', step: '0.05', value: '0.85', style: 'max-width:120px' });
    const tokenInput = el('input', { type: 'number', min: '50', max: '1000', step: '10', value: '300', style: 'max-width:120px' });

    adv.appendChild(el('div', { style: 'margin-top:10px' },
      el('label', { style: 'font-size:12px' }, 'คำสั่งระบบ (บทบาท AI — ใช้ค่าเริ่มต้นถ้าเว้นว่าง)'),
      sysTa
    ));
    adv.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px' },
      el('div', {},
        el('label', { style: 'font-size:12px' }, 'ระดับความสร้างสรรค์ (0.1-1.5)'),
        tempInput),
      el('div', {},
        el('label', { style: 'font-size:12px' }, 'ความยาวสูงสุด (จำนวนคำ)'),
        tokenInput)
    ));
    form.appendChild(adv);

    // ─── status + buttons ───
    const status = el('div', { style: 'font-size:13px;color:var(--text-muted);min-height:20px;margin-top:14px' });
    const saveBtn = el('button', { class: 'btn-primary', type: 'button' }, '💾 บันทึกคำสั่ง');
    const reloadBtn = el('button', { class: 'btn-ghost', type: 'button', style: 'margin-right:8px' }, '↻ โหลดล่าสุด');
    const clearBtn = el('button', { class: 'btn-ghost', type: 'button', style: 'margin-right:8px;color:var(--danger);border-color:var(--danger)' }, '🗑 ล้างค่า');

    async function load() {
      try {
        status.textContent = '⏳ กำลังโหลด...';
        const r = await api('/api/watcher/caption-prompt');
        sysTa.value = r.system_prompt || '';
        usrTa.value = r.user_prompt || '';
        tempInput.value = r.temperature || 0.85;
        tokenInput.value = r.max_tokens || 300;
        status.textContent = (r.user_prompt || '').trim()
          ? '✓ ตั้งค่าแล้ว — ใช้กับทุกเพจที่ผ่านการตามช่องอัตโนมัติ'
          : 'ℹ ยังไม่ตั้งค่า — จะใช้คำสั่งหลักของระบบแทน (เมนู "AI แคปชั่น")';
      } catch (e) { status.textContent = '✗ โหลดล้มเหลว: ' + e.message; }
    }

    saveBtn.addEventListener('click', async () => {
      if (!usrTa.value.trim()) {
        status.textContent = '⚠ กรุณาใส่คำสั่งก่อน';
        return;
      }
      saveBtn.disabled = true; status.textContent = '⏳ บันทึก...';
      try {
        await api('/api/watcher/caption-prompt', {
          method: 'PUT',
          body: JSON.stringify({
            system_prompt: sysTa.value, user_prompt: usrTa.value,
            temperature: parseFloat(tempInput.value) || 0.85,
            max_tokens: parseInt(tokenInput.value, 10) || 300
          })
        });
        status.textContent = '✓ บันทึกแล้ว · จะใช้กับโพสต์ครั้งถัดไป';
        showToast('บันทึกแล้ว', 'แคปชั่น AI สำหรับการตามช่องอัตโนมัติ', 'success');
      } catch (e) { status.textContent = '✗ บันทึกไม่สำเร็จ: ' + e.message; }
      finally { saveBtn.disabled = false; }
    });

    clearBtn.addEventListener('click', async () => {
      if (!confirm('ล้างคำสั่ง AI ของการตามช่องอัตโนมัติ? — กลับไปใช้คำสั่งหลักของระบบ')) return;
      try {
        await api('/api/watcher/caption-prompt', {
          method: 'PUT',
          body: JSON.stringify({ system_prompt: '', user_prompt: '', temperature: 0.85, max_tokens: 300 })
        });
        sysTa.value = ''; usrTa.value = '';
        tempInput.value = 0.85; tokenInput.value = 300;
        status.textContent = 'ℹ ล้างแล้ว — กลับไปใช้คำสั่งหลัก';
      } catch (e) { status.textContent = '✗ ล้างไม่สำเร็จ: ' + e.message; }
    });

    reloadBtn.addEventListener('click', load);

    form.appendChild(el('div', { style: 'margin-top:18px;display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap' },
      status,
      el('div', { style: 'flex:1' }),
      clearBtn, reloadBtn, saveBtn
    ));

    panel.addEventListener('toggle', () => {
      if (panel.open && !panel.dataset.loaded) {
        panel.dataset.loaded = '1';
        load();
      }
    });

    panel.appendChild(form);
    return panel;
  }

  // Toggle ตัดต่ออัตโนมัติสำหรับ Channel Watcher (slice + banner)
  // ON = pipeline ปกติ (slice 9:16 + banner) · OFF = โพสต์ raw clip ตรงๆ
  function renderAutoEditToggle() {
    const wrap = el('div', {
      class: 'watcher-edit-toggle',
      style: 'display:inline-flex;align-items:center;gap:8px;padding:6px 12px;' +
             'background:var(--surface-2);border-radius:6px;font-size:12px;cursor:pointer;' +
             'border:1px solid var(--border-soft)',
      title: 'เปิด: ตัด+ใส่แบนเนอร์ปกติ · ปิด: โพสต์คลิปต้นฉบับโดยไม่ตัดต่อ'
    });
    const cb = el('input', { type: 'checkbox' });
    cb.style.width = 'auto';
    cb.style.cursor = 'pointer';
    const labelText = el('span', { style: 'font-weight:500;user-select:none' }, '✂ ตัดต่ออัตโนมัติ: …');

    const refresh = async () => {
      try {
        const r = await api('/api/settings/watcher_auto_edit_enabled');
        const enabled = r?.value !== '0';
        cb.checked = enabled;
        labelText.textContent = enabled ? '✂ ตัดต่ออัตโนมัติ: เปิด' : '✂ ตัดต่ออัตโนมัติ: ปิด';
        labelText.style.color = enabled ? 'var(--success)' : 'var(--warning)';
      } catch {
        labelText.textContent = '✂ ตัดต่ออัตโนมัติ: ?';
      }
    };

    cb.addEventListener('change', async () => {
      const newVal = cb.checked ? '1' : '0';
      try {
        await api('/api/settings/watcher_auto_edit_enabled', {
          method: 'PUT',
          body: JSON.stringify({ value: newVal })
        });
        showToast('ตั้งค่าแล้ว',
          cb.checked ? 'ตัดต่ออัตโนมัติเปิดอยู่ — ตัด + ใส่แบนเนอร์ตามปกติ'
                     : 'ตัดต่ออัตโนมัติปิด — โพสต์คลิปต้นฉบับเลย ไม่ตัด ไม่ใส่แบนเนอร์',
          'success');
        refresh();
      } catch (e) {
        showToast('ผิดพลาด', e.message, 'danger');
        cb.checked = !cb.checked;   // revert
      }
    });

    wrap.appendChild(cb);
    wrap.appendChild(labelText);
    refresh();
    return wrap;
  }

  function renderChannelsPanel() {
    const panel = el('div', { class: 'panel fade-in' });
    panel.appendChild(el('div', { class: 'panel-header' },
      el('div', {},
        el('div', { class: 'label-jp' }, 'ช่องที่ตามดู'),
        el('div', { class: 'panel-title' }, 'ช่องที่บอทคอยตามดู'),
        el('div', { class: 'panel-subtitle' },
          'บอทเช็คทุก N ชั่วโมงตามที่ตั้ง — เจอคลิปใหม่ → รออนุมัติ → ดาวน์โหลดเข้าโฟลเดอร์เฉพาะของช่องนั้น (กันคลิปปนเพจ)')
      ),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end' },
        renderAutoEditToggle(),
        el('button', { class: 'btn-primary', onclick: () => openAddModal() }, '＋ เพิ่มช่อง')
      )
    ));

    if (state.channels.length === 0) {
      panel.appendChild(emptyState('', 'ยังไม่มีช่องที่ตามดู',
        'กด "＋ เพิ่มช่อง" แล้วใส่ลิงก์ช่องยูทูบ / ติ๊กต็อก / บิลิบิลิ / เฟซบุ๊ก'));
    } else {
      panel.appendChild(renderChannelTable());
    }
    return panel;
  }

  function renderChannelTable() {
    const wrap = el('div', { style: 'overflow:auto' });
    const tbl = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });

    const thead = el('thead', {},
      el('tr', { style: 'border-bottom:.5px solid var(--border-soft);color:var(--text-muted)' },
        ['ช่อง', 'แพลตฟอร์ม', 'ประเภท', 'เพจปลายทาง', 'เช็คทุก', 'เช็คล่าสุด', 'เช็คถัดไป', 'สถานะ', 'จัดการ'].map((h, i) =>
          el('th', { style: 'text-align:' + (i === 8 ? 'right' : 'left') + ';padding:10px 8px;font-weight:500;font-size:12px' }, h)
        )
      )
    );
    tbl.appendChild(thead);

    const tbody = el('tbody');
    state.channels.forEach(ch => {
      const tr = el('tr', { style: 'border-bottom:.5px solid var(--border-faint)' });
      const td = (style, ...kids) => el('td', { style: 'padding:10px 8px;vertical-align:top;' + (style || '') }, ...kids);

      tr.appendChild(td('',
        el('div', { style: 'font-weight:500' }, ch.label),
        el('a', { href: ch.channel_url, target: '_blank', rel: 'noreferrer',
          style: 'font-size:11px;color:var(--text-muted);text-decoration:none' },
          ch.channel_url.length > 50 ? ch.channel_url.slice(0, 50) + '…' : ch.channel_url)
      ));
      tr.appendChild(td('', el('span', { class: 'badge badge-info' }, PLATFORM_LABEL[ch.platform] || ch.platform)));
      tr.appendChild(td('', contentTypeLabel(ch.content_type)));

      const pagesCell = td('');
      if (!ch.pages || ch.pages.length === 0) {
        pagesCell.appendChild(el('span', { class: 'badge badge-warning' }, 'ยังไม่ผูกเพจ'));
      } else {
        const wrap2 = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' });
        ch.pages.forEach(p => wrap2.appendChild(el('span', { class: 'badge badge-gold', style: 'font-size:10px' }, p.name)));
        pagesCell.appendChild(wrap2);
      }
      tr.appendChild(pagesCell);

      tr.appendChild(td('', ch.interval_hours + ' ชม.'));
      tr.appendChild(td('', ch.last_checked_at ? fmtDateTime(ch.last_checked_at) : 'ยังไม่เคย'));
      tr.appendChild(td('', ch.next_check_at ? timeFromNow(ch.next_check_at) : '-'));

      const statusCell = td('',
        ch.enabled
          ? el('span', { class: 'badge badge-success' }, 'เปิด')
          : el('span', { class: 'badge badge-danger' }, 'ปิด')
      );
      tr.appendChild(statusCell);

      // ✅ FIX: จัดเรียงปุ่มเป็น 2 group แยก — กดผิดยาก
      // group 1 = action ปกติ (เช็ค/แก้/ปิด-เปิด) — รวมกันเป็นแถบเดียว
      // group 2 = ปุ่มลบ — แยกออกห่าง + อยู่บรรทัดถัดไป (mobile-friendly + กันกดผิด)
      const actCell = td('text-align:right;min-width:200px;white-space:nowrap');
      const actWrap = el('div', {
        style: 'display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end'
      });
      // group ปลอดภัย
      const safeGroup = el('div', { style: 'display:inline-flex;gap:6px;align-items:center' },
        el('button', { class: 'btn-ghost watcher-act-btn', onclick: () => onCheckNow(ch.id) }, '🔍 เช็คเลย'),
        el('button', { class: 'btn-ghost watcher-act-btn',
          title: 'ล้างจุดเริ่มต้น + ดึงคลิปล่าสุดทั้งหมดมารออนุมัติ',
          onclick: () => onPullOld(ch) }, '📥 ดึงเก่า'),
        el('button', { class: 'btn-ghost watcher-act-btn', onclick: () => openEditModal(ch) }, '✎ แก้'),
        el('button', { class: 'btn-ghost watcher-act-btn',
          style: 'color:' + (ch.enabled ? 'var(--warning)' : 'var(--success)') + ';border-color:' + (ch.enabled ? 'var(--warning)' : 'var(--success)'),
          onclick: () => onToggle(ch) }, ch.enabled ? '⏸ ปิด' : '▶ เปิด')
      );
      // separator + ลบ (อันตราย — ห่างจากกลุ่ม + ต้อง confirm)
      const dangerGroup = el('div', { style: 'display:inline-flex;align-items:center;margin-left:18px;padding-left:18px;border-left:1px solid var(--border-faint)' },
        el('button', {
          class: 'btn-danger watcher-del-btn',
          title: 'ลบช่องนี้ (โฟลเดอร์คลิปยังอยู่)',
          onclick: () => onDelete(ch)
        }, '🗑 ลบ')
      );
      actWrap.appendChild(safeGroup);
      actWrap.appendChild(dangerGroup);
      actCell.appendChild(actWrap);
      tr.appendChild(actCell);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    return wrap;
  }

  function renderPendingPanel() {
    const panel = el('div', { class: 'panel fade-in' });
    const dl = state.pending.filter(p => p.status === 'downloading').length;
    const failed = state.pending.filter(p => p.status === 'failed').length;
    const pendingOnly = state.pending.filter(p => p.status === 'pending');

    const titleNode = el('div', { class: 'panel-title' }, 'คลิปใหม่ (' + state.pending.length + ')');
    if (dl > 0) titleNode.appendChild(
      el('span', { class: 'badge badge-info', style: 'margin-left:8px;font-size:10px' }, '⏬ กำลังโหลด ' + dl)
    );
    if (failed > 0) titleNode.appendChild(
      el('span', { class: 'badge badge-danger', style: 'margin-left:4px;font-size:10px' }, '✗ ล้มเหลว ' + failed)
    );

    const header = el('div', { class: 'panel-header' },
      el('div', {},
        el('div', { class: 'label-jp' }, 'รออนุมัติ'),
        titleNode,
        el('div', { class: 'panel-subtitle' },
          'อนุมัติ → ดาวน์โหลดเต็ม + เตรียมคลิปและงานให้สายการผลิต | ปฏิเสธ → ข้ามถาวร')
      )
    );
    if (pendingOnly.length > 0) {
      const btnGroup = el('div', { style: 'display:inline-flex;gap:8px;flex-wrap:wrap;justify-content:flex-end' },
        el('button', { class: 'btn-gold', onclick: onApproveAll },
          '✓✓ อนุมัติทั้งหมด (' + pendingOnly.length + ')'),
        el('button', {
          class: 'btn-ghost',
          style: 'color:var(--danger);border-color:var(--danger)',
          onclick: onRejectAll
        }, '✗✗ ปฏิเสธทั้งหมด (' + pendingOnly.length + ')')
      );
      header.appendChild(btnGroup);
    }
    panel.appendChild(header);

    if (state.pending.length === 0) {
      panel.appendChild(emptyState('', 'ไม่มีคลิปใหม่', 'บอทจะแจ้งเมื่อเจอคลิปใหม่'));
    } else {
      // ✅ NEW: จัดกลุ่มตามช่อง — แต่ละ section มี header (ชื่อช่อง + เพจปลายทาง) + grid
      // เรียงกลุ่ม: pending มากสุด → น้อยสุด, ภายในกลุ่มเรียงตาม detected_at desc (เดิม)
      const groups = groupPendingByChannel(state.pending);
      groups.forEach(g => panel.appendChild(renderChannelGroup(g)));
    }
    return panel;
  }

  // จัดกลุ่ม pending ตามช่อง (watched_id) — เก็บ target_pages ไว้แสดงใน header
  function groupPendingByChannel(items) {
    const map = new Map();
    for (const p of items) {
      const key = p.watched_id || 0;
      if (!map.has(key)) {
        map.set(key, {
          channel_id: p.watched_id,
          channel_label: p.channel_label || '(ไม่ทราบช่อง)',
          target_pages: p.target_pages || [],
          platform: p.platform,
          items: []
        });
      }
      map.get(key).items.push(p);
    }
    // เรียง: pending มากสุดก่อน — กลุ่มที่ต้อง approve ด่วนสุดอยู่บน
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const pendA = a.items.filter(x => x.status === 'pending').length;
      const pendB = b.items.filter(x => x.status === 'pending').length;
      return pendB - pendA;
    });
    return arr;
  }

  function renderChannelGroup(g) {
    const wrap = el('div', { style: 'margin-bottom:18px' });

    // header: ชื่อช่อง + เพจปลายทาง + counts
    const counts = {
      pending: g.items.filter(x => x.status === 'pending').length,
      downloading: g.items.filter(x => x.status === 'downloading').length,
      failed: g.items.filter(x => x.status === 'failed').length
    };
    const head = el('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;' +
             'padding:10px 14px;margin-bottom:10px;' +
             'background:var(--surface-2);border-left:3px solid var(--gold);border-radius:4px;flex-wrap:wrap'
    });
    const left = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      el('span', { style: 'font-size:14px;font-weight:600' }, '📺 ' + g.channel_label),
      el('span', { class: 'badge badge-info', style: 'font-size:10px' },
        g.items.length + ' คลิป'),
      counts.pending > 0
        ? el('span', { class: 'badge badge-gold', style: 'font-size:10px' }, '⏳ รอ ' + counts.pending)
        : null,
      counts.downloading > 0
        ? el('span', { class: 'badge badge-info', style: 'font-size:10px' }, '⏬ โหลด ' + counts.downloading)
        : null,
      counts.failed > 0
        ? el('span', { class: 'badge badge-danger', style: 'font-size:10px' }, '✗ ล้ม ' + counts.failed)
        : null
    );
    head.appendChild(left);

    // เพจปลายทาง — ถ้าหลายเพจ user จะเห็นชัดว่าคลิปจะลงเพจไหนบ้าง
    if (g.target_pages && g.target_pages.length > 0) {
      const pagesWrap = el('div', { style: 'display:flex;align-items:center;gap:5px;flex-wrap:wrap' },
        el('span', { style: 'font-size:11px;color:var(--text-muted)' },
          'ลงเพจ:'),
        ...g.target_pages.map(p =>
          el('span', { class: 'badge badge-gold', style: 'font-size:10px' }, p.name))
      );
      head.appendChild(pagesWrap);
    } else {
      head.appendChild(el('span', { class: 'badge badge-warning', style: 'font-size:10px' },
        '⚠ ยังไม่ผูกเพจ'));
    }
    wrap.appendChild(head);

    // grid ของคลิปในกลุ่ม
    const grid = el('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px'
    });
    g.items.forEach(p => grid.appendChild(renderPendingCard(p)));
    wrap.appendChild(grid);

    return wrap;
  }

  function renderPendingCard(p) {
    const status = p.status || 'pending';
    const borderColor =
      status === 'failed' ? 'var(--danger)'
      : status === 'downloading' ? 'var(--info)'
      : 'var(--border-soft)';

    const card = el('div', {
      class: 'pending-card',
      style: 'background:var(--surface-2);border:1px solid ' + borderColor +
             ';border-radius:var(--radius-md);overflow:hidden;' +
             (status === 'failed' ? 'opacity:.85' : '')
    });

    // thumbnail
    if (p.thumbnail_url) {
      const wrap = el('div', { style: 'width:100%;aspect-ratio:16/9;background:#000;position:relative' });
      const img = el('img', { src: p.thumbnail_url, alt: '',
        style: 'width:100%;height:100%;object-fit:cover' });
      img.onerror = () => { img.style.display = 'none'; };
      wrap.appendChild(img);
      if (p.duration_sec > 0) {
        wrap.appendChild(el('span', {
          style: 'position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.7);color:#fff;padding:2px 6px;font-size:10px;border-radius:2px'
        }, fmtDuration(p.duration_sec)));
      }
      card.appendChild(wrap);
    } else {
      card.appendChild(el('div', {
        style: 'width:100%;aspect-ratio:16/9;background:var(--surface-3);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px'
      }, 'ไม่มีภาพปก'));
    }

    const body = el('div', { class: 'pc-body' });

    // ✅ NEW: title row + "🆕 ใหม่" badge ถ้า detected ภายใน 24 ชม. (1 วัน — user request)
    // คลิปเก่ากว่า 1 วัน → ไม่มี badge (= "เก่า" — เห็นแยกได้ทันที)
    const titleRow = el('div', { style: 'display:flex;align-items:flex-start;gap:8px;margin-bottom:8px' });
    // parse เป็น UTC (consistent กับ backend's toSqlLocal — see fmtRelative comment)
    const detectedAtMs = p.detected_at ? new Date(p.detected_at.replace(' ', 'T') + 'Z').getTime() : 0;
    const ageHrs = detectedAtMs ? (Date.now() - detectedAtMs) / 3600000 : 999;
    const isNew = status === 'pending' && ageHrs < 24;
    if (isNew) {
      titleRow.appendChild(el('span', {
        class: 'badge badge-gold watcher-new-badge',
        style: 'font-size:11px;padding:3px 9px;flex-shrink:0;font-weight:700;letter-spacing:0.5px'
      }, '🆕 ใหม่'));
    }
    titleRow.appendChild(el('div', {
      style: 'font-size:14px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;flex:1'
    }, p.title || p.video_id));
    body.appendChild(titleRow);

    // ✅ NEW: 2 บรรทัด — "ลงเมื่อ" (ช่องลงคลิป) + "เจอเมื่อ" (ระบบเจอ — กันดึงซ้ำ)
    const meta = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.7' });
    // ลงเมื่อ (จาก yt-dlp upload_date — รูปแบบ YYYYMMDD)
    let uploadStr = null;
    if (p.upload_date && /^\d{8}$/.test(p.upload_date)) {
      const y = p.upload_date.slice(0,4), m = p.upload_date.slice(4,6), d = p.upload_date.slice(6,8);
      uploadStr = `${d}/${m}/${y}`;
    }
    meta.appendChild(el('div', {},
      el('span', { style: 'color:var(--text-muted)' }, '📺 ช่อง: '),
      el('strong', { style: 'color:var(--text-secondary)' }, p.channel_label || '-')
    ));
    if (uploadStr) {
      meta.appendChild(el('div', {},
        el('span', { style: 'color:var(--text-muted)' }, '📅 ช่องลงคลิป: '),
        el('strong', { style: 'color:var(--text-secondary)' }, uploadStr)
      ));
    }
    meta.appendChild(el('div', {},
      el('span', { style: 'color:var(--text-muted)' }, '🔍 บอทเจอ: '),
      el('strong', { style: 'color:' + (isNew ? 'var(--gold)' : 'var(--text-secondary)') },
        p.detected_at ? fmtRelative(p.detected_at) : '-')
    ));
    // ✅ NEW: video_id ตัวสั้นๆ — กลัวซ้ำ user ตรวจได้
    if (p.video_id) {
      meta.appendChild(el('div', { style: 'font-family:monospace;font-size:10px;opacity:.6' },
        '🆔 ' + p.video_id
      ));
    }
    body.appendChild(meta);

    if (p.target_pages && p.target_pages.length > 0) {
      const wrap = el('div', { style: 'margin-bottom:10px' });
      wrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:5px' }, 'จะลงเพจ:'));
      const tags = el('div', { style: 'display:flex;flex-wrap:wrap;gap:5px' });
      p.target_pages.forEach(pg => tags.appendChild(el('span', {
        class: 'badge badge-gold', style: 'font-size:11px;padding:4px 10px'
      }, pg.name)));
      wrap.appendChild(tags);
      body.appendChild(wrap);
    }

    if (status === 'pending') {
      body.appendChild(el('div', { class: 'pc-actions' },
        el('button', { class: 'btn-primary',
          onclick: () => onApprove(p) }, '✓ อนุมัติ'),
        el('button', { class: 'btn-ghost',
          onclick: () => onReject(p) }, '✗ ปฏิเสธ'),
        el('a', { href: p.source_url, target: '_blank', rel: 'noreferrer',
          class: 'btn-ghost', style: 'text-decoration:none;display:inline-flex;align-items:center' }, 'ดู')
      ));
    } else if (status === 'downloading') {
      const wrap = el('div');
      wrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;font-weight:500' },
        el('span', { style: 'color:var(--info)' }, '⏬ กำลังดาวน์โหลด...'),
        el('span', { style: 'color:var(--text-secondary)' }, (p.download_progress || 0) + '%')
      ));
      const pct = Math.max(0, Math.min(100, p.download_progress || 0));
      wrap.appendChild(el('div', {
        style: 'width:100%;height:8px;background:var(--surface-3);border-radius:4px;overflow:hidden'
      },
        el('div', {
          style: 'width:' + pct + '%;height:100%;background:linear-gradient(90deg,var(--gold-dark),var(--gold));transition:width .3s'
        })
      ));
      body.appendChild(wrap);
    } else if (status === 'failed') {
      // ซ่อน [NEEDS_YT_LOGIN] prefix — สำหรับเคสนี้ user เห็น modal popup อยู่แล้ว
      // แสดงข้อความสั้นๆ แทน error ดิบของ yt-dlp
      let errText = p.download_error || 'unknown error';
      if (/^\[NEEDS_YT_LOGIN\]/.test(errText)) {
        errText = '🔐 ต้องเข้าสู่ระบบยูทูบก่อน — กด "ตกลง" ในกล่องด้านบน หรือเปิดใหม่ที่ลิงก์';
      }
      body.appendChild(el('div', {
        style: 'font-size:11px;color:var(--danger);margin-bottom:6px;padding:6px;background:rgba(232,123,123,.08);border-radius:2px;max-height:60px;overflow:auto'
      }, '✗ ' + errText));
      body.appendChild(el('div', { class: 'pc-actions' },
        el('button', {
          class: 'btn-ghost', style: 'flex:1;border-color:var(--gold);color:var(--gold)',
          onclick: () => onRetry(p)
        }, '↻ ลองใหม่'),
        el('button', { class: 'btn-ghost',
          onclick: () => onReject(p) }, '✗ ทิ้ง')
      ));
    }
    card.appendChild(body);
    return card;
  }

  function emptyState(_unused, text, sub) {
    return el('div', { style: 'padding:32px;text-align:center;color:var(--text-muted)' },
      el('img', { class: 'empty-illustration', src: './assets/ui/empty-watcher.png', alt: '' }),
      el('div', { style: 'font-size:13px' }, text),
      sub ? el('div', { style: 'font-size:11px;margin-top:6px' }, sub) : null
    );
  }

  // ============================================================
  // Action handlers
  // ============================================================
  async function onCheckNow(id) {
    try {
      const r = await api('/api/watcher/channels/' + id + '/check-now', { method: 'POST' });
      showToast('เช็คแล้ว',
        r.error ? 'ผิดพลาด: ' + r.error : 'เพิ่ม ' + (r.added || 0) + ' คลิป (ข้าม ' + (r.skipped || 0) + ')',
        r.error ? 'danger' : 'success');
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  // reset baseline + ดึงคลิปล่าสุดมา approve — เปิด modal ให้ user เลือกจำนวน (15 / 50 / 100 / ทั้งหมด / กำหนดเอง)
  function onPullOld(ch) {
    showPullOldModal(ch);
  }

  function showPullOldModal(ch) {
    const backdrop = el('div', {
      style: 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:2000;padding:20px;backdrop-filter:blur(4px)',
      onclick: () => backdrop.remove()
    });
    const modal = el('div', {
      class: 'panel',
      style: 'max-width:560px;width:100%;margin:0;padding:28px 32px',
      onclick: (e) => e.stopPropagation()
    });

    let mode = '15';   // '15' | '50' | '100' | 'all' | 'custom'
    let customCount = 30;

    modal.appendChild(el('div', { class: 'panel-header' },
      el('div', {},
        el('div', { class: 'label-jp' }, 'ดึงย้อนหลัง'),
        el('div', { class: 'panel-title' }, '📥 ดึงคลิปเก่าจาก: ' + ch.label),
        el('div', { class: 'panel-subtitle' },
          'ล้างจุดเริ่มต้น → ดึงคลิป N ล่าสุดเข้ารายการรออนุมัติ (กรองตามประเภทที่ตั้งไว้)')
      ),
      el('button', { class: 'btn-ghost', style: 'padding:4px 10px',
        onclick: () => backdrop.remove() }, '✕')
    ));

    // info เตือน
    const ctLabel = contentTypeLabel(ch.content_type);
    modal.appendChild(el('div', {
      style: 'padding:10px 12px;background:var(--surface-2);border-left:3px solid var(--gold);font-size:12px;color:var(--text-muted);margin-bottom:18px;border-radius:4px'
    },
      '⚠ จะดึงเฉพาะคลิปประเภท ',
      el('strong', { style: 'color:var(--gold)' }, ctLabel),
      ' ที่ตั้งไว้ ไม่ดึงข้ามประเภท'
    ));

    // radio options
    const options = [
      { v: '15',  label: '15 คลิป (ค่าเริ่มต้น ปลอดภัย)' },
      { v: '50',  label: '50 คลิป' },
      { v: '100', label: '100 คลิป' },
      { v: 'all', label: 'ทั้งหมด (อาจช้า ขึ้นกับขนาดช่อง)' },
      { v: 'custom', label: 'กำหนดเอง...' }
    ];
    const customInput = el('input', {
      type: 'number', min: '1', max: '500', value: customCount,
      style: 'width:100px;margin-left:30px;display:none',
      oninput: (e) => { customCount = Math.max(1, Math.min(500, Number(e.target.value) || 30)); }
    });
    const optsContainer = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:18px' });
    options.forEach(o => {
      const lbl = el('label', {
        style: 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 10px;background:var(--surface-2);border-radius:4px;font-size:13px;margin:0'
      });
      const r = el('input', { type: 'radio', name: 'pullCount', value: o.v });
      r.checked = (o.v === mode);
      r.style.width = 'auto';
      r.addEventListener('change', () => {
        if (r.checked) {
          mode = o.v;
          customInput.style.display = (mode === 'custom') ? 'inline-block' : 'none';
        }
      });
      lbl.appendChild(r);
      lbl.appendChild(el('span', {}, o.label));
      if (o.v === 'custom') lbl.appendChild(customInput);
      optsContainer.appendChild(lbl);
    });
    modal.appendChild(optsContainer);

    // ✅ NEW: checkbox "รวมคลิปที่เคยปฏิเสธ"
    // ปกติ pending_approvals.source_url = UNIQUE → INSERT OR IGNORE skip คลิปที่เคย reject
    // ติ๊ก → backend ลบ rejected entries ของช่องนี้ก่อน insert ใหม่
    let includeRejected = false;
    const incRejBlock = el('label', {
      style: 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:10px 12px;' +
             'background:var(--surface-2);border-left:3px solid var(--info);border-radius:4px;' +
             'margin-bottom:18px;font-size:13px'
    });
    const incCB = el('input', { type: 'checkbox' });
    incCB.style.width = 'auto';
    incCB.style.marginTop = '2px';
    incCB.addEventListener('change', () => { includeRejected = incCB.checked; });
    incRejBlock.appendChild(incCB);
    incRejBlock.appendChild(el('div', {},
      el('div', { style: 'font-weight:500;margin-bottom:2px' }, '🔄 รวมคลิปที่เคยปฏิเสธไปแล้ว'),
      el('div', { style: 'font-size:11px;color:var(--text-muted);line-height:1.5' },
        'ถ้าติ๊ก: ระบบจะลบประวัติ "ปฏิเสธ" ของช่องนี้ → คลิปเก่าที่เคยกด ✗ จะกลับมาให้อนุมัติใหม่' +
        '  ·  ถ้าไม่ติ๊ก: คลิปที่เคยปฏิเสธจะถูกข้ามถาวร (ค่าเริ่มต้น — ปลอดภัย)')
    ));
    modal.appendChild(incRejBlock);

    // submit
    const submitBtn = el('button', { class: 'btn-primary' }, '📥 ดึงเลย');
    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ กำลังดึง...';
      const fc = mode === 'all' ? 'all'
                : mode === 'custom' ? String(customCount)
                : mode;
      backdrop.remove();
      showToast('กำลังดึง...',
        'ช่อง: ' + ch.label +
        (mode === 'all' ? ' (ทั้งหมด — อาจใช้เวลาหลายนาที)' : ' (' + fc + ' คลิป)') +
        (includeRejected ? ' · รวมคลิปที่เคยปฏิเสธ' : ''),
        'info');
      try {
        const params = 'reset_seen=1&fetch_count=' + encodeURIComponent(fc) +
                       (includeRejected ? '&include_rejected=1' : '');
        const r = await api('/api/watcher/channels/' + ch.id + '/check-now?' + params,
          { method: 'POST' });
        if (r.error) {
          showToast('ดึงไม่สำเร็จ', r.error, 'danger');
        } else {
          showToast('ดึงคลิปแล้ว',
            'เพิ่ม ' + (r.added || 0) + ' คลิป (ข้าม ' + (r.skipped || 0) + ' จากการกรอง)',
            (r.added || 0) > 0 ? 'success' : 'info');
        }
        refresh();
      } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
    });
    modal.appendChild(el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
      el('button', { class: 'btn-ghost', onclick: () => backdrop.remove() }, 'ยกเลิก'),
      submitBtn
    ));

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }
  async function onToggle(ch) {
    try {
      await api('/api/watcher/channels/' + ch.id, {
        method: 'PUT', body: JSON.stringify({ enabled: ch.enabled ? 0 : 1 })
      });
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  async function onDelete(ch) {
    if (!confirm('ลบช่อง "' + ch.label + '"? โฟลเดอร์คลิปที่ดาวน์โหลดแล้วจะยังอยู่')) return;
    try {
      await api('/api/watcher/channels/' + ch.id, { method: 'DELETE' });
      showToast('ลบแล้ว', ch.label, 'success');
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  async function onApprove(p) {
    try {
      await api('/api/watcher/pending/' + p.id + '/approve', { method: 'POST' });
      showToast('อนุมัติแล้ว', 'กำลังดาวน์โหลด: ' + (p.title || p.video_id), 'success');
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  async function onReject(p) {
    try {
      await api('/api/watcher/pending/' + p.id + '/reject', { method: 'POST' });
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  async function onRetry(p) {
    try {
      await api('/api/watcher/pending/' + p.id + '/retry', { method: 'POST' });
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  async function onApproveAll() {
    const pendingOnly = state.pending.filter(p => p.status === 'pending');
    if (pendingOnly.length === 0) return;
    if (!confirm('อนุมัติทั้งหมด ' + pendingOnly.length + ' คลิป?\nทั้งหมดจะถูกดาวน์โหลดและเตรียมลงทุกเพจที่ผูกไว้')) return;
    try {
      const r = await api('/api/watcher/pending/approve-all', { method: 'POST' });
      showToast('อนุมัติทั้งหมด',
        'สำเร็จ ' + r.approved + ' | ข้าม ' + r.skipped,
        r.skipped > 0 ? 'warning' : 'success');
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }
  // ปฏิเสธทุก pending ในรอบเดียว — มี confirm ก่อน (action ทำลายงาน)
  async function onRejectAll() {
    const pendingOnly = state.pending.filter(p => p.status === 'pending');
    if (pendingOnly.length === 0) return;
    if (!confirm('ปฏิเสธทั้งหมด ' + pendingOnly.length + ' คลิป?\n\n' +
                 '⚠ คลิปทั้งหมดจะถูกข้ามถาวร — บอทจะไม่นำกลับมาให้อนุมัติอีก\n' +
                 '(คลิปที่กำลังดาวน์โหลด/ล้มเหลว จะไม่ถูกแตะ)\n\n' +
                 'ยืนยัน?')) return;
    try {
      const r = await api('/api/watcher/pending/reject-all', { method: 'POST' });
      showToast('ปฏิเสธแล้ว',
        'ข้าม ' + (r.rejected || 0) + ' คลิป',
        (r.rejected || 0) > 0 ? 'success' : 'info');
      refresh();
    } catch (e) { showToast('ผิดพลาด', e.message, 'danger'); }
  }

  // ============================================================
  // Modal: Add / Edit channel
  // ============================================================
  function openAddModal() { openChannelModal(null); }
  function openEditModal(ch) { openChannelModal(ch); }

  function openChannelModal(initial) {
    const isEdit = !!initial;
    let label = initial?.label || '';
    let url = initial?.channel_url || '';
    let contentType = initial?.content_type || 'all';
    let interval = initial?.interval_hours ?? 5;
    let minDur = initial?.min_duration_sec ?? 0;
    let maxDur = initial?.max_duration_sec ?? 0;
    let pageIds = initial ? (initial.pages || []).map(p => p.id) : [];
    // ดึงคลิปล่าสุดมา approve เลย (เฉพาะตอนเพิ่มช่องใหม่) — กันผู้ใช้งงว่าทำไมเพิ่มช่องแล้วยังไม่เห็นคลิป
    let pullLatestEnabled = !initial;   // default ON สำหรับ add, OFF สำหรับ edit
    let pullLatestCount = 5;

    const backdrop = el('div', {
      id: 'watcher-overlay-modal',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:2000;padding:20px;backdrop-filter:blur(4px)',
      onclick: () => backdrop.remove()
    });

    const modal = el('div', {
      class: 'panel',
      style: 'max-width:720px;width:100%;max-height:92vh;overflow:auto;margin:0;padding:32px 36px',
      onclick: (e) => e.stopPropagation()
    });

    modal.appendChild(el('div', { class: 'panel-header' },
      el('div', {},
        el('div', { class: 'label-jp' }, isEdit ? 'แก้ไข' : 'เพิ่มใหม่'),
        el('div', { class: 'panel-title' }, isEdit ? 'แก้ไข: ' + initial.label : 'เพิ่มช่องใหม่'),
        el('div', { class: 'panel-subtitle' },
          isEdit ? 'แก้ประเภท / รอบเช็ค / เพจปลายทาง (ลิงก์ช่องเปลี่ยนไม่ได้)'
                 : 'ใส่ลิงก์ช่อง + เลือกเพจ + ประเภทคลิป — บอทตั้งจุดเริ่มต้นแล้วเริ่มตามดูทันที')
      ),
      el('button', { class: 'btn-ghost', style: 'padding:4px 10px',
        onclick: () => backdrop.remove() }, '✕')
    ));

    // Form rendering — re-render whole form on state change
    const formContainer = el('div');
    function renderForm() {
      formContainer.innerHTML = '';

      const platform = detectPlatform(url);

      // Row 1: label + interval
      formContainer.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
        el('div', {},
          el('label', {}, 'ชื่อกำกับ '),
          el('input', { type: 'text', value: label,
            placeholder: 'เช่น ช่องซีรีส์จีน A',
            oninput: (e) => { label = e.target.value; }
          })
        ),
        el('div', {},
          el('label', {}, 'เช็คทุกกี่ชั่วโมง '),
          el('input', { type: 'number', min: '0.5', step: '0.5', value: interval,
            oninput: (e) => { interval = e.target.value; }
          })
        )
      ));

      // URL
      // ✅ FIX IME bug: เดิม oninput เรียก renderForm() ทำลาย DOM ทั้ง form ทุกครั้งที่พิมพ์ url
      // → focus หาย, IME ไทยค้าง, พิมพ์รอบ 2 ในช่องอื่นไม่ติด
      // → ใช้ partial update (อัพเดทแค่ platform badge + helper visibility) แทน
      const platformBadge = el('span', { class: 'badge badge-info', style: 'font-size:10px' },
        PLATFORM_LABEL[platform] || platform);
      const platformHint = el('div', {
        style: 'font-size:11px;color:var(--text-muted);margin-top:4px;display:' + (url ? 'block' : 'none')
      }, 'แพลตฟอร์มที่ตรวจพบ: ', platformBadge);
      const urlBlock = el('div', { style: 'margin-top:12px' },
        el('label', {}, 'ลิงก์ช่อง '),
        el('input', { type: 'url', value: url,
          placeholder: 'https://www.youtube.com/@channel หรือ https://www.tiktok.com/@user',
          disabled: isEdit ? '' : false,
          oninput: (e) => {
            url = e.target.value;
            // partial update — ไม่ destroy DOM
            const newPlatform = detectPlatform(url);
            platformBadge.textContent = PLATFORM_LABEL[newPlatform] || newPlatform;
            platformHint.style.display = url ? 'block' : 'none';
          }
        }),
        platformHint
      );
      formContainer.appendChild(urlBlock);

      // content type
      const sel = el('select', { onchange: (e) => { contentType = e.target.value; } });
      CONTENT_TYPE_OPTIONS.forEach(o => {
        const opt = el('option', { value: o.value }, o.label);
        if (o.value === contentType) opt.selected = true;
        sel.appendChild(opt);
      });
      formContainer.appendChild(el('div', { style: 'margin-top:12px' },
        el('label', {}, 'ประเภทคลิปที่จะดึง '),
        sel,
        el('div', { style: 'font-size:10px;color:var(--text-muted);margin-top:4px' },
          'เลือกประเภทเดียวเพื่อกันบอทดาวน์โหลดคลิปข้ามประเภท')
      ));

      // pages multi-select
      const pagesBlock = el('div', { style: 'margin-top:12px' });
      // ✅ Refresh button — กรณีเพิ่มเพจใหม่ในระบบขณะเปิด modal อยู่
      const labelRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' },
        el('label', { style: 'margin-bottom:0' }, 'เพจปลายทาง  (เลือกได้หลายเพจ)'),
        el('button', {
          type: 'button',
          class: 'btn-ghost',
          style: 'padding:4px 12px;font-size:12px;min-height:28px;font-weight:500',
          onclick: async (e) => {
            e.preventDefault();
            const btn = e.target;
            const orig = btn.textContent;
            btn.textContent = '⏳ กำลังโหลด...';
            btn.disabled = true;
            try {
              const fresh = await api('/api/pages');
              state.pages = fresh;
              // ✅ FIX IME: skip re-render ถ้า user กำลังพิมพ์ — กัน input ใน form ถูก destroy
              // → IME composition ตาย. ถ้า skip จะ render ตอน user หยุดพิมพ์ (focusout/compositionend)
              if (_isUserTyping()) {
                _pendingFormRender = true;
              } else {
                renderForm();
              }
            } catch (err) {
              alert('refresh fail: ' + err.message);
            } finally {
              btn.textContent = orig;
              btn.disabled = false;
            }
          }
        }, '🔄 รีเฟรชรายการเพจ')
      );
      pagesBlock.appendChild(labelRow);
      if (state.pages.length === 0) {
        pagesBlock.appendChild(el('div', {
          style: 'padding:12px;background:var(--surface-2);font-size:12px;color:var(--text-muted)'
        }, 'ยังไม่มีเพจในระบบ — ไปเพิ่มเพจในเมนู "จัดการเฟส + เพจ" ก่อน'));
      } else {
        const grid = el('div', {
          style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;padding:8px;background:var(--surface-2);border-radius:4px;max-height:160px;overflow:auto'
        });
        state.pages.forEach(pg => {
          const checked = pageIds.includes(pg.id);
          const lbl = el('label', {
            style: 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 6px;font-size:12px;margin-bottom:0;border-radius:2px;' +
                   (checked ? 'background:var(--surface-active)' : '')
          });
          const cb = el('input', { type: 'checkbox' });
          cb.checked = checked;
          cb.style.width = 'auto';
          // ✅ FIX: don't re-render whole form on checkbox change — เดิม renderForm()
          // ทำลายทุก <input> รวมทั้ง label/url ที่ user กำลังพิมพ์ → IME composition (ไทย/ญี่ปุ่น)
          // หาย, focus หาย. แค่ toggle background + update count text + array
          cb.addEventListener('change', () => {
            if (cb.checked && !pageIds.includes(pg.id)) pageIds.push(pg.id);
            else if (!cb.checked) pageIds = pageIds.filter(x => x !== pg.id);
            // visual update
            lbl.style.background = cb.checked ? 'var(--surface-active)' : '';
            // update count text
            const countText = pagesBlock.querySelector('.watcher-page-count');
            if (countText) countText.textContent = 'เลือก ' + pageIds.length + ' เพจ — คลิปใหม่จะถูกเตรียมลงทุกเพจที่เลือกไว้';
          });
          lbl.appendChild(cb);
          lbl.appendChild(el('span', { style: 'flex:1' }, pg.name));
          grid.appendChild(lbl);
        });
        pagesBlock.appendChild(grid);
      }
      pagesBlock.appendChild(el('div', {
        class: 'watcher-page-count',
        style: 'font-size:10px;color:var(--text-muted);margin-top:4px'
      }, 'เลือก ' + pageIds.length + ' เพจ — คลิปใหม่จะถูกเตรียมลงทุกเพจที่เลือกไว้'));
      formContainer.appendChild(pagesBlock);

      // advanced
      const det = el('details', { style: 'margin-top:12px' });
      det.appendChild(el('summary', {
        style: 'font-size:12px;color:var(--text-secondary);cursor:pointer'
      }, 'ตั้งค่าขั้นสูง (กรองความยาวคลิป)'));
      det.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px' },
        el('div', {},
          el('label', {}, 'ความยาวขั้นต่ำ (วินาที, 0 = ไม่จำกัด)'),
          el('input', { type: 'number', min: '0', value: minDur,
            oninput: (e) => { minDur = e.target.value; } })
        ),
        el('div', {},
          el('label', {}, 'ความยาวสูงสุด (วินาที, 0 = ไม่จำกัด)'),
          el('input', { type: 'number', min: '0', value: maxDur,
            oninput: (e) => { maxDur = e.target.value; } })
        )
      ));
      formContainer.appendChild(det);

      // ดึงคลิปล่าสุดมา Approve (เฉพาะตอนเพิ่มใหม่)
      if (!isEdit) {
        const pullSection = el('div', {
          style: 'margin-top:14px;padding:12px 14px;background:var(--surface-2);border-radius:4px;border-left:3px solid var(--gold)'
        });
        const pullCB = el('input', { type: 'checkbox' });
        pullCB.checked = pullLatestEnabled;
        pullCB.style.width = 'auto';
        const pullCountInput = el('input', {
          type: 'number', min: '1', max: '20', value: pullLatestCount,
          style: 'width:70px',
          oninput: (e) => {
            pullLatestCount = Math.max(1, Math.min(20, Number(e.target.value) || 5));
          }
        });
        pullCountInput.disabled = !pullLatestEnabled;
        pullCountInput.style.opacity = pullLatestEnabled ? '1' : '0.4';
        pullCB.addEventListener('change', () => {
          pullLatestEnabled = pullCB.checked;
          pullCountInput.disabled = !pullLatestEnabled;
          pullCountInput.style.opacity = pullLatestEnabled ? '1' : '0.4';
        });
        const pullLabel = el('label', {
          style: 'display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:0;font-size:13px;font-weight:500'
        });
        pullLabel.appendChild(pullCB);
        pullLabel.appendChild(el('span', {}, '📥 ดึงคลิปล่าสุดมารออนุมัติเลย'));
        pullSection.appendChild(pullLabel);
        pullSection.appendChild(el('div', {
          style: 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);padding-left:24px;margin-top:6px'
        }, 'จำนวน', pullCountInput, 'คลิป (1–20)'));
        pullSection.appendChild(el('div', {
          style: 'font-size:11px;color:var(--text-muted);margin-top:6px;padding-left:24px'
        }, 'ถ้าไม่ติ๊ก: บอทจะตั้งจุดเริ่มต้นเฉยๆ → เห็นเฉพาะคลิปใหม่ที่อัพหลังจากเพิ่มช่อง'));
        formContainer.appendChild(pullSection);
      }

      // buttons
      const cancelBtn = el('button', { class: 'btn-ghost', onclick: () => backdrop.remove() }, 'ยกเลิก');
      const submitBtn = el('button', { class: 'btn-primary' }, isEdit ? '✓ บันทึก' : (pullLatestEnabled ? '＋ เพิ่ม + ดึงคลิปล่าสุด' : '＋ เพิ่ม + ตั้งจุดเริ่มต้น'));
      submitBtn.addEventListener('click', async () => {
        if (!label.trim()) return alert('ใส่ชื่อกำกับช่อง');
        if (!url.trim()) return alert('ใส่ลิงก์ช่อง');
        if (pageIds.length === 0) return alert('เลือกเพจปลายทางอย่างน้อย 1 เพจ');
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ กำลังบันทึก...';
        const data = {
          label: label.trim(),
          channel_url: url.trim(),
          target_page_ids: pageIds,
          content_type: contentType,
          interval_hours: Number(interval),
          min_duration_sec: Number(minDur),
          max_duration_sec: Number(maxDur),
          pull_latest: !isEdit && pullLatestEnabled ? pullLatestCount : 0
        };
        try {
          if (isEdit) {
            const { channel_url, pull_latest, ...patch } = data;
            await api('/api/watcher/channels/' + initial.id, { method: 'PUT', body: JSON.stringify(patch) });
            showToast('บันทึกแล้ว', '', 'success');
          } else {
            await api('/api/watcher/channels', { method: 'POST', body: JSON.stringify(data) });
            const msg = data.pull_latest > 0
              ? `กำลังดึง ${data.pull_latest} คลิปล่าสุด → ดูในรายการรออนุมัติ`
              : 'ตั้งจุดเริ่มต้นเรียบร้อย — บอทจะตามดูคลิปใหม่ที่อัพหลังจากนี้';
            showToast('เพิ่มช่องแล้ว', msg, 'success');
          }
          backdrop.remove();
          refresh();
        } catch (e) {
          showToast(isEdit ? 'บันทึกไม่สำเร็จ' : 'เพิ่มไม่สำเร็จ', e.message, 'danger');
          submitBtn.disabled = false;
          submitBtn.textContent = isEdit ? '✓ บันทึก' : (pullLatestEnabled ? '＋ เพิ่ม + ดึงคลิปล่าสุด' : '＋ เพิ่ม + ตั้งจุดเริ่มต้น');
        }
      });
      formContainer.appendChild(el('div',
        { style: 'display:flex;gap:8px;margin-top:20px;justify-content:flex-end' },
        cancelBtn, submitBtn));
    }
    renderForm();
    modal.appendChild(formContainer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // ✅ FIX IME: register form-render callback so deferred renders (refresh-pages
    // button while user typing) can flush when composition ends. Clear when modal closes.
    _currentFormRender = renderForm;
    const _origRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = function () {
      _currentFormRender = null;
      _pendingFormRender = false;
      _origRemove();
    };
  }

  // ============================================================
  // Detect React menu clicks → deactivate my view
  // ✅ FIX: ใช้ event delegation บน document — เดิม listener attach กับ sidebar
  // เฉพาะตัว ถ้า React replace sidebar (full re-mount) listener หาย
  // ============================================================
  let _navListenerAttached = false;
  function setupNavClickListener() {
    if (_navListenerAttached) return;
    _navListenerAttached = true;
    document.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item) return;
      // ไม่ใช่ของเรา → ปิด overlay
      if (!item.dataset.watcherInject) {
        deactivateMyView();
      }
    }, true);  // capture phase — ก่อน React handlers
  }

  // ============================================================
  // BOOTSTRAP
  // ============================================================
  let _observer = null;
  let _retryProbeTimer = null;

  // ✅ FIX: scope observer เฉพาะ .app-sidebar เมื่อมัน mount
  // (เดิม subtree:true บน #root → fire ทุก keystroke / animation = CPU drain)
  function startSidebarObserver() {
    if (_observer) return;
    const sidebar = document.querySelector('.app-sidebar');
    if (!sidebar) {
      // sidebar ยังไม่ mount → ลองใหม่ในอีก 200ms
      setTimeout(startSidebarObserver, 200);
      return;
    }
    // debounce: รวม mutation บ่อยๆ ใน 1 frame เป็น 1 callback
    let pending = false;
    _observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        injectNavItem();
      });
    });
    _observer.observe(sidebar, { childList: true });   // ✅ scope: just .app-sidebar children
    injectNavItem();   // initial
  }

  async function boot() {
    backendOk = await probeBackend();
    if (!backendOk) {
      console.warn('[watcher-injection] backend ไม่พร้อม — จะลองใหม่ใน 5 วิ');
      // ✅ FIX: retry probe — เดิม fail แล้วเลิกถาวร (race ตอน backend boot ช้า)
      _retryProbeTimer = setTimeout(boot, 5000);
      return;
    }
    if (_retryProbeTimer) { clearTimeout(_retryProbeTimer); _retryProbeTimer = null; }
    console.log('[watcher-injection] backend พร้อม — inject เมนู');

    _attachImeListeners();        // ✅ FIX IME: ติดตาม composition start/end + focus ทั่ว document
    setupNavClickListener();
    startBackgroundBadgePoll();
    startSidebarObserver();

    // ถ้า .app-sidebar ยังไม่ mount ให้รอแล้วค่อย start observer
    // (boot อาจถูกเรียกก่อน React render เสร็จ)
    if (!document.querySelector('.app-sidebar')) {
      // ใช้ #root observer ระยะสั้นๆ จนกว่า sidebar จะ mount
      const rootObs = new MutationObserver(() => {
        if (document.querySelector('.app-sidebar')) {
          rootObs.disconnect();
          startSidebarObserver();
        }
      });
      rootObs.observe(document.getElementById('root') || document.body,
                      { childList: true, subtree: true });
      // safety: disconnect after 30s ไม่ว่าจะเจอหรือไม่
      setTimeout(() => rootObs.disconnect(), 30000);
    }
  }

  // ✅ FIX: cleanup on page unload — กัน timer/observer leak ตอน Electron reload
  window.addEventListener('pagehide', () => {
    if (_observer) { _observer.disconnect(); _observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (bgBadgeTimer) { clearInterval(bgBadgeTimer); bgBadgeTimer = null; }
    if (_retryProbeTimer) { clearTimeout(_retryProbeTimer); _retryProbeTimer = null; }
    if (_overlayPositionTimer) { clearInterval(_overlayPositionTimer); _overlayPositionTimer = null; }
  });

  // รอ DOM พร้อมแล้วค่อย boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
