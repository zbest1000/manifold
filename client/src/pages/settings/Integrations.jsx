import { KeyValue, StatusText } from '@/components/ui';
import { useStore } from '@/store/store';
import Section from './Section';

const MCP_SNIPPET = `{
  "mcpServers": {
    "manifold": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "MANIFOLD_API_URL": "http://localhost:5000" }
    }
  }
}`;

/** The MCP server that lets AI assistants use this instance. */
export function McpSection() {
  return (
    <Section title="MCP server" description="Lets an AI assistant or agent use this instance through the same backend.">
      <p className="text-sm text-muted">
        Manifold ships an MCP server so assistants can discover brokers, browse topics, read payloads and walk OPC UA address spaces. Add this to your MCP client configuration:
      </p>
      <pre tabIndex={0} role="region" aria-label="MCP client configuration" className="mono overflow-x-auto rounded-md border border-line bg-app p-3 text-xs leading-relaxed text-muted">
        {MCP_SNIPPET}
      </pre>
    </Section>
  );
}

/** Connection state of the realtime link and the client version. */
export function AboutSection() {
  const connected = useStore((s) => s.connected);
  return (
    <Section title="About" description="State of this browser's link to the server.">
      <KeyValue
        items={[
          ['Realtime link', <StatusText key="link" tone={connected ? 'good' : 'bad'}>{connected ? 'Connected' : 'Offline'}</StatusText>],
          ['Client', <span key="v" className="mono text-xs">Manifold 2.0</span>]
        ]}
      />
    </Section>
  );
}
