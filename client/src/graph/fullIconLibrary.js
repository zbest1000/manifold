/**
 * The full Lucide icon set as raw IconNodes, keyed by kebab-case name. Loaded
 * lazily (dynamic import from unsIcons.loadFullLibrary) so it lives in its own
 * chunk and never weighs on first paint. The data comes from lucide-react's own
 * icon modules via the `virtual:lucide-icon-nodes` module (see vite.config.js).
 */
import FULL_ICONS from 'virtual:lucide-icon-nodes';

export { FULL_ICONS };
