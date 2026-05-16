import React from 'react';

/**
 * SamuraiBackground - พื้นหลัง SVG เคลื่อนไหว
 *
 * ประกอบด้วย:
 * - ท้องฟ้าไล่สี (sunset gradient)
 * - ภูเขาซ้อนชั้น
 * - โทริอิ (ประตูศาลเจ้า)
 * - ต้นซากุระ
 * - โคมไฟกระพริบ
 * - ตัวละครซามูไร (หายใจ, เสื้อคลุมไหว, ดาบเรืองแสง)
 * - ใบซากุระร่วง 11 ใบ
 * - พระจันทร์เต้น
 *
 * Usage: <SamuraiBackground /> วางในตำแหน่ง absolute inset-0 z-index:0
 */

const PETALS = [
  { x: 40, dur: 11, delay: 0, size: 4, drift: 40 },
  { x: 140, dur: 14, delay: 2, size: 3.5, drift: -30 },
  { x: 230, dur: 10, delay: 4, size: 4.5, drift: 50 },
  { x: 320, dur: 13, delay: 1, size: 3.8, drift: -20 },
  { x: 410, dur: 12, delay: 3, size: 4.2, drift: 35 },
  { x: 510, dur: 15, delay: 5, size: 3.5, drift: -45 },
  { x: 610, dur: 9,  delay: 6, size: 4, drift: 25 },
  { x: 710, dur: 13, delay: 7, size: 3.8, drift: -35 },
  { x: 810, dur: 11, delay: 8, size: 4.5, drift: 40 },
  { x: 910, dur: 14, delay: 2.5, size: 3.5, drift: -25 },
  { x: 80,  dur: 10, delay: 4.5, size: 4, drift: 30 }
];

const STARS = [
  { cx: 80, cy: 60, r: 0.8 }, { cx: 150, cy: 90, r: 0.6 },
  { cx: 240, cy: 45, r: 0.9 }, { cx: 340, cy: 75, r: 0.7 },
  { cx: 450, cy: 40, r: 0.8 }, { cx: 620, cy: 70, r: 0.7 },
  { cx: 180, cy: 130, r: 0.6 }, { cx: 380, cy: 150, r: 0.8 },
  { cx: 720, cy: 55, r: 0.8 }, { cx: 900, cy: 85, r: 0.7 },
  { cx: 1100, cy: 50, r: 0.8 }, { cx: 1280, cy: 110, r: 0.6 }
];

export default function SamuraiBackground({ opacity = 1, hideSamurai = false }) {
  return (
    <div
      className="bg-scene"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        opacity,
        overflow: 'hidden'
      }}
    >
      <style>{`
        @keyframes sakura-fall-bg {
          0%   { transform: translate(0,-30px) rotate(0deg); opacity: 0; }
          10%  { opacity: 0.85; }
          90%  { opacity: 0.85; }
          100% { transform: translate(var(--drift,30px), calc(100vh + 40px)) rotate(360deg); opacity: 0; }
        }
        @keyframes breathe-bg {
          0%,100% { transform: translateY(0) scaleY(1); }
          50% { transform: translateY(-1px) scaleY(1.015); }
        }
        @keyframes cape-sway-bg {
          0%,100% { transform: skewX(-2deg); }
          50% { transform: skewX(2deg); }
        }
        @keyframes sword-glow-bg {
          0%,100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        @keyframes moon-pulse-bg {
          0%,100% { opacity: 0.9; }
          50% { opacity: 1; }
        }
        @keyframes lantern-flicker-bg {
          0%,100% { opacity: 0.85; }
          45% { opacity: 1; }
          55% { opacity: 0.7; }
        }
        .petal-bg { animation: sakura-fall-bg linear infinite; transform-origin: center; }
        .samurai-body-bg { animation: breathe-bg 3.5s ease-in-out infinite; transform-origin: bottom center; }
        .samurai-cape-bg { animation: cape-sway-bg 4s ease-in-out infinite; transform-origin: top center; }
        .sword-glow-bg { animation: sword-glow-bg 2.2s ease-in-out infinite; }
        .moon-bg { animation: moon-pulse-bg 4s ease-in-out infinite; }
        .lantern-bg { animation: lantern-flicker-bg 2.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .petal-bg, .samurai-body-bg, .samurai-cape-bg,
          .sword-glow-bg, .moon-bg, .lantern-bg { animation: none; }
        }
      `}</style>

      <svg
        width="100%" height="100%"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', inset: 0 }}
      >
        <defs>
          <linearGradient id="skyBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1a0a1e"/>
            <stop offset="40%" stopColor="#3a1a2e"/>
            <stop offset="75%" stopColor="#6b2a3a"/>
            <stop offset="100%" stopColor="#8b3a3a"/>
          </linearGradient>
          <linearGradient id="mountBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2a1e2e"/>
            <stop offset="100%" stopColor="#1a0f1a"/>
          </linearGradient>
          <linearGradient id="mountBg2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3a2a3e"/>
            <stop offset="100%" stopColor="#221722"/>
          </linearGradient>
          <radialGradient id="moonBg" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#ffd4a8"/>
            <stop offset="60%" stopColor="#d48a5a"/>
            <stop offset="100%" stopColor="#8a3a2a"/>
          </radialGradient>
        </defs>

        <rect x="0" y="0" width="1440" height="900" fill="url(#skyBg)"/>

        <circle cx="1140" cy="180" r="60" fill="url(#moonBg)" className="moon-bg"/>
        <circle cx="1140" cy="180" r="60" fill="none" stroke="#ffd4a8" strokeWidth="0.5" opacity="0.3" className="moon-bg"/>

        <g opacity="0.4">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="#fff"/>
          ))}
        </g>

        <path d="M 0 500 L 240 370 L 380 410 L 520 330 L 680 420 L 880 360 L 1080 430 L 1280 370 L 1440 420 L 1440 600 L 0 600 Z" fill="url(#mountBg2)" opacity="0.7"/>
        <path d="M 0 550 L 200 440 L 360 490 L 500 420 L 680 500 L 880 450 L 1080 510 L 1280 460 L 1440 500 L 1440 620 L 0 620 Z" fill="url(#mountBg)"/>

        <g transform="translate(140,480)">
          <rect x="18" y="30" width="8" height="100" fill="#6b1a1a"/>
          <rect x="82" y="30" width="8" height="100" fill="#6b1a1a"/>
          <rect x="8" y="20" width="92" height="10" fill="#4a0f0f"/>
          <rect x="4" y="12" width="100" height="10" fill="#6b1a1a"/>
          <rect x="0" y="4" width="108" height="10" fill="#4a0f0f"/>
          <rect x="14" y="60" width="80" height="4" fill="#4a0f0f"/>
        </g>

        <g transform="translate(1100,450)" opacity="0.85">
          <path d="M 0 100 L 0 50 Q 0 30 10 25 L 10 5 L 25 5 L 25 25 Q 35 30 35 50 L 35 100 Z" fill="#2a1a2a"/>
          <path d="M -15 50 L 50 50 L 55 40 L -20 40 Z" fill="#6b1a1a"/>
          <circle cx="17" cy="60" r="4" fill="#ffcc66" className="lantern-bg"/>
        </g>

        <g transform="translate(950,430)" opacity="0.75">
          <path d="M 0 120 Q -2 100 -3 80 Q -4 60 -2 40 Q 0 20 2 0" stroke="#3a2028" strokeWidth="3" fill="none"/>
          <path d="M 2 0 Q 8 -5 15 -3 Q 10 2 2 0" fill="#3a2028"/>
          <path d="M -3 40 Q -8 35 -15 38 Q -10 45 -3 42" fill="#3a2028"/>
          <circle cx="8" cy="-2" r="3" fill="#ffb7c5" opacity="0.8"/>
          <circle cx="15" cy="-5" r="2.5" fill="#ffc8d4" opacity="0.8"/>
          <circle cx="3" cy="-8" r="2.8" fill="#ffa8bb" opacity="0.8"/>
          <circle cx="-10" cy="42" r="2.5" fill="#ffb7c5" opacity="0.8"/>
          <circle cx="-14" cy="38" r="2" fill="#ffc8d4" opacity="0.8"/>
        </g>

        {!hideSamurai && (
          <g transform="translate(340,470)">
            <g className="samurai-cape-bg">
              <path d="M -22 20 Q -30 80 -18 120 L 18 120 Q 30 80 22 20 Z" fill="#1a0508" opacity="0.9"/>
            </g>
            <g className="samurai-body-bg">
              <ellipse cx="0" cy="120" rx="20" ry="4" fill="#000" opacity="0.3"/>
              <rect x="-3" y="105" width="6" height="15" fill="#2a1a1a"/>
              <rect x="-15" y="70" width="30" height="40" rx="3" fill="#1a0a0d"/>
              <rect x="-18" y="73" width="36" height="4" fill="#6b1a1a"/>
              <rect x="-12" y="85" width="24" height="1.5" fill="#4a0f0f"/>
              <rect x="-12" y="92" width="24" height="1.5" fill="#4a0f0f"/>
              <rect x="-19" y="72" width="8" height="28" rx="2" fill="#1a0a0d"/>
              <rect x="11" y="72" width="8" height="28" rx="2" fill="#1a0a0d"/>
              <circle cx="0" cy="58" r="10" fill="#1a0a0d"/>
              <path d="M -12 52 L 12 52 L 10 46 L -10 46 Z" fill="#6b1a1a"/>
              <path d="M -10 46 Q 0 40 10 46" fill="#6b1a1a"/>
              <rect x="-1.5" y="56" width="3" height="1" fill="#ffcc66" className="sword-glow-bg"/>
              <rect x="-1.5" y="60" width="3" height="1" fill="#ffcc66" className="sword-glow-bg"/>
              <g transform="translate(14,85) rotate(15)">
                <rect x="0" y="-30" width="1.5" height="60" fill="#c0c0d0" className="sword-glow-bg"/>
                <rect x="-3" y="30" width="7.5" height="3" fill="#6b1a1a"/>
                <rect x="-2" y="33" width="5.5" height="8" fill="#2a1a1a"/>
              </g>
            </g>
          </g>
        )}
      </svg>

      {PETALS.map((p, i) => (
        <div
          key={i}
          className="petal-bg"
          style={{
            position: 'absolute',
            top: '-20px',
            left: `${(p.x / 1440) * 100}%`,
            width: `${p.size * 2}px`,
            height: `${p.size * 1.2}px`,
            background: i % 3 === 0 ? '#ffb7c5' : (i % 3 === 1 ? '#ffc8d4' : '#ffa8bb'),
            borderRadius: '50% 0 50% 0',
            animationDuration: `${p.dur}s`,
            animationDelay: `${p.delay}s`,
            opacity: 0.7,
            '--drift': `${p.drift}px`
          }}
        />
      ))}
    </div>
  );
}
