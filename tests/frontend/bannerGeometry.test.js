import { describe, it, expect } from 'vitest';
import { clamp, layerToBox, boxToLayer } from '../../src/lib/bannerGeometry.js';

const frame = { w: 270, h: 480 };
const aspect = 0.5; // banner intrinsic height = 0.5 * width

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('layerToBox', () => {
  it('centers at x=50,y=50 and sizes by width% + aspect', () => {
    const b = layerToBox({ position: { x: 50, y: 50 }, size: { width: 50 } }, frame, aspect);
    expect(b.width).toBeCloseTo(135);   // 50% of 270
    expect(b.height).toBeCloseTo(67.5); // 135 * 0.5
    expect(b.left).toBeCloseTo(67.5);   // (270-135)*0.5
    expect(b.top).toBeCloseTo(206.25);  // (480-67.5)*0.5
  });
  it('is flush left/top at x=0,y=0', () => {
    const b = layerToBox({ position: { x: 0, y: 0 }, size: { width: 50 } }, frame, aspect);
    expect(b.left).toBe(0);
    expect(b.top).toBe(0);
  });
  it('is flush right/bottom at x=100,y=100', () => {
    const b = layerToBox({ position: { x: 100, y: 100 }, size: { width: 50 } }, frame, aspect);
    expect(b.left).toBeCloseTo(135);
    expect(b.top).toBeCloseTo(412.5);
  });
  it('applies defaults when fields are missing', () => {
    const b = layerToBox({}, frame, aspect);
    expect(b.width).toBeCloseTo(81);    // default 30% of 270
    expect(b.rotation).toBe(0);
  });
});

describe('boxToLayer', () => {
  it('is the inverse of layerToBox (round-trip)', () => {
    const layer = { position: { x: 30, y: 70 }, size: { width: 40 } };
    const box = layerToBox(layer, frame, aspect);
    expect(boxToLayer(box, frame, aspect)).toEqual({ x: 30, y: 70, width: 40 });
  });
  it('clamps out-of-range pixels to 0..100', () => {
    const back = boxToLayer({ left: -50, top: 9999, width: 100 }, frame, aspect);
    expect(back.x).toBe(0);
    expect(back.y).toBe(100);
  });
  it('returns x=0 when the banner fills the frame width (no slack)', () => {
    const back = boxToLayer({ left: 0, top: 0, width: 270 }, frame, aspect);
    expect(back.x).toBe(0);
    expect(back.width).toBe(100);
  });
  it('clamps width to 5..100', () => {
    expect(boxToLayer({ left: 0, top: 0, width: 5 }, frame, aspect).width).toBe(5);
  });
});
