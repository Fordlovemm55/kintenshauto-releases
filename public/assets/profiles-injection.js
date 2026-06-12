/**
 * Profiles Manager — UI injection (vanilla JS) — multi-platform
 *
 * วิธีทำงาน:
 *  - ไม่แตะ React bundle ของหลัก
 *  - ดูเมนู "จัดการบัญชี" ที่ React render ไว้ → bind click → show overlay ทับ .app-main
 *  - คลิกเมนู React อื่นๆ → ซ่อน overlay
 *  - 3 Tab: เฟซบุ๊ก (เดิม) / เอกซ์ (ทวิตเตอร์) / อินสตาแกรม — Chrome user-data-dir แยกชัดเจน
 *  - ใช้ CSS class เดิมของระบบ (.panel, .btn-primary, .badge ฯลฯ)
 */
(function () {
  'use strict';

  const API = (typeof window !== 'undefined' && (
    (window.kintenshauto && window.kintenshauto.apiBase) ||
    window.__KINTENSHAUTO_API__
  )) || 'http://localhost:3003';

  const NAV_TH = 'จัดการบัญชี';   // React nav text — ใช้จับเมนูนี้
  const TABS = [
    { key: 'facebook',  label: 'เฟซบุ๊ก',          icon: '◈' },
    { key: 'x',         label: 'เอกซ์ (ทวิตเตอร์)', icon: '✕' },
    { key: 'instagram', label: 'อินสตาแกรม',       icon: '◉' }
  ];

  let overlay = null;
  let _overlayMain = null;
  let _overlayPositionTimer = null;
  let myActive = false;
  let activeTab = 'facebook';
  let backendOk = false;
  let state = { profiles: [], pages: [] };

  // ============================================================
  // ✅ IME FREEZE FIX (universal): user-typing guard
  // Same pattern as watcher-injection.js — skip render ถ้า user กำลังพิมพ์ใน
  // input ของเรา (overlay หรือ modal). หลัง composition end / focus out → flush.
  // ============================================================
  let _imeComposing = false;
  let _pendingRender = false;
  let _imeListenersAttached = false;

  function _isUserTyping() {
    if (_imeComposing) return true;
    const ae = document.activeElement;
    if (!ae) return false;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false;
    if (overlay && overlay.contains(ae)) return true;
    const modal = document.getElementById('profiles-overlay-modal');
    if (modal && modal.contains(ae)) return true;
    return false;
  }

  function _attachImeListeners() {
    if (_imeListenersAttached) return;
    _imeListenersAttached = true;
    document.addEventListener('compositionstart', () => { _imeComposing = true; }, true);
    document.addEventListener('compositionend', () => {
      _imeComposing = false;
      setTimeout(_flushPendingRender, 50);
    }, true);
    document.addEventListener('focusout', () => {
      setTimeout(_flushPendingRender, 100);
    }, true);
  }

  function _flushPendingRender() {
    if (!_pendingRender) return;
    if (_isUserTyping()) return;
    _pendingRender = false;
    if (myActive && overlay && overlay.style.display === 'block') {
      const sy = overlay.scrollTop;
      renderRoot();
      overlay.scrollTop = sy;
    }
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

  async function probeBackend() {
    try {
      const r = await fetch(API + '/api/profiles');
      return r.ok;
    } catch { return false; }
  }

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
  // STYLES
  // ============================================================
  function injectStyles() {
    if (document.getElementById('profiles-injection-styles')) return;
    const s = document.createElement('style');
    s.id = 'profiles-injection-styles';
    s.textContent = `
      #profiles-overlay .panel { padding: 24px 28px; margin-bottom: 20px; }
      #profiles-overlay .panel-header { gap: 14px; padding-bottom: 16px; margin-bottom: 20px; }
      #profiles-overlay .panel-title { font-size: 20px; font-weight: 600; }
      #profiles-overlay .panel-subtitle { font-size: 13px; line-height: 1.6; }

      #profiles-overlay .tabs {
        display: flex; gap: 4px; margin-bottom: 24px;
        border-bottom: 1px solid var(--border-soft);
      }
      #profiles-overlay .tab {
        padding: 12px 22px;
        cursor: pointer;
        font-size: 14px;
        color: var(--text-secondary);
        border-bottom: 3px solid transparent;
        margin-bottom: -1px;
        transition: all 0.15s ease;
        display: flex; align-items: center; gap: 8px;
        background: transparent;
        border-radius: 0;
      }
      #profiles-overlay .tab .tab-icon { font-size: 16px; opacity: 0.7; }
      #profiles-overlay .tab .tab-jp {
        font-size: 11px;
        color: var(--text-muted);
        letter-spacing: 2px;
        margin-left: 4px;
      }
      #profiles-overlay .tab:hover { color: var(--text-primary); }
      #profiles-overlay .tab.active {
        color: var(--gold);
        border-bottom-color: var(--gold);
        font-weight: 600;
      }
      #profiles-overlay .tab.active .tab-icon { opacity: 1; }

      #profiles-overlay .platform-badge {
        display: inline-block;
        padding: 3px 10px;
        font-size: 11px;
        border-radius: 12px;
        background: rgba(212, 175, 55, 0.12);
        border: 1px solid var(--gold);
        color: var(--gold);
        margin-left: 8px;
      }
      #profiles-overlay .platform-badge.facebook { background: rgba(56, 96, 180, 0.15); border-color: #3860b4; color: #6e8fd4; }
      #profiles-overlay .platform-badge.x { background: rgba(140, 140, 140, 0.15); border-color: #888; color: #ccc; }
      #profiles-overlay .platform-badge.instagram { background: rgba(220, 100, 150, 0.12); border-color: #d4639a; color: #e08bb1; }

      #profiles-overlay .profile-card {
        background: var(--surface-2);
        border: 0.5px solid var(--border-soft);
        border-radius: var(--radius-md);
        padding: 16px;
        margin-bottom: 12px;
      }
      #profiles-overlay .profile-card .pc-title { font-size: 15px; font-weight: 500; margin-bottom: 4px; }
      #profiles-overlay .profile-card .pc-meta { font-size: 11px; color: var(--text-muted); margin-bottom: 12px; }
      #profiles-overlay .profile-card .pc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      #profiles-overlay .profile-card .pc-actions button {
        padding: 8px 14px;
        font-size: 12px;
        min-height: 34px;
      }
      #profiles-overlay .profile-card .pc-status {
        display: inline-block;
        margin-left: 8px;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
      }
      #profiles-overlay .pc-status.idle      { background: rgba(140,140,140,.12); color: #999; }
      #profiles-overlay .pc-status.active    { background: rgba(120,180,120,.15); color: #8fb88f; }
      #profiles-overlay .pc-status.checkpoint { background: rgba(220,160,80,.15); color: #d4a350; }
      #profiles-overlay .pc-status.blocked   { background: rgba(220,100,100,.15); color: #d46868; }

      #profiles-overlay .pages-list {
        margin-top: 8px;
        padding: 8px 10px;
        background: var(--surface-3);
        border-radius: 4px;
        font-size: 11px;
      }
      #profiles-overlay .pages-list .pages-label {
        color: var(--text-muted);
        margin-bottom: 6px;
        font-size: 10px;
        letter-spacing: 1px;
      }
      #profiles-overlay .pages-list .page-pill {
        display: inline-block;
        padding: 2px 8px;
        background: rgba(212, 175, 55, 0.1);
        border: 1px solid rgba(212, 175, 55, 0.3);
        color: var(--gold);
        border-radius: 10px;
        font-size: 10px;
        margin: 2px 3px 2px 0;
      }

      #profiles-overlay form input,
      #profiles-overlay form select,
      #profiles-overlay form textarea {
        font-size: 13px !important;
        padding: 10px 12px !important;
      }
      #profiles-overlay form label {
        font-size: 12px;
        margin-bottom: 6px;
        font-weight: 500;
      }
      #profiles-overlay form button[type="submit"],
      #profiles-overlay form button.btn-primary,
      #profiles-overlay form button.btn-ghost {
        padding: 10px 18px !important;
        font-size: 13px !important;
        min-height: 38px;
      }

      #profiles-overlay-modal {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        z-index: 200; padding: 20px;
      }
      #profiles-overlay-modal .modal-panel {
        background: var(--surface-1);
        border: 0.5px solid var(--border-soft);
        border-radius: var(--radius-md);
        max-width: 560px; width: 100%;
        max-height: 90vh; overflow: auto;
        padding: 24px 28px;
      }

      #profiles-overlay .empty-state {
        padding: 36px;
        text-align: center;
        color: var(--text-muted);
      }
      #profiles-overlay .empty-state .empty-illustration {
        width: 96px;
        height: 96px;
        object-fit: contain;
        opacity: 0.5;
        margin-bottom: 10px;
      }
      #profiles-overlay .empty-state .text { font-size: 14px; margin-bottom: 4px; }
      #profiles-overlay .empty-state .sub { font-size: 11px; }

      #profiles-overlay .platform-help {
        padding: 12px 14px;
        background: rgba(212, 175, 55, 0.06);
        border-left: 3px solid var(--gold);
        font-size: 12px;
        line-height: 1.6;
        margin-bottom: 16px;
        border-radius: 0 4px 4px 0;
      }
      #profiles-overlay .platform-help b { color: var(--gold); }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  // OVERLAY POSITIONING
  // ============================================================
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
    overlay.id = 'profiles-overlay';
    overlay.style.cssText =
      'position:fixed;z-index:100;' +
      'background:linear-gradient(160deg,#fbeaf6 0%,#f3e6fb 45%,#ece2fb 100%);' +
      'overflow-y:auto;padding:28px 36px;display:none;' +
      'box-shadow:inset 0 0 60px rgba(0,0,0,.5)';
    document.body.appendChild(overlay);

    window.addEventListener('resize', updateOverlayPosition);
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
    updateOverlayPosition();
    if (_overlayPositionTimer) clearInterval(_overlayPositionTimer);
    _overlayPositionTimer = setInterval(updateOverlayPosition, 500);
    refresh();
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (_overlayPositionTimer) {
      clearInterval(_overlayPositionTimer);
      _overlayPositionTimer = null;
    }
  }

  function activateMyView() {
    myActive = true;
    showOverlay();
  }

  function deactivateMyView() {
    myActive = false;
    hideOverlay();
  }

  // ============================================================
  // DOM helpers
  // ============================================================
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'style') e.style.cssText = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (k === 'dataset') {
          for (const dk of Object.keys(attrs[k])) e.dataset[dk] = attrs[k][dk];
        } else {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        e.appendChild(document.createTextNode(String(c)));
      } else if (Array.isArray(c)) {
        for (const cc of c) {
          if (cc == null || cc === false) continue;
          e.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc);
        }
      } else {
        e.appendChild(c);
      }
    }
    return e;
  }

  // ============================================================
  // STATE / REFRESH
  // ============================================================
  async function refresh() {
    try {
      const [profiles, pages] = await Promise.all([
        api('/api/profiles').catch(() => []),
        api('/api/pages').catch(() => [])
      ]);
      state = { profiles, pages };
      if (myActive && overlay && overlay.style.display === 'block') {
        // ✅ FIX IME: defer render ถ้า user กำลังพิมพ์ใน input ของ overlay/modal
        // กัน DOM input ถูก destroy ระหว่าง IME composition → ค้างจนต้องกด PrtSc
        if (_isUserTyping()) {
          _pendingRender = true;
        } else {
          renderRoot();
        }
      }
    } catch (e) {
      console.warn('[profiles-injection] refresh failed:', e.message);
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderRoot() {
    if (!overlay) return;
    overlay.innerHTML = '';

    // Header
    const header = el('div', { class: 'panel-header', style: 'margin-bottom:18px;border-bottom:1px solid var(--border-soft);padding-bottom:14px' },
      el('div', null,
        el('div', { class: 'label-jp' }, 'บัญชี'),
        el('div', { class: 'panel-title' }, 'จัดการบัญชี'),
        el('div', { class: 'panel-subtitle' },
          'จัดการบัญชีเฟซบุ๊ก · เอกซ์ (ทวิตเตอร์) · อินสตาแกรม — แต่ละบัญชีใช้โปรไฟล์โครมแยกกันเด็ดขาด')
      )
    );
    overlay.appendChild(header);

    // Tabs
    const tabBar = el('div', { class: 'tabs' });
    for (const t of TABS) {
      const tabEl = el('div', {
        class: 'tab' + (activeTab === t.key ? ' active' : ''),
        onclick: () => { activeTab = t.key; renderRoot(); }
      },
        el('span', { class: 'tab-icon' }, t.icon),
        el('span', null, t.label)
      );
      tabBar.appendChild(tabEl);
    }
    overlay.appendChild(tabBar);

    // Tab content
    overlay.appendChild(renderTabContent());
  }

  // --- Bulk Thai proxy pool panel -------------------------------------------
  function renderProxyPoolPanel(container) {
    const box = el('div', { class: 'panel', style: 'margin:14px 0;padding:14px' },
      el('h3', {}, 'พร็อกซี่ไทย (วางทีละหลายตัว)'),
      el('p', { style: 'font-size:12px;color:#9a7fb3' },
        'วางพร็อกซี่บรรทัดละ 1 ตัว — host:port หรือ host:port:user:pass หรือ user:pass@host:port'),
      el('textarea', { id: 'proxyPoolText', rows: '8',
        style: 'width:100%;font-family:monospace;font-size:13px',
        placeholder: '1.2.3.4:8080\n5.6.7.8:1080:user:pass' }),
      el('div', { style: 'margin-top:10px;display:flex;gap:8px' },
        el('button', { class: 'btn-secondary', id: 'proxyTestBtn' }, 'ทดสอบพร็อกซี่'),
        el('button', { class: 'btn-primary', id: 'proxyDistributeBtn' }, 'กระจายใส่เฟส'),
      ),
      el('div', { id: 'proxyPoolResult', style: 'margin-top:12px;font-size:14px' }),
    );
    container.appendChild(box);

    box.querySelector('#proxyTestBtn').addEventListener('click', async () => {
      const text = box.querySelector('#proxyPoolText').value;
      const out = box.querySelector('#proxyPoolResult');
      out.textContent = 'กำลังทดสอบ...';
      try {
        const r = await fetch(API + '/api/proxies/test', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }).then(x => x.json());
        out.innerHTML = '';
        r.results.forEach(t => {
          const ok = t.alive && t.isThai;
          out.appendChild(el('div', { style: `color:${ok ? '#2e7d32' : '#c62828'}` },
            `${ok ? '✅' : '❌'} ${t.host}:${t.port} — ${t.alive ? (t.country || '?') : 'ตาย'}${t.alive && !t.isThai ? ' (ไม่ใช่ไทย)' : ''}`));
        });
      } catch (e) { out.textContent = 'ผิดพลาด: ' + e.message; }
    });

    box.querySelector('#proxyDistributeBtn').addEventListener('click', async () => {
      const text = box.querySelector('#proxyPoolText').value;
      const out = box.querySelector('#proxyPoolResult');
      out.textContent = 'กำลังกระจาย...';
      try {
        const r = await fetch(API + '/api/proxies/distribute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, onlyMissing: true }),
        }).then(x => x.json());
        const parts = [
          `ใส่ครบ ${r.assigned} เฟส`,
          r.shortBy ? `ขาดอีก ${r.shortBy} พร็อกซี่` : null,
          r.leftover ? `เหลือไม่ได้ใช้ ${r.leftover}` : null,
          (r.invalid && r.invalid.length) ? `บรรทัดผิดรูปแบบ ${r.invalid.length}` : null,
        ].filter(Boolean);
        out.innerHTML = '';
        out.appendChild(el('div', { style: 'color:#2e7d32;font-weight:600' }, '✅ ' + parts.join(' · ')));
        if (r.uncovered && r.uncovered.length) {
          out.appendChild(el('div', { style: 'color:#c62828;margin-top:6px' },
            'เฟสที่ยังไม่มีพร็อกซี่ (id): ' + r.uncovered.join(', ')));
        }
      } catch (e) {
        out.textContent = 'ผิดพลาด: ' + e.message;
      }
    });
  }

  function renderTabContent() {
    const platformProfiles = state.profiles.filter(p => (p.platform || 'facebook') === activeTab);
    const container = el('div', null);

    // Platform-specific help
    const help = el('div', { class: 'platform-help' });
    if (activeTab === 'facebook') {
      help.innerHTML = '<b>เฟซบุ๊ก</b> — ใช้สำหรับโพสต์รีลส์อัตโนมัติบนเพจที่ผูกไว้ · กรอกอีเมล/รหัสผ่านเฟซบุ๊ก · เข้าสู่ระบบผ่านโครมแล้วกด <i>ดึงรายชื่อเพจ</i> เพื่อดึงรายชื่อเพจมาผูกอัตโนมัติ';
    } else if (activeTab === 'x') {
      help.innerHTML = '<b>เอกซ์ (ทวิตเตอร์)</b> — ใช้สำหรับ <i>ตามช่อง</i> ดึงคลิปจากโปรไฟล์อื่น · ต้องเข้าสู่ระบบด้วยบัญชีเอกซ์จริง (จะใช้บัญชีสำรองก็ได้) เพราะเอกซ์บล็อกการดูแบบไม่เข้าสู่ระบบ · โฟลเดอร์ข้อมูลผู้ใช้ของโครมแยกจากเฟซบุ๊กโดยสิ้นเชิง';
    } else if (activeTab === 'instagram') {
      help.innerHTML = '<b>อินสตาแกรม</b> — ใช้สำหรับ <i>ตามช่อง</i> ดึงคลิปรีลส์จากโปรไฟล์อื่น · ต้องเข้าสู่ระบบด้วยบัญชีอินสตาแกรมจริง · โฟลเดอร์ข้อมูลผู้ใช้ของโครมแยกจากเฟซบุ๊ก/เอกซ์ เพื่อกันคุกกี้ปนกัน';
    }
    container.appendChild(help);

    // Add button
    const addBtn = el('button', {
      class: 'btn-primary',
      style: 'margin-bottom:16px',
      onclick: () => openAddModal(activeTab)
    }, '+ เพิ่มบัญชี ' + TABS.find(t => t.key === activeTab).label);
    container.appendChild(addBtn);

    // Profile list
    if (platformProfiles.length === 0) {
      container.appendChild(el('div', { class: 'empty-state' },
        el('img', { class: 'empty-illustration', src: './assets/ui/empty-generic.png', alt: '' }),
        el('div', { class: 'text' }, 'ยังไม่มีบัญชีในกลุ่มนี้'),
        el('div', { class: 'sub' }, 'กดปุ่ม "+ เพิ่มบัญชี" ด้านบนเพื่อเริ่ม')
      ));
    } else {
      for (const p of platformProfiles) {
        container.appendChild(renderProfileCard(p));
      }
    }

    // Bulk proxy panel — Facebook tab only (Thai proxies are used for FB posting)
    if (activeTab === 'facebook') {
      renderProxyPoolPanel(container);
    }

    return container;
  }

  function renderProfileCard(profile) {
    const platform = profile.platform || 'facebook';
    const card = el('div', { class: 'profile-card' });

    // Title row
    const titleRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px' },
      el('div', null,
        el('div', { class: 'pc-title' },
          profile.name,
          el('span', { class: 'platform-badge ' + platform }, TABS.find(t => t.key === platform)?.label || platform),
          el('span', { class: 'pc-status ' + (profile.status || 'idle') }, profile.status || 'idle')
        ),
        el('div', { class: 'pc-meta' },
          platform === 'facebook'
            ? ('เฟซบุ๊ก: ' + (profile.fb_username || '-'))
            : ('บัญชี: ' + (profile.account_handle || '-')),
          profile.last_login_at ? ' · เข้าสู่ระบบล่าสุด: ' + profile.last_login_at.replace('T', ' ').slice(0, 16) : ' · ยังไม่เคยเข้าสู่ระบบ'
        )
      )
    );
    card.appendChild(titleRow);

    // Pages list (FB only)
    if (platform === 'facebook') {
      const pagesForProfile = (state.pages || []).filter(pg => pg.profile_id === profile.id);
      if (pagesForProfile.length > 0) {
        const pagesList = el('div', { class: 'pages-list' });
        pagesList.appendChild(el('div', { class: 'pages-label' }, 'เพจในบัญชีนี้ (' + pagesForProfile.length + '):'));
        for (const pg of pagesForProfile) {
          pagesList.appendChild(el('span', { class: 'page-pill' }, pg.name));
        }
        card.appendChild(pagesList);
      }
    }

    // Actions
    const actions = el('div', { class: 'pc-actions' });

    // FB profiles with stored credentials get an "Auto-login" primary action.
    // Other platforms (X / IG / FB without credentials) fall back to the
    // plain "Open Chrome" path that requires the user to type manually.
    if (platform === 'facebook' && profile.fb_username) {
      actions.appendChild(el('button', {
        class: 'btn-primary',
        onclick: () => onAutoLogin(profile)
      }, '⚡ เข้าสู่ระบบอัตโนมัติ'));
      actions.appendChild(el('button', {
        class: 'btn-ghost',
        onclick: () => onLoginChrome(profile)
      }, '🌐 เปิดโครม'));
    } else {
      actions.appendChild(el('button', {
        class: 'btn-primary',
        onclick: () => onLoginChrome(profile)
      }, '🌐 เปิดโครมเพื่อเข้าสู่ระบบ'));
    }

    actions.appendChild(el('button', {
      class: 'btn-ghost',
      onclick: () => onSyncCookies(profile)
    }, '🔄 ซิงก์คุกกี้'));

    if (platform === 'facebook') {
      actions.appendChild(el('button', {
        class: 'btn-ghost',
        onclick: () => onFetchPages(profile)
      }, '📋 ดึงรายชื่อเพจ'));
    }

    actions.appendChild(el('button', {
      class: 'btn-ghost',
      onclick: () => onCloseBrowser(profile)
    }, '✕ ปิดโครม'));

    // Per-account IP leak-test button: only shown for Facebook profiles that have
    // a proxy assigned. Calls GET /api/proxies/leak-test/<accountId> and shows
    // whether the browser will appear as a Thai IP to Facebook.
    if (platform === 'facebook' && profile.proxy_host) {
      const leakBtn = el('button', { class: 'btn-secondary', style: 'font-size:12px' }, 'ตรวจ IP');
      leakBtn.addEventListener('click', async () => {
        leakBtn.textContent = 'กำลังตรวจ...';
        try {
          const r = await fetch(API + '/api/proxies/leak-test/' + profile.id).then(x => x.json());
          leakBtn.textContent = (r.ok && r.isThai && r.hidesVpn)
            ? `🟢 ${r.browserCountry} (${r.browserIp})`
            : `🔴 ${r.reason || r.browserCountry || 'รั่ว/ไม่ใช่ไทย'}`;
        } catch (e) { leakBtn.textContent = '🔴 error'; }
      });
      actions.appendChild(leakBtn);
    }

    actions.appendChild(el('button', {
      class: 'btn-danger',
      style: 'margin-left:auto',
      onclick: () => onDeleteProfile(profile)
    }, 'ลบบัญชี'));

    card.appendChild(actions);
    return card;
  }

  // ============================================================
  // ACTIONS
  // ============================================================
  async function onLoginChrome(profile) {
    try {
      const r = await api(`/api/profiles/${profile.id}/login-chrome`, { method: 'POST' });
      showToast('เปิดโครมแล้ว', r.message || 'เข้าสู่ระบบในโครม → ปิดโครมเองหลังเสร็จ', 'success');
    } catch (e) {
      showToast('ผิดพลาด', e.message, 'danger');
    }
  }

  // Puppeteer-controlled FB login: opens Chrome, autofills email + password,
  // clicks Login. Returns immediately — actual fill runs in the background.
  // 2FA / device confirmation pages are left for the user to complete.
  async function onAutoLogin(profile) {
    try {
      const r = await api(`/api/profiles/${profile.id}/auto-login`, { method: 'POST' });
      showToast('เข้าสู่ระบบอัตโนมัติ', r.message || 'กำลังเปิดโครม + กรอกรหัสให้...', 'info');
    } catch (e) {
      showToast('เข้าสู่ระบบอัตโนมัติไม่สำเร็จ', e.message, 'danger');
    }
  }

  async function onSyncCookies(profile) {
    try {
      const r = await api(`/api/profiles/${profile.id}/sync-cookies`, { method: 'POST' });
      showToast('ซิงก์คุกกี้แล้ว',
        `บันทึก ${r.saved || 0} คุกกี้` + (r.logged_in ? ' (เข้าสู่ระบบสำเร็จ)' : ' (ยังไม่เข้าสู่ระบบ)'),
        r.logged_in ? 'success' : 'warning');
      refresh();
    } catch (e) {
      showToast('ซิงก์ผิดพลาด', e.message, 'danger');
    }
  }

  async function onFetchPages(profile) {
    try {
      showToast('กำลังดึงเพจ', 'รอสักครู่...', 'info');
      const r = await api(`/api/profiles/${profile.id}/fetch-pages`, { method: 'POST' });
      showToast('ดึงเพจสำเร็จ',
        `เพิ่ม ${r.inserted || 0} เพจ (ข้าม ${r.skipped || 0})`,
        'success');
      refresh();
    } catch (e) {
      showToast('ดึงเพจล้มเหลว', e.message, 'danger');
    }
  }

  async function onCloseBrowser(profile) {
    try {
      await api(`/api/profiles/${profile.id}/close-browser`, { method: 'POST' });
      showToast('ปิดโครมแล้ว', profile.name, 'info');
    } catch (e) {
      showToast('ผิดพลาด', e.message, 'danger');
    }
  }

  async function onDeleteProfile(profile) {
    if (!confirm(`ลบบัญชี "${profile.name}"?\nโฟลเดอร์โปรไฟล์โครมจะยังอยู่ในกรณีต้องการกู้คืน`)) return;
    try {
      await api(`/api/profiles/${profile.id}`, { method: 'DELETE' });
      showToast('ลบแล้ว', profile.name, 'success');
      refresh();
    } catch (e) {
      showToast('ลบไม่สำเร็จ', e.message, 'danger');
    }
  }

  // ============================================================
  // ADD PROFILE MODAL
  // ============================================================
  function openAddModal(platform) {
    const overlay = document.getElementById('profiles-overlay-modal');
    if (overlay) overlay.remove();

    const modal = el('div', { id: 'profiles-overlay-modal', onclick: (e) => {
      if (e.target.id === 'profiles-overlay-modal') modal.remove();
    }});

    const panel = el('div', { class: 'modal-panel' });
    panel.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:20px' },
      el('div', null,
        el('div', { class: 'label-jp' }, 'เพิ่มใหม่'),
        el('div', { class: 'panel-title', style: 'font-size:18px' },
          'เพิ่มบัญชี ' + TABS.find(t => t.key === platform).label)
      ),
      el('button', { class: 'btn-ghost', onclick: () => modal.remove(), style: 'padding:6px 12px' }, '✕')
    ));

    const form = el('form', { onsubmit: (e) => { e.preventDefault(); submitAdd(platform, form, modal); }});

    // Common: name field
    form.appendChild(el('div', { style: 'margin-bottom:14px' },
      el('label', null, 'ชื่อกำกับ ', el('span', { style: 'color:var(--danger)' }, '*')),
      el('input', { type: 'text', name: 'name', required: 'required',
        placeholder: platform === 'facebook' ? 'เช่น "บัญชีหลัก 1"' :
                     platform === 'x' ? 'เช่น "บัญชี X สำหรับติดตามช่อง"' :
                     'เช่น "บัญชี IG ติดตาม Reels"' })
    ));

    if (platform === 'facebook') {
      // FB: requires fb_username + fb_password
      form.appendChild(el('div', { style: 'margin-bottom:14px' },
        el('label', null, 'อีเมล / เบอร์โทร ', el('span', { style: 'color:var(--danger)' }, '*')),
        el('input', { type: 'text', name: 'fb_username', required: 'required', placeholder: 'name@example.com' })
      ));
      form.appendChild(el('div', { style: 'margin-bottom:14px' },
        el('label', null, 'รหัสผ่าน ', el('span', { style: 'color:var(--danger)' }, '*')),
        el('input', { type: 'password', name: 'fb_password', required: 'required' })
      ));
      form.appendChild(el('div', { style: 'margin-bottom:14px' },
        el('label', null, 'รหัสลับยืนยันสองชั้น (ถ้ามี)'),
        el('input', { type: 'text', name: 'fb_2fa_secret', placeholder: 'รหัสลับ OTP (ไม่บังคับ)' })
      ));
    } else {
      // X / IG: only handle (optional, for reference)
      form.appendChild(el('div', { style: 'margin-bottom:14px' },
        el('label', null, '@ ชื่อบัญชี (จะเข้าสู่ระบบผ่านโครม — แค่กรอกไว้อ้างอิง)'),
        el('input', { type: 'text', name: 'account_handle',
          placeholder: platform === 'x' ? '@username' : '@username' })
      ));
      form.appendChild(el('div', { class: 'platform-help', style: 'margin-bottom:14px' },
        platform === 'x'
          ? 'หลังเพิ่มบัญชี → กด "🌐 เปิดโครมเพื่อเข้าสู่ระบบ" → ใส่ชื่อผู้ใช้/รหัสผ่านในหน้าต่างโครมที่เปิดขึ้น → ปิดโครมเมื่อเข้าสู่ระบบเสร็จ → กด "🔄 ซิงก์คุกกี้"'
          : 'หลังเพิ่มบัญชี → กด "🌐 เปิดโครมเพื่อเข้าสู่ระบบ" → ใส่ชื่อผู้ใช้/รหัสผ่านในหน้าต่างโครมที่เปิดขึ้น → ปิดโครมเมื่อเข้าสู่ระบบเสร็จ → กด "🔄 ซิงก์คุกกี้"'
      ));
    }

    // Proxy (optional, all platforms)
    const proxyDetails = el('details', { style: 'margin-bottom:14px' },
      el('summary', { style: 'font-size:12px;color:var(--text-secondary);cursor:pointer;margin-bottom:10px' },
        'ตั้งค่าพร็อกซี (ถ้าต้องการ)'),
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' },
        el('div', null,
          el('label', null, 'โฮสต์พร็อกซี'),
          el('input', { type: 'text', name: 'proxy_host', placeholder: '192.168.1.1' })
        ),
        el('div', null,
          el('label', null, 'พอร์ตพร็อกซี'),
          el('input', { type: 'number', name: 'proxy_port', placeholder: '8080' })
        )
      )
    );
    form.appendChild(proxyDetails);

    // Submit
    form.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px' },
      el('button', { type: 'button', class: 'btn-ghost', onclick: () => modal.remove() }, 'ยกเลิก'),
      el('button', { type: 'submit', class: 'btn-primary' }, '+ เพิ่มบัญชี')
    ));

    panel.appendChild(form);
    modal.appendChild(panel);
    document.body.appendChild(modal);
  }

  async function submitAdd(platform, form, modal) {
    const fd = new FormData(form);
    const body = { platform };
    for (const [k, v] of fd.entries()) {
      if (v !== '') body[k] = v;
    }
    let created;
    try {
      created = await api('/api/profiles', { method: 'POST', body: JSON.stringify(body) });
      showToast('เพิ่มบัญชีแล้ว', body.name, 'success');
      modal.remove();
      refresh();
    } catch (e) {
      showToast('เพิ่มไม่สำเร็จ', e.message, 'danger');
      return;
    }

    // For Facebook profiles with credentials, immediately fire off auto-login
    // so the user doesn't have to dig through the table to click "🌐 เปิด Chrome".
    // Chrome window pops up, we autofill email + password + click Login, then
    // hand the window back to the user for 2FA / device confirm. Failure is
    // non-fatal — the profile row still exists for manual login.
    if (platform === 'facebook' && body.fb_username && body.fb_password && created?.id) {
      try {
        const result = await api(`/api/profiles/${created.id}/auto-login`, { method: 'POST' });
        showToast('กำลังเปิดโครม', result.message || 'กรอกอีเมล + รหัสผ่านให้แล้ว', 'info');
      } catch (e) {
        showToast('เข้าสู่ระบบอัตโนมัติไม่สำเร็จ',
          e.message + ' — กด "🌐 เปิดโครม" ในตาราง เพื่อเข้าสู่ระบบเอง', 'warning');
      }
    }
  }

  // ============================================================
  // NAV HOOK
  // ============================================================
  let _navListenerAttached = false;
  function setupNavClickListener() {
    if (_navListenerAttached) return;
    _navListenerAttached = true;

    document.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (!item) return;
      // ข้าม nav-item ที่เป็น watcher-injection (มี dataset.watcherInject)
      if (item.dataset.watcherInject) return;

      const text = (item.textContent || '').trim();
      if (text.includes(NAV_TH)) {
        // เมนู "จัดการบัญชี" — show overlay
        activateMyView();
      } else {
        // เมนูอื่น → ซ่อน overlay
        deactivateMyView();
      }
    }, true);
  }

  // ============================================================
  // BOOT
  // ============================================================
  let _retryProbeTimer = null;

  async function boot() {
    backendOk = await probeBackend();
    if (!backendOk) {
      console.warn('[profiles-injection] backend ไม่พร้อม — จะลองใหม่ใน 5 วิ');
      _retryProbeTimer = setTimeout(boot, 5000);
      return;
    }
    if (_retryProbeTimer) { clearTimeout(_retryProbeTimer); _retryProbeTimer = null; }
    console.log('[profiles-injection] backend พร้อม — รอ user เลือกเมนู "จัดการบัญชี"');
    _attachImeListeners();   // ✅ FIX IME: ติดตาม composition + focus events
    setupNavClickListener();
  }

  window.addEventListener('pagehide', () => {
    if (_retryProbeTimer) { clearTimeout(_retryProbeTimer); _retryProbeTimer = null; }
    if (_overlayPositionTimer) { clearInterval(_overlayPositionTimer); _overlayPositionTimer = null; }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
