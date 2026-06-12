// Pure px <-> percentage conversions for the banner preview canvas.
// Mirrors bannerLayerSystem.js / ffmpeg overlay math so the preview matches output:
//   banner width(px) = frameW * size.width/100   (height preserves the image aspect)
//   overlay x(px)    = (frameW - bannerW) * position.x/100   (0 = flush left, 100 = flush right)
//   overlay y(px)    = (frameH - bannerH) * position.y/100

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// layer -> pixel box on a frame {w,h}; imgAspect = imgHeightPx / imgWidthPx
export function layerToBox(layer, frame, imgAspect) {
  const widthPct = layer?.size?.width ?? 30;
  const xPct = layer?.position?.x ?? 50;
  const yPct = layer?.position?.y ?? 50;
  const width = frame.w * (widthPct / 100);
  const height = width * imgAspect;
  const slackX = frame.w - width;
  const slackY = frame.h - height;
  return {
    left: slackX * (xPct / 100),
    top: slackY * (yPct / 100),
    width,
    height,
    rotation: layer?.rotation ?? 0,
  };
}

// pixel box (from a drag/resize) -> layer percentages, clamped to valid ranges
export function boxToLayer(box, frame, imgAspect) {
  const width = box.width;
  const height = width * imgAspect;
  const slackX = frame.w - width;
  const slackY = frame.h - height;
  return {
    x: slackX > 0 ? Math.round(clamp((box.left / slackX) * 100, 0, 100)) : 0,
    y: slackY > 0 ? Math.round(clamp((box.top / slackY) * 100, 0, 100)) : 0,
    width: Math.round(clamp((width / frame.w) * 100, 5, 100)),
  };
}
