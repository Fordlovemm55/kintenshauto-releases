import React from 'react';

/**
 * App backdrop — a flat dark-slate scene with a subtle indigo glow.
 * Professional "Dark Slate" theme: no artwork image, no candy gradient.
 * variant kept for call-site compatibility (app/login/setup) but the look is uniform.
 */
export default function SamuraiBackground({ opacity = 1 }) {
  return (
    <div
      className="bg-scene"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        opacity,
        background:
          'radial-gradient(1200px 620px at 50% -12%, rgba(99,102,241,0.12), transparent 60%),' +
          'radial-gradient(900px 520px at 100% 0%, rgba(56,189,248,0.05), transparent 60%),' +
          '#0f172a',
      }}
    />
  );
}
