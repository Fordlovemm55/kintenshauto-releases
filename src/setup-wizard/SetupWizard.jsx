import React, { useState, useEffect } from 'react';
import SamuraiBackground from '../components/SamuraiBackground';
import '../theme/samurai.css';

/**
 * KINTENSHAUTO Setup Wizard · 初期設定
 *
 * 5 ขั้นตอน:
 * 1. Welcome - ต้อนรับ + คำเตือนการใช้งาน
 * 2. Dependencies - ตรวจ + ติดตั้ง FFmpeg/yt-dlp/Chrome
 * 3. First Profile - เพิ่มเฟส FB เฟสแรก (optional, ทำทีหลังได้)
 * 4. AI Provider - ใส่ API key (optional)
 * 5. Complete - เสร็จ + สอนวิธีใช้
 */

const STEPS = [
  { num: 1, jp: '始め',   th: 'เริ่มต้น' },
  { num: 2, jp: '道具',   th: 'เครื่องมือ' },
  { num: 3, jp: '盟友',   th: 'เฟส' },
  { num: 4, jp: '知恵',   th: 'AI' },
  { num: 5, jp: '出陣',   th: 'พร้อม' }
];

export default function SetupWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [deps, setDeps] = useState(null);
  const [depsInstalling, setDepsInstalling] = useState(false);
  const [depsProgress, setDepsProgress] = useState({});
  const [profile, setProfile] = useState({
    name: '', fb_username: '', fb_password: '', fb_2fa_secret: '',
    proxy_host: '', proxy_port: '', proxy_user: '', proxy_pass: ''
  });
  const [aiConfig, setAiConfig] = useState({
    provider: 'openai', model: 'gpt-4o-mini', api_key: '', label: 'Provider หลัก'
  });
  const [skippedProfile, setSkippedProfile] = useState(false);
  const [skippedAI, setSkippedAI] = useState(false);

  useEffect(() => {
    if (step === 2 && !deps) {
      checkDeps();
    }
    if (window.kintenshauto?.onDepsProgress) {
      window.kintenshauto.onDepsProgress((p) => {
        setDepsProgress(prev => ({ ...prev, [p.step]: p }));
      });
    }
  }, [step]);

  const checkDeps = async () => {
    if (!window.kintenshauto) {
      setDeps({ ready: false, results: [], error: 'Electron API ไม่พร้อม (dev mode)' });
      return;
    }
    const result = await window.kintenshauto.checkDeps();
    setDeps(result);
  };

  const installDeps = async () => {
    setDepsInstalling(true);
    setDepsProgress({});
    try {
      await window.kintenshauto.installDeps();
      await checkDeps();
    } catch (e) {
      alert('ติดตั้งล้มเหลว: ' + e.message);
    }
    setDepsInstalling(false);
  };

  const saveProfileAndAI = async () => {
    try {
      const API = 'http://localhost:3003';

      if (!skippedProfile && profile.fb_username) {
        await fetch(`${API}/api/profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile)
        });
      }

      if (!skippedAI && aiConfig.api_key) {
        await fetch(`${API}/api/ai/providers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(aiConfig)
        });
      }

      if (window.kintenshauto) {
        await window.kintenshauto.completeSetup();
      }
      onComplete?.();
    } catch (e) {
      alert('บันทึกล้มเหลว: ' + e.message + '\n\nไม่เป็นไร คุณสามารถตั้งค่าใน app ภายหลังได้');
      if (window.kintenshauto) await window.kintenshauto.completeSetup();
      onComplete?.();
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden', background: 'var(--sumi-ink)' }}>
      <SamuraiBackground opacity={0.55} />

      <div style={{
        position: 'relative', zIndex: 2, width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '40px 20px', overflowY: 'auto'
      }}>

        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div className="kanji-title" style={{ fontSize: 48, marginBottom: 4 }}>剣天照</div>
          <div style={{ fontSize: 13, color: 'var(--gold)', letterSpacing: 3 }}>KINTENSHAUTO · SETUP</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>การตั้งค่าครั้งแรก · 初期設定</div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 40, alignItems: 'center' }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s.num}>
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                opacity: step >= s.num ? 1 : 0.35
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  border: `1px solid ${step > s.num ? 'var(--success)' : (step === s.num ? 'var(--gold)' : 'var(--border-soft)')}`,
                  background: step === s.num ? 'var(--surface-active)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-jp)', fontSize: 14, fontWeight: 500,
                  color: step > s.num ? 'var(--success)' : (step === s.num ? 'var(--gold)' : 'var(--text-muted)')
                }}>
                  {step > s.num ? '✓' : s.num}
                </div>
                <div style={{ fontFamily: 'var(--font-jp)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 2 }}>{s.jp}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.th}</div>
              </div>
              {i < STEPS.length - 1 && (
                <div style={{ width: 30, height: 1, background: step > s.num ? 'var(--success)' : 'var(--border-faint)' }}/>
              )}
            </React.Fragment>
          ))}
        </div>

        <div className="panel fade-in" style={{ width: '100%', maxWidth: 620, minHeight: 360 }}>

          {step === 1 && (
            <>
              <div className="panel-header">
                <div>
                  <div className="label-jp">歓迎</div>
                  <div className="panel-title">ยินดีต้อนรับ</div>
                </div>
              </div>
              <p style={{ fontSize: 14, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                KINTENSHAUTO คือเครื่องมือช่วยโพสต์ Reel บน Facebook อัตโนมัติ — ตั้งแต่หาคลิป ตัดต่อ ใส่แบนเนอร์ สร้างแคปชั่น AI ไปจนถึงโพสต์และคอมเม้นให้อัตโนมัติ
              </p>
              <div style={{ margin: '20px 0', padding: 14, background: 'rgba(212,167,72,0.08)', border: '0.5px solid var(--warning)', borderLeft: '3px solid var(--warning)' }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--warning)', marginBottom: 6 }}>⚠ คำเตือนสำคัญ</div>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                  <li>โปรแกรมนี้ใช้ automation ที่ Facebook อาจตรวจจับได้ — ใช้ด้วยความระมัดระวัง</li>
                  <li>ลงคลิปไม่เกินโควต้าที่กำหนด (default 5 คลิป/เพจ/วัน) เพื่อลดความเสี่ยง</li>
                  <li>เนื้อหาที่โพสต์ต้องเป็นของคุณหรือได้รับอนุญาต — ผู้ใช้รับผิดชอบเนื้อหาเอง</li>
                  <li>ถ้าติด checkpoint คนต้องยืนยันเอง ระบบไม่ bypass ให้</li>
                </ul>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
                <button className="btn-primary" onClick={() => setStep(2)}>เข้าใจแล้ว เริ่มเลย →</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="panel-header">
                <div>
                  <div className="label-jp">道具検査</div>
                  <div className="panel-title">ตรวจสอบเครื่องมือที่จำเป็น</div>
                  <div className="panel-subtitle">ต้องมี FFmpeg, yt-dlp, Chrome ก่อนใช้งาน</div>
                </div>
                <button onClick={checkDeps} disabled={depsInstalling}>↻ ตรวจซ้ำ</button>
              </div>

              {!deps && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>กำลังตรวจสอบ...</div>}

              {deps && deps.results && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {deps.results.map((r, i) => {
                    const prog = depsProgress[r.name.toLowerCase().replace(/\s.*/,'').replace('ffmpeg', 'ffmpeg').replace('yt-dlp', 'ytdlp')];
                    return (
                      <div key={i} style={{
                        padding: 12, border: `0.5px solid ${r.ok ? 'var(--success)' : (r.required ? 'var(--border-red)' : 'var(--border-soft)')}`,
                        background: r.ok ? 'rgba(123,184,102,0.05)' : (r.required ? 'rgba(232,123,123,0.05)' : 'transparent'),
                        display: 'flex', alignItems: 'center', gap: 12
                      }}>
                        <div style={{ fontSize: 18, color: r.ok ? 'var(--success)' : (r.required ? 'var(--danger)' : 'var(--warning)') }}>
                          {r.ok ? '✓' : (r.required ? '✗' : '○')}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                            {r.name} {r.version && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>v{r.version}</span>}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.description}</div>
                          {prog && prog.status === 'downloading' && (
                            <div style={{ marginTop: 6, height: 3, background: 'var(--surface-2)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${prog.pct || 0}%`, height: '100%', background: 'var(--gold)' }}/>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
                <button onClick={() => setStep(1)}>← ย้อนกลับ</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {deps && !deps.ready && deps.missingRequired?.some(n => n !== 'Chrome/Chromium') && (
                    <button className="btn-gold" onClick={installDeps} disabled={depsInstalling}>
                      {depsInstalling ? 'กำลังติดตั้ง...' : '⬇ ติดตั้งอัตโนมัติ'}
                    </button>
                  )}
                  <button className="btn-primary" onClick={() => setStep(3)} disabled={!deps?.ready}>
                    ถัดไป →
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="panel-header">
                <div>
                  <div className="label-jp">盟友追加</div>
                  <div className="panel-title">เพิ่มเฟส Facebook (ไม่บังคับ)</div>
                  <div className="panel-subtitle">ข้ามขั้นตอนนี้ได้ ค่อยเพิ่มใน app ทีหลัง</div>
                </div>
              </div>

              {skippedProfile ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                  ข้ามขั้นตอนนี้แล้ว — เพิ่มเฟสได้ภายหลังในเมนู "จัดการเฟส"
                  <div style={{ marginTop: 16 }}>
                    <button onClick={() => setSkippedProfile(false)}>ย้อนกลับมากรอก</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ gridColumn: '1 / 3' }}>
                    <label>ชื่อกำกับ *</label>
                    <input value={profile.name} onChange={e => setProfile({...profile, name: e.target.value})} placeholder="เช่น เฟสหลัก 1"/>
                  </div>
                  <div>
                    <label>FB username / email *</label>
                    <input value={profile.fb_username} onChange={e => setProfile({...profile, fb_username: e.target.value})}/>
                  </div>
                  <div>
                    <label>รหัสผ่าน *</label>
                    <input type="password" value={profile.fb_password} onChange={e => setProfile({...profile, fb_password: e.target.value})}/>
                  </div>
                  <div style={{ gridColumn: '1 / 3' }}>
                    <label>2FA secret (ถ้ามี - optional)</label>
                    <input value={profile.fb_2fa_secret} onChange={e => setProfile({...profile, fb_2fa_secret: e.target.value})} placeholder="TOTP secret (base32)"/>
                  </div>
                  <div className="jp-divider" style={{ gridColumn: '1 / 3' }}>プロキシ · Proxy (แนะนำ)</div>
                  <div>
                    <label>Proxy host</label>
                    <input value={profile.proxy_host} onChange={e => setProfile({...profile, proxy_host: e.target.value})}/>
                  </div>
                  <div>
                    <label>Port</label>
                    <input value={profile.proxy_port} onChange={e => setProfile({...profile, proxy_port: e.target.value})}/>
                  </div>
                  <div>
                    <label>Proxy user</label>
                    <input value={profile.proxy_user} onChange={e => setProfile({...profile, proxy_user: e.target.value})}/>
                  </div>
                  <div>
                    <label>Proxy pass</label>
                    <input type="password" value={profile.proxy_pass} onChange={e => setProfile({...profile, proxy_pass: e.target.value})}/>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
                <button onClick={() => setStep(2)}>← ย้อนกลับ</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {!skippedProfile && <button onClick={() => setSkippedProfile(true)}>ข้าม</button>}
                  <button className="btn-primary" onClick={() => setStep(4)}>ถัดไป →</button>
                </div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div className="panel-header">
                <div>
                  <div className="label-jp">知恵の源</div>
                  <div className="panel-title">ตั้งค่า AI สำหรับแคปชั่น (ไม่บังคับ)</div>
                  <div className="panel-subtitle">รองรับ OpenAI / Claude / Gemini — ข้ามได้</div>
                </div>
              </div>

              {skippedAI ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                  ข้ามขั้นตอนนี้แล้ว — ถ้าไม่ตั้ง AI ระบบจะใช้ template caption แทน
                  <div style={{ marginTop: 16 }}>
                    <button onClick={() => setSkippedAI(false)}>ย้อนกลับมากรอก</button>
                  </div>
                </div>
              ) : (
                <>
                  <label>Provider</label>
                  <select
                    value={aiConfig.provider}
                    onChange={e => {
                      const p = e.target.value;
                      const defaults = {
                        openai: 'gpt-4o-mini',
                        anthropic: 'claude-haiku-4-5-20251001',
                        gemini: 'gemini-2.0-flash'
                      };
                      setAiConfig({...aiConfig, provider: p, model: defaults[p]});
                    }}
                    style={{ marginBottom: 12 }}
                  >
                    <option value="openai">OpenAI (GPT)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="gemini">Google Gemini</option>
                  </select>

                  <label>Model</label>
                  <input value={aiConfig.model} onChange={e => setAiConfig({...aiConfig, model: e.target.value})} style={{ marginBottom: 12 }}/>

                  <label>API Key *</label>
                  <input
                    type="password"
                    value={aiConfig.api_key}
                    onChange={e => setAiConfig({...aiConfig, api_key: e.target.value})}
                    placeholder="sk-... หรือ key จาก provider"
                    style={{ marginBottom: 12 }}
                  />

                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 10, background: 'var(--surface-2)' }}>
                    💡 API key จะถูก encrypt เก็บในเครื่องคุณเท่านั้น ไม่ถูกส่งออกไปไหน
                  </div>
                </>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
                <button onClick={() => setStep(3)}>← ย้อนกลับ</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {!skippedAI && <button onClick={() => setSkippedAI(true)}>ข้าม</button>}
                  <button className="btn-primary" onClick={() => setStep(5)}>ถัดไป →</button>
                </div>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <div className="panel-header">
                <div>
                  <div className="label-jp">出陣</div>
                  <div className="panel-title">พร้อมใช้งาน</div>
                  <div className="panel-subtitle">การตั้งค่าเริ่มต้นเสร็จสิ้น</div>
                </div>
              </div>

              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div className="kanji-title" style={{ fontSize: 60, marginBottom: 8 }}>出陣</div>
                <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 20 }}>
                  ทุกอย่างพร้อมแล้ว — ลุยกันเลย!
                </div>
              </div>

              <div style={{ background: 'var(--surface-2)', padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>ขั้นตอนถัดไปหลังเข้า app:</div>
                <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                  <li>ไปเมนู "จัดการเฟส" → login เฟส FB (คนยืนยันเอง)</li>
                  <li>ไปเมนู "แบนเนอร์" → upload รูปแบนเนอร์ + ตั้งตำแหน่ง</li>
                  <li>ไปเมนู "คอมเม้นอัตโนมัติ" → สร้าง template</li>
                  <li>กลับหน้าหลัก → เลือกเพจ + keyword → กด RUN</li>
                </ol>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
                <button onClick={() => setStep(4)}>← ย้อนกลับ</button>
                <button className="btn-primary" style={{ padding: '12px 32px' }} onClick={saveProfileAndAI}>
                  ⚔ เข้าสู่โปรแกรม
                </button>
              </div>
            </>
          )}

        </div>

        <div style={{ marginTop: 20, fontSize: 11, color: 'var(--text-dim)', letterSpacing: 1 }}>
          v1.0.0 · ขั้นตอน {step}/5
        </div>
      </div>
    </div>
  );
}
