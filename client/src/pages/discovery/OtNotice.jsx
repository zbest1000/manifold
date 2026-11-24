import { Banner, Code } from '@/components/ui';

/** The plain-language warning shown whenever device protocols are ticked for a scan. */
export default function OtNotice() {
  return (
    <Banner variant="warn" title="Scanning an OT network is intrusive">
      <div role="note" className="space-y-2">
        <p>
          Finding devices opens a TCP connection to every address in the range and sends one identification request per ticked protocol: a Modbus read of a single register (function 3), an S7 connection
          request (no S7 job is sent) or an EtherNet/IP ListIdentity. The probes are read-only, nothing is ever written to a device. Even so, fragile PLCs and gateways can react badly to unexpected
          connections: scan only networks you are allowed to scan, keep the range small, and prefer a maintenance window.
        </p>
        <p>
          The server refuses to scan private (LAN) ranges unless it was started with <Code>MANIFOLD_ALLOW_PRIVATE_TARGETS=1</Code> (only safe on a trusted network). Loopback, link-local and cloud-metadata
          addresses are always refused.
        </p>
      </div>
    </Banner>
  );
}
