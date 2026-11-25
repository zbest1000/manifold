import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { resolveIconName, getIconImage } from '@/graph/unsIcons';
import { lastActive, nodeValue, nodeRate, staleness, expectedInterval } from '@/graph/unsLive';
import { nodeLevel } from '@/graph/unsLevels';
import { useCanvasTokens } from '@/graph/canvasTokens';
import { isMountNode } from '@/graph/unsTree';
import { rateLabel } from '@/graph/unsDraw';
import { Button, ButtonLink, KeyValue, Path, StatusText, Timestamp } from '@/components/ui';
import { PanelSection, SidePanel } from '@/components/CanvasChrome';

const STALE = {
  fresh: { tone: 'good', word: 'Publishing' },
  overdue: { tone: 'warn', word: 'Overdue' },
  dead: { tone: 'bad', word: 'Silent' }
};

/** Detail panel for the selected namespace node (docked beside the map). */
export default function NodeDetails({ node, levels, iconTick, onChangeIcon, onClose }) {
  const tokens = useCanvasTokens();
  // Re-read liveness once a second while the panel is open.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const lvl = nodeLevel(node, levels, tokens);
  const ts = lastActive(node);
  const val = nodeValue(node);
  const rate = nodeRate(node);
  const leaf = node.children.size === 0;
  const stale = leaf ? staleness(node) : null;
  const interval = expectedInterval(node);
  const iconName = resolveIconName(node);
  const img = getIconImage(iconName, tokens.textMuted, 40);
  const mqtt = !isMountNode(node);

  return (
    <SidePanel
      label="Node details"
      title={node.name}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="3.75" fill="none" stroke={lvl.color} strokeWidth="1.75" />
          </svg>
          {lvl.name}
        </span>
      }
      onClose={onClose}
      closeLabel="Close details"
    >
      <PanelSection>
        {node.path && <Path value={node.path} className="mb-3 text-fg" />}
        <KeyValue
          items={[
            ['Topics in branch', <span key="t" className="tabular-nums">{node.topicCount.toLocaleString()}</span>],
            ['Direct children', <span key="c" className="tabular-nums">{node.children.size.toLocaleString()}</span>],
            ['Last activity', ts ? <Timestamp key="a" value={ts} /> : '—'],
            rate > 0 && ['Rate', <span key="r" className="tabular-nums">{rateLabel(rate)}</span>],
            stale && [
              'State',
              <StatusText key="s" tone={STALE[stale].tone}>
                {STALE[stale].word}
                {interval > 0 && <span className="text-subtle">{` · every ~${Math.round(interval / 1000) || 1} s`}</span>}
              </StatusText>
            ]
          ]}
        />
      </PanelSection>
      {val && (
        <PanelSection title="Latest value">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-app px-2 py-1.5 font-mono text-xs text-fg">{val.value.slice(0, 600)}</pre>
        </PanelSection>
      )}
      <PanelSection title="Icon">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-muted">
            {img && <img key={iconTick} src={img.src} alt="" className="h-4 w-4" />}
            <span className="truncate font-mono text-xs">{iconName}</span>
          </span>
          <Button size="sm" variant="secondary" onClick={onChangeIcon}>
            <Pencil size={12} aria-hidden="true" /> Change
          </Button>
        </div>
      </PanelSection>
      {mqtt && node.path && (
        <PanelSection>
          <ButtonLink size="sm" to={`/topics?broker=${encodeURIComponent(node.brokerId)}&topic=${encodeURIComponent(node.path)}`}>
            Open in Topics
          </ButtonLink>
        </PanelSection>
      )}
    </SidePanel>
  );
}
