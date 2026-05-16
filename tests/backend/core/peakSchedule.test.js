import { describe, it, expect } from 'vitest';
import {
  PEAK_SLOTS,
  nextPeakSlotAfter,
  planClipSchedule,
  toSqlLocal,
  friendlyThaiDate
} from '../../../src/backend/peakSchedule.js';

describe('peakSchedule', () => {
  describe('PEAK_SLOTS', () => {
    it('exposes 5 slots ordered by time of day', () => {
      expect(PEAK_SLOTS).toHaveLength(5);
      expect(PEAK_SLOTS.map(s => s.hour)).toEqual([7, 12, 18, 20, 22]);
    });
  });

  describe('nextPeakSlotAfter', () => {
    it('picks 07:00 slot when called at 06:00 with no cooldown', () => {
      const after = new Date(2026, 4, 16, 6, 0, 0); // May 16, 06:00 local
      const { date, slot } = nextPeakSlotAfter(after, 0);
      expect(slot.hour).toBe(7);
      expect(date.getHours()).toBe(7);
      expect(date.getMinutes()).toBe(0);
      expect(date.getDate()).toBe(16);
    });

    it('skips to next day 07:00 when called at 22:30 (after last slot)', () => {
      const after = new Date(2026, 4, 16, 22, 30, 0);
      const { date, slot } = nextPeakSlotAfter(after, 0);
      expect(slot.hour).toBe(7);
      expect(date.getDate()).toBe(17);
    });

    it('respects cooldown — skips slot too close to lastTime', () => {
      const after = new Date(2026, 4, 16, 7, 0, 0); // exactly 07:00
      const { slot } = nextPeakSlotAfter(after, 30); // 30 min cooldown
      // Earliest = 07:30, so 12:30 slot is the next valid
      expect(slot.hour).toBe(12);
      expect(slot.minute).toBe(30);
    });
  });

  describe('planClipSchedule', () => {
    it('plans N clips at consecutive peak slots', () => {
      const start = new Date(2026, 4, 16, 6, 0, 0); // 06:00 May 16
      const plan = planClipSchedule(3, start, 30);
      expect(plan).toHaveLength(3);
      expect(plan[0].slot.hour).toBe(7);
      expect(plan[1].slot.hour).toBe(12);
      expect(plan[2].slot.hour).toBe(18);
    });
  });

  describe('toSqlLocal', () => {
    it('formats date as YYYY-MM-DD HH:MM:SS local time', () => {
      const d = new Date(2026, 4, 16, 7, 5, 30); // May 16, 07:05:30
      expect(toSqlLocal(d)).toBe('2026-05-16 07:05:30');
    });

    it('zero-pads single-digit values', () => {
      const d = new Date(2026, 0, 1, 0, 0, 0); // Jan 1, 00:00:00
      expect(toSqlLocal(d)).toBe('2026-01-01 00:00:00');
    });
  });

  describe('friendlyThaiDate', () => {
    it('returns "วันนี้ HH:MM" for same-day date', () => {
      const ref = new Date(2026, 4, 16, 8, 0, 0);
      const target = new Date(2026, 4, 16, 20, 0, 0);
      expect(friendlyThaiDate(target, ref)).toBe('วันนี้ 20:00');
    });

    it('returns "พรุ่งนี้ HH:MM" for tomorrow', () => {
      const ref = new Date(2026, 4, 16, 8, 0, 0);
      const target = new Date(2026, 4, 17, 12, 30, 0);
      expect(friendlyThaiDate(target, ref)).toBe('พรุ่งนี้ 12:30');
    });
  });
});
