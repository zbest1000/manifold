/**
 * Canvas drawing for the UNS topology. Stateless: everything it needs comes in
 * through `st`, and every colour comes from `st.theme` (see unsTheme.js).
 */
import { resolveIconName, getIconImage } from './unsIcons';
import { nodeLevel } from './unsLevels';
import { LIVE_WINDOW_MS, unsLiveMap, unsRateMap, unsValueMap, staleness } from './unsLive';
import { R, nodeKey } from './unsLayout';

const PULSE_MS = 700; // node ring flash right after a message
const FONT = 'ui-sans-serif, system-ui, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Draw one frame.
 * st: { w, h, dpr, t:{x,y,k}, layout, posOf, theme, levels, selectedId, selKeys, box, now }
 */
export function drawTopology(ctx, st) {
  const { w, h, dpr, t, layout, posOf, theme, levels, selectedId, selKeys, box, now } = st;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Canvas + dot grid
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  const grid = 24 * t.k;
  if (grid > 7) {
    ctx.fillStyle = theme.dot;
    const ox = t.x % grid;
    const oy = t.y % grid;
    for (let gx = ox; gx < w; gx += grid) {
      for (let gy = oy; gy < h; gy += grid) ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
    }
  }

  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);

  const liveAt = (n) => unsLiveMap.get(`${n.brokerId}:${n.path}`) || 0;
  const dashOffset = -((now / 40) % 24);
  // Level of detail: tiny text is noise, so drop caption lines when zoomed far out.
  const showCaption = t.k >= 0.45;
  const showName = t.k >= 0.28;

  // Edges first: animated dashed green while the child branch is publishing.
  for (const e of layout.edges) {
    const live = now - liveAt(e.to.node) < LIVE_WINDOW_MS;
    const a = posOf(e.from);
    const b = posOf(e.to);
    const x1 = a.x + R + 3;
    const x2 = b.x - R - 3;
    const mx = (x1 + x2) / 2;
    ctx.beginPath();
    ctx.moveTo(x1, a.y);
    ctx.bezierCurveTo(mx, a.y, mx, b.y, x2, b.y);
    if (live) {
      ctx.strokeStyle = theme.edgeLive;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = dashOffset;
    } else {
      ctx.strokeStyle = theme.edge;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const [pr, pg, pb] = theme.pulse;
  for (const l of layout.nodes) {
    const n = l.node;
    const P = posOf(l);
    const lvl = nodeLevel(n, levels, theme.mode);
    const color = lvl.color;
    const last = liveAt(n);
    const pulsing = now - last < PULSE_MS;
    const live = now - last < LIVE_WINDOW_MS;

    if (selKeys.has(nodeKey(n))) {
      ctx.beginPath();
      ctx.arc(P.x, P.y, R + 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${theme.multiSel},0.14)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${theme.multiSel},0.95)`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (pulsing) {
      const p = 1 - (now - last) / PULSE_MS;
      ctx.beginPath();
      ctx.arc(P.x, P.y, R + 4 + 8 * (1 - p), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${pr},${pg},${pb},${0.5 * p})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(P.x, P.y, R, 0, Math.PI * 2);
    ctx.fillStyle = theme.badgeFill;
    ctx.shadowColor = theme.badgeShadow;
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = n.id === selectedId ? 3 : 2;
    ctx.strokeStyle = n.id === selectedId ? theme.selected : color;
    ctx.stroke();

    const iconImg = getIconImage(resolveIconName(n), color, 40);
    if (iconImg && iconImg.complete && iconImg.naturalWidth > 0) {
      ctx.drawImage(iconImg, P.x - 11, P.y - 11, 22, 22);
    } else {
      drawGlyph(ctx, P.x, P.y, n.depth, color);
    }

    // Status dot: green = publishing now; amber = overdue; red = dead. Leaves only.
    const stale = n.children.size === 0 ? staleness(n, now) : null;
    const dotColor = live ? theme.statusLive : stale === 'dead' ? theme.statusDead : stale === 'overdue' ? theme.statusOverdue : null;
    if (dotColor) {
      ctx.beginPath();
      ctx.arc(P.x + R * 0.72, P.y - R * 0.72, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.strokeStyle = theme.statusRing;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    if (l.hasKids) {
      ctx.beginPath();
      ctx.arc(P.x, P.y + R + 1, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.toggleFill;
      ctx.fill();
      ctx.strokeStyle = theme.toggleStroke;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.strokeStyle = theme.toggleInk;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(P.x - 3, P.y + R + 1);
      ctx.lineTo(P.x + 3, P.y + R + 1);
      if (!l.open) {
        ctx.moveTo(P.x, P.y + R - 2);
        ctx.lineTo(P.x, P.y + R + 4);
      }
      ctx.stroke();
    }

    if (!showName) continue;
    // Labels get a canvas-coloured halo so crossing edges never block the text.
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.halo;
    ctx.lineWidth = 4;
    ctx.font = `600 13px ${FONT}`;
    ctx.strokeText(truncate(n.name, 22), P.x, P.y + R + 24);
    ctx.fillStyle = theme.name;
    ctx.fillText(truncate(n.name, 22), P.x, P.y + R + 24);
    if (!showCaption) continue;
    ctx.font = `600 11px ${FONT}`;
    const caption = lvl.name.toUpperCase();
    ctx.strokeText(caption, P.x, P.y + R + 38);
    ctx.fillStyle = theme.sub;
    ctx.fillText(caption, P.x, P.y + R + 38);
    if (n.children.size > 0) {
      if (n.topicCount > 0) {
        const rate = unsRateMap.get(`${n.brokerId}:${n.path}`) || 0;
        const line = rate > 0 ? `${n.topicCount.toLocaleString()} topics · ${rate.toLocaleString()}/s` : `${n.topicCount.toLocaleString()} topics`;
        ctx.font = `500 11px ${FONT}`;
        ctx.strokeText(line, P.x, P.y + R + 52);
        ctx.fillStyle = rate > 0 ? theme.rate : theme.count;
        ctx.fillText(line, P.x, P.y + R + 52);
      }
    } else {
      // Leaf: the topic's latest VALUE, so the namespace doubles as a dashboard.
      const v = unsValueMap.get(`${n.brokerId}:${n.path}`);
      if (v && v.value !== '') {
        const text = truncate(v.value, 24);
        ctx.font = `600 11px ${MONO}`;
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
    ctx.fillStyle = `rgba(${theme.multiSel},0.1)`;
    ctx.fillRect(x, y, Math.abs(box.x2 - box.x1), Math.abs(box.y2 - box.y1));
    ctx.strokeStyle = `rgba(${theme.multiSel},0.7)`;
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
