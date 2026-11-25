/**
 * Canvas drawing for the UNS topology. Stateless: everything it needs comes in
 * through `st`, and every colour comes from `st.theme` (see unsTheme.js).
 */
import { resolveIconName, getIconImage } from './unsIcons';
import { nodeLevel } from './unsLevels';
import { LIVE_WINDOW_MS, unsLiveMap, unsRateMap, unsValueMap, staleness } from './unsLive';
import { R, COL_W, nodeKey } from './unsLayout';
import { ellipsize } from './canvasKit';
import { FONT, MONO } from './canvasTokens';

export { FONT, MONO };

const PULSE_MS = 700; // node ring flash right after a message

// Widest a label may be: a column minus a gutter, so neighbouring columns never collide.
export const LABEL_MAX_W = COL_W - 40;
// Pager of a long branch: from this zoom the DOM controls cover its slot.
export const PAGER_DOM_K = 0.45;
// World width of the pager pill drawn below PAGER_DOM_K.
export const PAGER_W = COL_W + 60;

/** Icon raster size bucket (device px) for an icon drawn `px` device pixels wide. */
export function iconRasterSize(px) {
  if (!(px > 40)) return 40;
  if (px <= 80) return 80;
  if (px <= 160) return 160;
  return 256;
}

/** "1 topic", "2 topics", "1,234 topics". */
export function countLabel(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

export function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Rate caption: one decimal under 10 msg/s, none above (design system data rule). */
export function rateLabel(r) {
  if (!(r > 0)) return '';
  return `${r < 10 ? r.toFixed(1) : Math.round(r).toLocaleString()} msg/s`;
}

/**
 * State marker drawn on a leaf badge. Shape carries the state as well as hue
 * (never colour alone): publishing = filled circle, overdue = triangle,
 * dead = square.
 */
export function drawStateMarker(ctx, x, y, state, theme, s = 4) {
  const color = state === 'live' ? theme.statusLive : state === 'overdue' ? theme.statusOverdue : theme.statusDead;
  ctx.beginPath();
  if (state === 'live') ctx.arc(x, y, s, 0, Math.PI * 2);
  else if (state === 'overdue') {
    ctx.moveTo(x, y - s * 1.25);
    ctx.lineTo(x + s * 1.2, y + s * 0.9);
    ctx.lineTo(x - s * 1.2, y + s * 0.9);
    ctx.closePath();
  } else ctx.rect(x - s * 0.9, y - s * 0.9, s * 1.8, s * 1.8);
  ctx.fillStyle = color;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = theme.statusRing;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fill();
}

/**
 * Draw one frame.
 * st: { w, h, dpr, dprY?, t:{x,y,k}, layout, posOf, theme, levels, tokens, selectedId, hoverKey, selKeys, box, now, reducedMotion? }
 * dpr / dprY are the backing-store / CSS-size ratios (see canvasKit.applyCanvasSize).
 */
export function drawTopology(ctx, st) {
  const { w, h, dpr, t, layout, posOf, theme, levels, tokens, selectedId, hoverKey = null, selKeys, box, now, reducedMotion = false } = st;
  const dprY = st.dprY || dpr;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dprY, 0, 0);

  // Canvas = the page surface, with a quiet dot grid that pans with the content.
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  const grid = 24 * t.k;
  if (grid > 9) {
    ctx.fillStyle = theme.dot;
    const ox = t.x % grid;
    const oy = t.y % grid;
    const d = 1.25;
    for (let gx = ox; gx < w; gx += grid) {
      for (let gy = oy; gy < h; gy += grid) ctx.fillRect(Math.round(gx * dpr) / dpr - d / 2, Math.round(gy * dprY) / dprY - d / 2, d, d);
    }
  }

  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);

  const liveAt = (n) => unsLiveMap.get(`${n.brokerId}:${n.path}`) || 0;
  const dashOffset = reducedMotion ? 0 : -((now / 40) % 22);
  // Level of detail: tiny text is noise, so drop caption lines when zoomed far out.
  const showCaption = t.k >= 0.45;
  const showName = t.k >= 0.28;

  // Visible world rect (+ the label block margin) — off-screen nodes/edges are skipped.
  const vx0 = -t.x / t.k - COL_W;
  const vy0 = -t.y / t.k - 80;
  const vx1 = (w - t.x) / t.k + COL_W;
  const vy1 = (h - t.y) / t.k + 80;
  const onScreen = (p) => p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1;

  // Edges first: a hairline at rest; a dashed, moving line in the good colour
  // while the child branch publishes (dash + motion, not hue alone).
  const hair = 1 / t.k;
  for (const e of layout.edges) {
    const live = now - liveAt(e.to.node) < LIVE_WINDOW_MS;
    const a = posOf(e.from);
    const b = posOf(e.to);
    if (Math.max(a.x, b.x) < vx0 || Math.min(a.x, b.x) > vx1 || Math.max(a.y, b.y) < vy0 || Math.min(a.y, b.y) > vy1) continue;
    const x1 = a.x + R + 2;
    const x2 = b.x - R - 2;
    const mx = (x1 + x2) / 2;
    ctx.beginPath();
    ctx.moveTo(x1, a.y);
    ctx.bezierCurveTo(mx, a.y, mx, b.y, x2, b.y);
    if (e.to.pager) {
      ctx.strokeStyle = theme.edge;
      ctx.lineWidth = Math.max(1, hair);
      ctx.setLineDash([3, 4]);
    } else if (live) {
      ctx.strokeStyle = theme.edgeLive;
      ctx.lineWidth = Math.max(1.5, 1.25 * hair);
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = dashOffset;
    } else {
      ctx.strokeStyle = theme.edge;
      ctx.lineWidth = Math.max(1, hair);
      ctx.setLineDash([]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const [pr, pg, pb] = theme.pulse;
  const iconPx = iconRasterSize(20 * t.k * dpr);
  for (const l of layout.nodes) {
    const n = l.node;
    const P = posOf(l);
    if (!onScreen(P)) continue;
    if (l.pager) {
      // Pager slot of a long branch. From PAGER_DOM_K up the page lays real
      // controls (DOM) over it; below that, a quiet pill with the range.
      if (t.k >= PAGER_DOM_K) continue;
      const wPill = PAGER_W;
      ctx.beginPath();
      ctx.roundRect(P.x - R, P.y - 16, wPill, 32, 6);
      ctx.fillStyle = theme.badgeFill;
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = theme.toggleStroke;
      ctx.lineWidth = 1.25 / Math.min(1, t.k);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!showName) continue;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `500 13px ${FONT}`;
      ctx.fillStyle = theme.name;
      ctx.fillText(ellipsize(ctx, n.name, wPill - 24), P.x - R + 12, P.y);
      continue;
    }
    const lvl = nodeLevel(n, levels, tokens || theme.mode);
    const color = lvl.color;
    const last = liveAt(n);
    const pulsing = !reducedMotion && now - last < PULSE_MS;
    const live = now - last < LIVE_WINDOW_MS;
    const key = nodeKey(n);
    const isSel = n.id === selectedId;
    const isMulti = selKeys.has(key);
    const isHover = hoverKey === key;

    // Selection: a soft accent halo plus an accent ring (the same accent as DOM focus).
    if (isSel || isMulti) {
      ctx.beginPath();
      ctx.arc(P.x, P.y, R + 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${isSel ? theme.selectedHalo : theme.multiSel},0.16)`;
      ctx.fill();
      if (isMulti && !isSel) {
        ctx.strokeStyle = `rgba(${theme.multiSel},0.9)`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (isHover) {
      ctx.beginPath();
      ctx.arc(P.x, P.y, R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = theme.hover;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (pulsing) {
      const p = 1 - (now - last) / PULSE_MS;
      ctx.beginPath();
      ctx.arc(P.x, P.y, R + 3 + 7 * (1 - p), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${pr},${pg},${pb},${0.55 * p})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Badge: a solid panel disc with a level-coloured ring. No drop shadow.
    ctx.beginPath();
    ctx.arc(P.x, P.y, R, 0, Math.PI * 2);
    ctx.fillStyle = theme.badgeFill;
    ctx.fill();
    ctx.lineWidth = isSel ? 2.5 : 1.75;
    ctx.strokeStyle = isSel ? theme.selected : color;
    ctx.stroke();

    // Rasterize the SVG icon near the size it lands on screen (zoom x DPR): a
    // 40px raster drawn at zoom 3 on a 2x display was a 132px blur. While a
    // bigger raster decodes, the 40px one stands in.
    const iconName = resolveIconName(n);
    let iconImg = getIconImage(iconName, color, iconPx);
    if (iconPx !== 40 && !(iconImg && iconImg.complete && iconImg.naturalWidth > 0)) iconImg = getIconImage(iconName, color, 40);
    if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
      ctx.drawImage(iconImg, P.x - 10, P.y - 10, 20, 20);
    } else {
      drawGlyph(ctx, P.x, P.y, n.depth, color);
    }

    // State marker on leaves (shape + colour): publishing / overdue / dead.
    const stale = n.children.size === 0 ? staleness(n, now) : null;
    const state = live ? 'live' : stale === 'dead' ? 'dead' : stale === 'overdue' ? 'overdue' : null;
    if (state) drawStateMarker(ctx, P.x + R * 0.72, P.y - R * 0.72, state, theme, 3.6);

    if (l.hasKids) {
      const ty = P.y + R;
      ctx.beginPath();
      ctx.arc(P.x, ty, 6, 0, Math.PI * 2);
      ctx.fillStyle = theme.toggleFill;
      ctx.fill();
      ctx.strokeStyle = theme.toggleStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = theme.toggleInk;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(P.x - 2.75, ty);
      ctx.lineTo(P.x + 2.75, ty);
      if (!l.open) {
        ctx.moveTo(P.x, ty - 2.75);
        ctx.lineTo(P.x, ty + 2.75);
      }
      ctx.stroke();
    }

    if (!showName) continue;
    // Labels get a surface-coloured halo so crossing edges never block the text.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.halo;
    ctx.lineWidth = 4;
    ctx.font = `500 13px ${FONT}`;
    const name = ellipsize(ctx, n.name, LABEL_MAX_W);
    ctx.strokeText(name, P.x, P.y + R + 24);
    ctx.fillStyle = theme.name;
    ctx.fillText(name, P.x, P.y + R + 24);
    if (!showCaption) continue;
    ctx.font = `400 11px ${FONT}`;
    const caption = ellipsize(ctx, lvl.name, LABEL_MAX_W);
    ctx.strokeText(caption, P.x, P.y + R + 38);
    ctx.fillStyle = theme.sub;
    ctx.fillText(caption, P.x, P.y + R + 38);
    if (n.children.size > 0) {
      if (n.topicCount > 0) {
        const rate = unsRateMap.get(key) || 0;
        let line = rate > 0 ? `${countLabel(n.topicCount, 'topic')} · ${rateLabel(rate)}` : countLabel(n.topicCount, 'topic');
        ctx.font = `400 11px ${FONT}`;
        line = ellipsize(ctx, line, LABEL_MAX_W);
        ctx.strokeText(line, P.x, P.y + R + 52);
        ctx.fillStyle = rate > 0 ? theme.rate : theme.count;
        ctx.fillText(line, P.x, P.y + R + 52);
      }
    } else {
      // Leaf: the topic's latest VALUE, so the namespace doubles as a dashboard.
      const v = unsValueMap.get(key);
      if (v && v.value !== '') {
        ctx.font = `500 11px ${MONO}`;
        const text = ellipsize(ctx, v.display ?? v.value, LABEL_MAX_W);
        ctx.strokeText(text, P.x, P.y + R + 52);
        ctx.fillStyle = stale === 'dead' ? theme.valueDead : stale === 'overdue' ? theme.valueOverdue : theme.value;
        ctx.fillText(text, P.x, P.y + R + 52);
      }
    }
  }

  // Rubber-band selection box (world space; hairline at any zoom).
  if (box) {
    const x = Math.min(box.x1, box.x2);
    const y = Math.min(box.y1, box.y2);
    ctx.fillStyle = `rgba(${theme.multiSel},0.08)`;
    ctx.fillRect(x, y, Math.abs(box.x2 - box.x1), Math.abs(box.y2 - box.y1));
    ctx.strokeStyle = `rgba(${theme.multiSel},0.8)`;
    ctx.lineWidth = 1 / t.k;
    ctx.setLineDash([4 / t.k, 3 / t.k]);
    ctx.strokeRect(x, y, Math.abs(box.x2 - box.x1), Math.abs(box.y2 - box.y1));
    ctx.setLineDash([]);
  }

  ctx.restore();
}

// Small geometric glyphs per hierarchy level, drawn directly on canvas until
// the icon set has rasterized.
export function drawGlyph(ctx, x, y, depth, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  const d = Math.min(depth, 6);
  if (d === 0) {
    ctx.strokeRect(x - 3.5, y - 8, 7, 5.5);
    ctx.strokeRect(x - 9.5, y + 2.5, 7, 5.5);
    ctx.strokeRect(x + 2.5, y + 2.5, 7, 5.5);
    ctx.beginPath();
    ctx.moveTo(x, y - 2.5);
    ctx.lineTo(x, y + 0.5);
    ctx.moveTo(x - 6, y + 0.5);
    ctx.lineTo(x + 6, y + 0.5);
    ctx.moveTo(x - 6, y + 0.5);
    ctx.lineTo(x - 6, y + 2.5);
    ctx.moveTo(x + 6, y + 0.5);
    ctx.lineTo(x + 6, y + 2.5);
    ctx.stroke();
  } else if (d === 1) {
    for (const [cx, cy] of [[0, -4.5], [-4.5, 3], [4.5, 3]]) {
      ctx.beginPath();
      ctx.arc(x + cx, y + cy, 3.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (d === 2) {
    ctx.beginPath();
    ctx.moveTo(x - 8, y + 7);
    ctx.lineTo(x - 8, y - 1);
    ctx.lineTo(x - 3, y - 5);
    ctx.lineTo(x - 3, y - 1);
    ctx.lineTo(x + 2, y - 5);
    ctx.lineTo(x + 2, y - 1);
    ctx.lineTo(x + 8, y - 1);
    ctx.lineTo(x + 8, y + 7);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeRect(x + 4, y - 8, 2.6, 5);
  } else if (d === 3) {
    for (const [gx, gy] of [[-6.5, -6.5], [1.5, -6.5], [-6.5, 1.5], [1.5, 1.5]]) ctx.strokeRect(x + gx, y + gy, 5, 5);
  } else if (d === 4) {
    for (let i = -1; i <= 1; i++) ctx.strokeRect(x - 7, y + i * 5 - 1.5, 14, 3);
  } else if (d === 5) {
    ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
