/**
 * One definition of "how many topics" for every page (Overview, Topics, UNS).
 *
 * The client's topic index only holds what it has been seeded with (a capped
 * REST list) plus what it has seen live, so it can lag the server; the server's
 * `metrics.topicCount` is exact. The truth is whichever is larger, never the
 * smaller subset.
 */
export function deriveTopicCount(localCount, serverCount) {
  const l = Number.isFinite(localCount) ? localCount : 0;
  const s = Number.isFinite(serverCount) ? serverCount : 0;
  return Math.max(l, s);
}

/** Total across brokers. `localCountOf(id)` reads the client index size. */
export function totalTopicCount(brokers, localCountOf) {
  let total = 0;
  for (const b of brokers) total += deriveTopicCount(localCountOf(b.id), b.metrics?.topicCount);
  return total;
}
