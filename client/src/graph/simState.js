/**
 * Should a d3-force simulation that was stopped (React effect cleanup on a data refresh) be restarted?
 * Yes while it is still annealing, and also while a drag holds it warm: right after a drag's
 * `alphaTarget(0.25).restart()` the alpha is still at its settled value until the first tick, so
 * checking alpha alone stopped the simulation for the rest of the drag when a refresh landed in that
 * window (the node no longer followed the pointer).
 */
export function simShouldRun(sim) {
  if (!sim) return false;
  return sim.alpha() > sim.alphaMin() || sim.alphaTarget() > sim.alphaMin();
}
