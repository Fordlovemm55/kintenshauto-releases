import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { useSettings, SettingRow, SaveBar } from './settingsKit';

const API = 'http://localhost:3003';

// Single hub for everything caption + cover related: API keys, caption mode +
// prompts/template, and AI cover. Caption/cover key-value settings flow through
// the shared settings kit; keys and prompts keep their own immediate-save APIs.

const PROVIDERS = [
  { key: 'openai',    label: 'โอเพนเอไอ',              placeholder: 'sk-...' },
  { key: 'anthropic', label: 'แอนโทรปิก (Claude)',     placeholder: 'sk-ant-...' },
  { key: 'gemini',    label: 'กูเกิล เจมิไน',           placeholder: 'AIza...' },
];

// Key/value setting descriptors (moved here from SettingsView so all caption +
// cover config lives on one screen). `key` must match the backend allowlist.
const CAPTION_MODE = {
  key: 'caption_mode', label: 'โหมดสร้างแคปชั่น', type: 'select',
  options: [
    { value: 'ai',           label: 'ใช้ AI (ค่าเริ่มต้น — ต้องตั้งคีย์ API)' },
    { value: 'template',     label: 'แม่แบบเอง (ฟรี — ไม่ใช้ AI)' },
    { value: 'source_title', label: 'ใช้ชื่อวิดีโอต้นฉบับ + อีโมจิ (ฟรี)' },
    { value: 'off',          label: 'ปิด — ไม่มีแคปชั่น (แคปชั่นว่าง)' },
  ],
  desc: '"ใช้ AI" จะเรียกโอเพนเอไอ/แอนโทรปิก/เจมิไน · "แม่แบบ" / "ใช้ชื่อวิดีโอ" / "ปิด" ไม่เสียค่า API เลย',
};
const CAPTION_TEMPLATE = {
  key: 'caption_template', label: 'แม่แบบข้อความ', type: 'textarea',
  placeholder: '{video_title} {emoji} EP.{clip_number}\n#ซีรีส์ #คลิปดี',
  desc: 'ตัวแปรที่ใช้ได้: {video_title} {video_title_short} {clip_number} {total_clips} {channel_label} {page_name} {niche} {emoji} {emoji2} {emoji3}',
};
const CAPTION_EMOJI = {
  key: 'caption_emoji_pool', label: 'อีโมจิที่จะสุ่มใส่ใน {emoji}', type: 'text',
  placeholder: '🎬,🔥,✨,📺,⚡,💥,🌟,🎥,🎞,🎟',
  desc: 'คั่นด้วยเครื่องหมายจุลภาค — ระบบจะสุ่มหยิบมาแทน {emoji} / {emoji2} / {emoji3} ในทุกคลิป',
};
const COVER_ENABLED = {
  key: 'cover_enabled', label: 'เปิดใช้ AI สร้างปก', type: 'toggle',
  desc: 'ปิด = ใช้ภาพตัวอย่างจากคลิป · เปิด = สร้างปกใหม่ด้วย AI',
};
const COVER_MODEL = {
  key: 'cover_model', label: 'รุ่น AI ที่ใช้สร้างปก', type: 'select',
  options: [
    { value: '',            label: '(ไม่ตั้ง — ใช้ค่าเริ่มต้นของระบบ)' },
    { value: 'dalle-3',     label: 'DALL·E 3 (โอเพนเอไอ)' },
    { value: 'gpt-image-1', label: 'GPT Image 1 (โอเพนเอไอ)' },
    { value: 'imagen-4',    label: 'Imagen 4 (เจมิไน)' },
  ],
};
const COVER_PROMPT = {
  key: 'cover_prompt_default', label: 'พรอมต์เริ่มต้น', type: 'textarea',
  placeholder: 'เช่น "ภาพปกซีรีส์จีน สีสันสด ตัวอักษรไทยใหญ่..."',
};
const SETTING_KEYS = [
  CAPTION_MODE.key, CAPTION_TEMPLATE.key, CAPTION_EMOJI.key,
  COVER_ENABLED.key, COVER_MODEL.key, COVER_PROMPT.key,
];

export default function AICaptionsView({ showToast }) {
  const [prompts, setPrompts] = useState([]);
  const [pages, setPages] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);

  const settings = useSettings(SETTING_KEYS, showToast);

  const refresh = useCallback(async () => {
    try {
      const [p, pg, m] = await Promise.all([
        fetch(`${API}/api/caption-prompts`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/pages`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/caption-models`).then(r => r.json()).catch(() => ({ models: [] })),
      ]);
      setPrompts(Array.isArray(p) ? p : []);
      setPages(Array.isArray(pg) ? pg : []);
      setModels(m.models || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const hasAnyKey = models.some(m => m.available);

  return (
    <div className="fade-in">
      <AIKeysSection showToast={showToast} onChanged={refresh} />

      <CaptionPanel
        settings={settings}
        loading={loading}
        prompts={prompts}
        pages={pages}
        models={models}
        hasAnyKey={hasAnyKey}
        onPromptsChanged={refresh}
        showToast={showToast}
      />

      <CoverPanel settings={settings} />

      {!settings.loading && (
        <SaveBar isDirty={settings.isDirty} saving={settings.saving}
                 onSave={settings.saveAll} onReset={settings.resetAll} />
      )}
    </div>
  );
}

// ============================================================
// 1 · API keys (OpenAI / Anthropic / Gemini) — moved from Settings.
// Saving/removing a key refreshes model availability via onChanged.
// ============================================================
function AIKeysSection({ showToast, onChanged }) {
  const [keys, setKeys] = useState({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ openai: '', anthropic: '', gemini: '' });
  const [busy, setBusy] = useState({});
  const [show, setShow] = useState({});

  const refresh = async () => {
    try {
      const data = await fetch(`${API}/api/ai/keys`).then(r => r.json());
      setKeys(data || {});
    } finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const setBusyFor = (p, v) => setBusy(prev => ({ ...prev, [p]: v }));

  const save = async (p) => {
    const api_key = draft[p]?.trim();
    if (!api_key || api_key.length < 10) {
      showToast?.('คีย์สั้นเกินไป', 'กรอกคีย์ให้ครบ', 'error');
      return;
    }
    setBusyFor(p, 'save');
    try {
      const res = await fetch(`${API}/api/ai/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, api_key })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDraft(prev => ({ ...prev, [p]: '' }));
      showToast?.('บันทึกแล้ว', `${PROVIDERS.find(x => x.key === p).label} พร้อมใช้งาน`, 'success');
      await refresh();
      onChanged?.();
    } catch (e) { showToast?.('บันทึกไม่สำเร็จ', e.message, 'error'); }
    finally { setBusyFor(p, null); }
  };

  const test = async (p) => {
    setBusyFor(p, 'test');
    try {
      const res = await fetch(`${API}/api/ai/keys/${p}/test`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.('ทดสอบสำเร็จ', data.sample || 'AI ตอบกลับเรียบร้อย', 'success');
    } catch (e) { showToast?.('ทดสอบไม่ผ่าน', e.message, 'error'); }
    finally { setBusyFor(p, null); }
  };

  const remove = async (p) => {
    if (!confirm(`ลบคีย์ API ของ ${PROVIDERS.find(x => x.key === p).label}?`)) return;
    setBusyFor(p, 'delete');
    try {
      await fetch(`${API}/api/ai/keys/${p}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await refresh();
      onChanged?.();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
    finally { setBusyFor(p, null); }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">1 · คีย์ API</div>
          <div className="panel-title">คีย์ API สำหรับ AI</div>
          <div className="panel-subtitle">
            ตั้งคีย์อย่างน้อย 1 ราย แล้วถึงจะใช้ "ใช้ AI" สร้างแคปชั่น/ปกได้ — ระบบจะใช้ตัวที่ตั้งก่อนตามลำดับ โอเพนเอไอ → แอนโทรปิก → เจมิไน
            {keys.primary && <span style={{ color: 'var(--gold)', marginLeft: 8 }}>· ตอนนี้ใช้: {PROVIDERS.find(p => p.key === keys.primary)?.label}</span>}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 20, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
      ) : (
        PROVIDERS.map(p => {
          const info = keys[p.key] || { configured: false, model: '' };
          const isBusy = busy[p.key];
          return (
            <div key={p.key} style={{
              padding: 12, marginBottom: 8,
              background: 'var(--surface-2)',
              border: '0.5px solid ' + (info.configured ? 'var(--success)' : 'var(--border-faint)')
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                <div>
                  <strong style={{ fontSize: 13 }}>{p.label}</strong>
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                    รุ่น: {info.model || '—'}
                  </span>
                </div>
                {info.configured ? (
                  <span className="badge badge-success" style={{ fontSize: 10 }}>✓ ตั้งค่าแล้ว</span>
                ) : (
                  <span className="badge" style={{ fontSize: 10, background: 'var(--surface-3)', color: 'var(--text-muted)' }}>ยังไม่ได้ตั้ง</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  type={show[p.key] ? 'text' : 'password'}
                  value={draft[p.key] || ''}
                  onChange={e => setDraft(prev => ({ ...prev, [p.key]: e.target.value }))}
                  placeholder={info.configured ? '(เก็บไว้แล้ว — กรอกใหม่เพื่อเปลี่ยน)' : p.placeholder}
                  style={{ flex: '1 1 280px', minWidth: 200, fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-1)', border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)' }}
                  disabled={!!isBusy}
                />
                <button className="btn-ghost"
                        onClick={() => setShow(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                        style={{ fontSize: 11, padding: '4px 10px' }}>
                  {show[p.key] ? '🙈 ซ่อน' : '👁 แสดง'}
                </button>
                <button className="btn-primary"
                        onClick={() => save(p.key)}
                        disabled={!!isBusy || !(draft[p.key] || '').trim()}
                        style={{ fontSize: 11, padding: '4px 14px' }}>
                  {isBusy === 'save' ? 'กำลังบันทึก...' : '💾 บันทึก'}
                </button>
                {info.configured && (
                  <>
                    <button className="btn-ghost"
                            onClick={() => test(p.key)}
                            disabled={!!isBusy}
                            style={{ fontSize: 11, padding: '4px 10px' }}>
                      {isBusy === 'test' ? '⏳ ทดสอบ...' : '🧪 ทดสอบ'}
                    </button>
                    <button className="btn-ghost"
                            onClick={() => remove(p.key)}
                            disabled={!!isBusy}
                            style={{ fontSize: 11, padding: '4px 10px', color: 'var(--danger)' }}>
                      {isBusy === 'delete' ? 'ลบ...' : '🗑 ลบ'}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ============================================================
// 2 · Caption — mode selector drives what shows below.
// ============================================================
function CaptionPanel({ settings, loading, prompts, pages, models, hasAnyKey, onPromptsChanged, showToast }) {
  const { values, setOne } = settings;
  const mode = values[CAPTION_MODE.key] || 'ai';

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">2 · แคปชั่น</div>
          <div className="panel-title">แคปชั่น</div>
          <div className="panel-subtitle">เลือกโหมด แล้วช่องด้านล่างจะเปลี่ยนตามโหมดที่เลือก</div>
        </div>
      </div>

      {settings.loading ? (
        <div style={{ padding: 16, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 10 }}>
            <SettingRow item={CAPTION_MODE} value={values[CAPTION_MODE.key]}
                        onChange={(v) => setOne(CAPTION_MODE.key, v)} />
          </div>

          {mode === 'ai' && (
            <div style={{ marginTop: 12 }}>
              {!hasAnyKey && (
                <div style={{ padding: 12, marginBottom: 12, borderLeft: '3px solid var(--danger)',
                              background: 'rgba(232,123,123,0.06)', fontSize: 12, color: 'var(--text-secondary)' }}>
                  ⚠ ยังไม่ได้ตั้งคีย์ API — เลื่อนขึ้นไปตั้งที่หัวข้อ "1 · คีย์ API" ด้านบนก่อน ถึงจะใช้ AI สร้างแคปชั่นได้
                </div>
              )}
              <ModelsPanel models={models} />
              <PromptsPanel prompts={prompts} pages={pages} models={models}
                            loading={loading} onChanged={onPromptsChanged} showToast={showToast} />
            </div>
          )}

          {mode === 'template' && (
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              <SettingRow item={CAPTION_TEMPLATE} value={values[CAPTION_TEMPLATE.key]}
                          onChange={(v) => setOne(CAPTION_TEMPLATE.key, v)} />
              <SettingRow item={CAPTION_EMOJI} value={values[CAPTION_EMOJI.key]}
                          onChange={(v) => setOne(CAPTION_EMOJI.key, v)} />
            </div>
          )}

          {mode === 'source_title' && (
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              <SettingRow item={CAPTION_EMOJI} value={values[CAPTION_EMOJI.key]}
                          onChange={(v) => setOne(CAPTION_EMOJI.key, v)} />
            </div>
          )}

          {mode === 'off' && (
            <div style={{ marginTop: 12, padding: 12, background: 'var(--surface-2)',
                          fontSize: 12, color: 'var(--text-muted)' }}>
              ปิดอยู่ — คลิปจะถูกโพสต์โดยไม่มีแคปชั่น
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Collapsible reference table of available models + cost.
function ModelsPanel({ models }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 12 }}>
      <button className="btn-ghost" onClick={() => setOpen(o => !o)}
              style={{ fontSize: 11, padding: '4px 10px' }}>
        {open ? '▾ ซ่อนราคารุ่น AI' : '▸ ดูราคารุ่น AI'}
      </button>
      {open && (
        models.length === 0 ? (
          <div style={{ padding: 10, color: 'var(--text-muted)', fontSize: 12 }}>โหลดรุ่น AI ไม่สำเร็จ</div>
        ) : (
          <div style={{ marginTop: 8, display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {models.map(m => (
              <div key={m.id} style={{
                padding: 10, background: 'var(--surface-2)',
                border: '0.5px solid ' + (m.available ? 'var(--success)' : 'var(--border-faint)'),
                opacity: m.available ? 1 : 0.5,
              }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{m.label}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {m.provider} · {m.available ? '✓ ใช้ได้' : '× ยังไม่ได้ตั้งคีย์'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 4 }}>
                  ≈ {m.cost_per_caption_thb?.toFixed?.(4) || '?'} บาท/แคปชั่น
                  {' '}<span style={{ color: 'var(--text-muted)' }}>
                    ({m.cost_per_1000_captions_thb?.toFixed?.(2) || '?'} บาท/1000)
                  </span>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// Per-page / general caption prompts CRUD.
function PromptsPanel({ prompts, pages, models, loading, onChanged, showToast }) {
  const [editing, setEditing] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const deletePrompt = async (id) => {
    if (!confirm('ลบพรอมต์นี้?')) return;
    try {
      await fetch(`${API}/api/caption-prompts/${id}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await onChanged?.();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>พรอมต์สำหรับสร้างแคปชั่น ({prompts.length})</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            แต่ละเพจมีพรอมต์ของตัวเอง หรือใช้พรอมต์ทั่วไป (ไม่ระบุเพจ)
          </div>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}
                style={{ fontSize: 12, padding: '6px 14px' }}>
          ＋ สร้างพรอมต์
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 14, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
      ) : prompts.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
          <Icon name="empty-comments" className="empty-icon" size={56} />
          <div style={{ fontSize: 13 }}>ยังไม่มีพรอมต์ — กด "＋ สร้างพรอมต์" เพื่อเริ่ม</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {prompts.map(p => (
            <PromptRow key={p.id} prompt={p} pages={pages} models={models}
                       onEdit={() => setEditing(p)}
                       onDelete={() => deletePrompt(p.id)} />
          ))}
        </div>
      )}

      {(showCreate || editing) && (
        <PromptModal
          pages={pages}
          models={models}
          prompt={editing}
          onClose={() => { setShowCreate(false); setEditing(null); }}
          onSaved={async () => {
            setShowCreate(false);
            setEditing(null);
            await onChanged?.();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function PromptRow({ prompt, pages, models, onEdit, onDelete }) {
  const pageName = prompt.page_id
    ? (pages.find(p => p.id === prompt.page_id)?.name || `เพจ #${prompt.page_id}`)
    : 'ทุกเพจ (ทั่วไป)';
  const modelInfo = models.find(m => m.id === prompt.selected_model);

  return (
    <div style={{
      padding: 12, background: 'var(--surface-2)',
      border: '0.5px solid var(--border-faint)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                        flexWrap: 'wrap', marginBottom: 6 }}>
            <span className={`badge ${prompt.page_id ? 'badge-gold' : 'badge-info'}`}
                  style={{ fontSize: 10 }}>
              {pageName}
            </span>
            {modelInfo && (
              <span className="badge badge-success" style={{ fontSize: 10 }}>
                {modelInfo.label}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              สูงสุด {prompt.max_tokens} โทเคน · อุณหภูมิ={prompt.temperature}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            <strong>พรอมต์ระบบ:</strong>
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)',
            background: 'var(--surface-3)', padding: '6px 8px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 60, overflow: 'auto', marginBottom: 6
          }}>
            {prompt.system_prompt}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            <strong>แม่แบบพรอมต์ผู้ใช้:</strong>
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)',
            background: 'var(--surface-3)', padding: '6px 8px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 60, overflow: 'auto'
          }}>
            {prompt.user_prompt}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button className="btn-ghost" onClick={onEdit}
                  style={{ fontSize: 11, padding: '3px 10px' }}>✎ แก้</button>
          <button className="btn-ghost" onClick={onDelete}
                  style={{ fontSize: 11, padding: '3px 10px', color: 'var(--danger)' }}>🗑</button>
        </div>
      </div>
    </div>
  );
}

const DEFAULT_SYSTEM = `คุณเป็นผู้เขียนแคปชั่นเฟซบุ๊กรีลภาษาไทยที่สั้น กระชับ ดึงดูดให้คนคลิกดู
- 1-2 บรรทัด ไม่ยาว
- ใส่ #hashtag 2-3 ตัวที่เกี่ยวข้อง
- ไม่ใช้คำหยาบ ไม่สแปม`;

const DEFAULT_USER = `เขียนแคปชั่นให้คลิป "{video_title}" คลิปที่ {clip_number} จาก {total_clips} ตอน
ประเภท: {niche}
สำหรับเพจ: {page_name}`;

function PromptModal({ pages, models, prompt, onClose, onSaved, showToast }) {
  const isEdit = !!prompt;
  const [form, setForm] = useState({
    page_id: prompt?.page_id ?? null,
    system_prompt: prompt?.system_prompt ?? DEFAULT_SYSTEM,
    user_prompt: prompt?.user_prompt ?? DEFAULT_USER,
    max_tokens: prompt?.max_tokens ?? 200,
    temperature: prompt?.temperature ?? 0.8,
    selected_model: prompt?.selected_model ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API}/api/caption-prompts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_prompt: form.system_prompt,
          user_prompt: form.user_prompt,
          max_tokens: Number(form.max_tokens) || 200,
          temperature: Number(form.temperature) || 0.8,
          variables: {
            video_title: 'หงส์เหิรฟ้า EP.1',
            niche: 'ซีรีส์จีนย้อนยุค',
            clip_number: 1, total_clips: 4,
            page_name: form.page_id
              ? pages.find(p => p.id === form.page_id)?.name || 'เพจตัวอย่าง'
              : 'เพจตัวอย่าง'
          }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTestResult(data.caption || data.result || data.text || JSON.stringify(data));
    } catch (e) { showToast?.('ทดสอบไม่สำเร็จ', e.message, 'error'); }
    finally { setTesting(false); }
  };

  const save = async () => {
    if (!form.system_prompt.trim() || !form.user_prompt.trim()) {
      showToast?.('ใส่พรอมต์ให้ครบทั้งสอง', 'พรอมต์ระบบและพรอมต์ผู้ใช้ต้องไม่ว่าง', 'error');
      return;
    }
    setSaving(true);
    try {
      const url = isEdit
        ? `${API}/api/caption-prompts/${prompt.id}`
        : `${API}/api/caption-prompts`;
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: form.page_id || null,
          system_prompt: form.system_prompt,
          user_prompt: form.user_prompt,
          max_tokens: Number(form.max_tokens) || 200,
          temperature: Number(form.temperature) || 0.8,
          selected_model: form.selected_model || null,
        })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      showToast?.(isEdit ? 'อัปเดตแล้ว' : 'สร้างแล้ว', '', 'success');
      onSaved?.();
    } catch (e) { showToast?.('บันทึกไม่สำเร็จ', e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           style={{
             background: 'var(--surface-1)', border: '1px solid var(--gold)',
             padding: 20, maxWidth: 720, width: '100%',
             maxHeight: '92vh', overflow: 'auto'
           }}>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>
            {isEdit ? 'แก้พรอมต์' : 'สร้างพรอมต์ใหม่'}
          </div>
          <button className="btn-ghost" onClick={onClose}
                  style={{ fontSize: 14, padding: '2px 10px' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                      gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11 }}>เพจ</label>
            <select value={form.page_id || ''}
                    onChange={e => set('page_id', Number(e.target.value) || null)}
                    style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                             background: 'var(--surface-2)',
                             border: '0.5px solid var(--border-faint)',
                             color: 'var(--text-primary)', marginTop: 2 }}>
              <option value="">ทุกเพจ (ทั่วไป)</option>
              {pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11 }}>รุ่น AI</label>
            <select value={form.selected_model || ''}
                    onChange={e => set('selected_model', e.target.value)}
                    style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                             background: 'var(--surface-2)',
                             border: '0.5px solid var(--border-faint)',
                             color: 'var(--text-primary)', marginTop: 2 }}>
              <option value="">— ใช้รุ่นที่ตั้งไว้ในคีย์ API —</option>
              {models.filter(m => m.available).map(m => (
                <option key={m.id} value={m.id}>{m.label} (~{m.cost_per_caption_thb?.toFixed?.(4) || '?'} ฿)</option>
              ))}
            </select>
          </div>
        </div>

        <label style={{ fontSize: 11 }}>พรอมต์ระบบ (คำสั่งหลัก)</label>
        <textarea value={form.system_prompt}
                  onChange={e => set('system_prompt', e.target.value)}
                  rows={4}
                  style={{ width: '100%', fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-2)',
                           border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)', marginTop: 2,
                           resize: 'vertical' }} />

        <label style={{ fontSize: 11, marginTop: 10, display: 'block' }}>
          พรอมต์ผู้ใช้ (ข้อความที่ส่งให้ AI · ใช้ตัวแปร {`{video_title}`}, {`{page_name}`} ฯลฯ)
        </label>
        <textarea value={form.user_prompt}
                  onChange={e => set('user_prompt', e.target.value)}
                  rows={4}
                  style={{ width: '100%', fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-2)',
                           border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)', marginTop: 2,
                           resize: 'vertical' }} />

        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
            ขั้นสูง — โทเคนสูงสุด · อุณหภูมิ
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                        gap: 10, marginTop: 8 }}>
            <div>
              <label style={{ fontSize: 11 }}>โทเคนสูงสุด</label>
              <input type="number" min="50" max="2000" value={form.max_tokens}
                     onChange={e => set('max_tokens', e.target.value)}
                     style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                              background: 'var(--surface-2)',
                              border: '0.5px solid var(--border-faint)',
                              color: 'var(--text-primary)', marginTop: 2 }} />
            </div>
            <div>
              <label style={{ fontSize: 11 }}>อุณหภูมิ (0–1)</label>
              <input type="number" min="0" max="1" step="0.1" value={form.temperature}
                     onChange={e => set('temperature', e.target.value)}
                     style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                              background: 'var(--surface-2)',
                              border: '0.5px solid var(--border-faint)',
                              color: 'var(--text-primary)', marginTop: 2 }} />
            </div>
          </div>
        </details>

        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={test} disabled={testing}
                  style={{ fontSize: 11, padding: '6px 14px' }}>
            {testing ? '⏳ ทดสอบ...' : '🧪 ทดสอบพรอมต์'}
          </button>
        </div>

        {testResult && (
          <div style={{
            marginTop: 12, padding: 10,
            background: 'var(--surface-3)',
            borderLeft: '2px solid var(--success)',
            fontSize: 12, whiteSpace: 'pre-wrap'
          }}>
            <div style={{ fontSize: 10, color: 'var(--success)', marginBottom: 4 }}>✓ AI ตอบ:</div>
            {testResult}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end',
                      gap: 6, marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose} disabled={saving}
                  style={{ fontSize: 12, padding: '6px 14px' }}>ยกเลิก</button>
          <button className="btn-primary" onClick={save} disabled={saving}
                  style={{ fontSize: 12, padding: '6px 18px' }}>
            {saving ? 'กำลังบันทึก...' : '💾 บันทึก'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 3 · Cover (AI cover generation).
// ============================================================
function CoverPanel({ settings }) {
  const { values, setOne } = settings;
  const enabled = values[COVER_ENABLED.key] === '1';

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">3 · ปก</div>
          <div className="panel-title">AI สร้างปกอัตโนมัติ</div>
        </div>
      </div>

      {settings.loading ? (
        <div style={{ padding: 16, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <SettingRow item={COVER_ENABLED} value={values[COVER_ENABLED.key]}
                      onChange={(v) => setOne(COVER_ENABLED.key, v)} />
          {enabled && (
            <>
              <SettingRow item={COVER_MODEL} value={values[COVER_MODEL.key]}
                          onChange={(v) => setOne(COVER_MODEL.key, v)} />
              <SettingRow item={COVER_PROMPT} value={values[COVER_PROMPT.key]}
                          onChange={(v) => setOne(COVER_PROMPT.key, v)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
