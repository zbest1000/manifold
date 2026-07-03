import { useEffect, useMemo, useRef, useState } from 'react';
import WebGLGraph from '@/graph/WebGLGraph';
import SigmaGraph from '@/graph/SigmaGraph';
import { buildMqttGraph } from '@/graph/buildGraph';

/**
 * Internal benchmark / verification page (not linked in the nav). Renders a
 * synthetic MQTT topic graph of a requested size with a chosen big-graph renderer
 * so the show-all renderers can be exercised deterministically — no broker or live
 * data needed. Drives automated Playwright verification at 50k+ nodes.
 *
 *   /bench?n=50000&r=webgl      built-in WebGL renderer
 *   /bench?n=50000&r=sigma      Sigma.js renderer
 *
 * Exposes window.__bench = { ready, renderer, requested, nodes, links, buildMs, renderMs }.
 */
export default function Bench() {
  const params = new URLSearchParams(window.location.search);
  const n = Math.max(1, Math.min(1_000_000, Number(params.get('n')) || 50_000));
  const renderer = params.get('r') === 'sigma' ? 'sigma' : 'webgl';
  const [phase, setPhase] = useState('building');
  const t0Ref = useRef(0);

  // Build a synthetic topic hierarchy with ~n leaf topics.
  const { graph, buildMs } = useMemo(() => {
    const t = performance.now();
    const topics = [];
    // factory/area{a}/line{l}/dev{d}/{metric} — shared prefixes keep it realistic.
    const perDev = 4;
    const devs = Math.ceil(n / perDev);
    const metrics = ['temp', 'pressure', 'flow', 'state'];
    for (let i = 0; i < devs; i++) {
      const a = i % 50;
      const l = i % 500;
      for (let m = 0; m < perDev && topics.length < n; m++) {
        topics.push({ topic: `factory/area${a}/line${l}/dev${i}/${metrics[m]}`, messageCount: 1, type: 'telemetry' });
      }
    }
    const broker = { id: 'bench', name: 'Bench Broker', host: 'localhost', port: 1883, status: 'connected' };
    const g = buildMqttGraph(broker, topics, { maxNodes: Infinity });
    return { graph: g, buildMs: Math.round(performance.now() - t) };
  }, [n]);

  useEffect(() => {
    t0Ref.current = performance.now();
    setPhase('rendering');
    // Two rAFs after mount ≈ the renderer has drawn at least one frame.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const renderMs = Math.round(performance.now() - t0Ref.current);
        window.__bench = {
          ready: true,
          renderer,
          requested: n,
          nodes: graph.nodes.length,
          links: graph.links.length,
          buildMs,
          renderMs
        };
        setPhase('ready');
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      delete window.__bench;
    };
  }, [graph, renderer, n, buildMs]);

  return (
    <div className="relative h-screen w-screen bg-black">
      {renderer === 'sigma' ? (
        <SigmaGraph data={graph} styleId="constellation" />
      ) : (
        <WebGLGraph data={graph} styleId="constellation" />
      )}
      <div
        data-testid="bench-status"
        className="pointer-events-none absolute left-2 top-2 rounded bg-white/10 px-2 py-1 font-mono text-[11px] text-white"
      >
        {renderer} · req {n.toLocaleString()} · nodes {graph.nodes.length.toLocaleString()} · links{' '}
        {graph.links.length.toLocaleString()} · build {buildMs}ms · {phase}
      </div>
    </div>
  );
}
