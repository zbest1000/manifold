import { describe, it, expect } from 'vitest';
import { forceSimulation, forceManyBody } from 'd3-force';
import { simShouldRun } from '@/graph/simState';

describe('force simulation resume after a refresh (Topics graph drag)', () => {
  it('a drag that has just re-heated a settled layout keeps the simulation running across a stop()', () => {
    const sim = forceSimulation([{ x: 0, y: 0 }, { x: 10, y: 0 }]).force('charge', forceManyBody()).stop();
    while (sim.alpha() > sim.alphaMin()) sim.tick(); // settled
    // the first drag move: alphaTarget(0.25).restart() — alpha only rises on the next tick
    sim.alphaTarget(0.25).restart();
    sim.stop(); // a data refresh landed before that tick: React's cleanup stopped the timer
    expect(sim.alpha() > sim.alphaMin(), 'the old check (alpha only) would leave it stopped').toBe(false);
    expect(simShouldRun(sim)).toBe(true);
    // after the drag ends and the layout cools down, nothing restarts it
    sim.alphaTarget(0);
    while (sim.alpha() > sim.alphaMin()) sim.tick();
    expect(simShouldRun(sim)).toBe(false);
    expect(simShouldRun(null)).toBe(false);
  });
});
