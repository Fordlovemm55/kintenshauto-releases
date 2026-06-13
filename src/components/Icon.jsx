import React from 'react';
import {
  Home, ListChecks, ClipboardCheck, Users, Image, MessageCircle, Sparkles,
  Settings, Radar, FolderInput, Inbox, Clock, Send,
} from 'lucide-react';

// Maps the app's legacy icon names (nav keys + empty-state keys) to crisp
// lucide outline icons, so call sites keep using <Icon name="icon-home" /> etc.
const MAP = {
  'icon-home': Home,
  'icon-queue': ListChecks,
  'icon-reviews': ClipboardCheck,
  'icon-profiles': Users,
  'icon-banners': Image,
  'icon-comments': MessageCircle,
  'icon-ai': Sparkles,
  'icon-settings': Settings,
  'icon-watcher': Radar,
  'icon-localclips': FolderInput,
  'empty-generic': Inbox,
  'empty-queue': Clock,
  'empty-reviews': ClipboardCheck,
  'empty-banners': Image,
  'empty-comments': MessageCircle,
  'empty-watcher': Radar,
};

export default function Icon({ name, size = 20, className, strokeWidth = 1.75, style }) {
  const Cmp = MAP[name] || Inbox;
  return <Cmp size={size} className={className} strokeWidth={strokeWidth} style={style} aria-hidden="true" />;
}

// Clean brand mark — a rounded indigo tile with a white "send" glyph (auto-post).
export function LogoMark({ size = 38, radius = 11 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: radius,
      background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 4px 12px rgba(79,70,229,0.45)', flexShrink: 0,
    }}>
      <Send size={Math.round(size * 0.5)} color="#ffffff" strokeWidth={2} aria-hidden="true" />
    </div>
  );
}
