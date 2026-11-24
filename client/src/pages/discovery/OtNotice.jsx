import { ShieldAlert } from 'lucide-react';

/** The plain-language warning shown whenever device protocols are ticked for a scan. */
export default function OtNotice() {
  return (
    <div role="note" className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5 text-xs leading-relaxed">
        <p className="text-sm font-semibold">Scanning an OT network is intrusive</p>
        <p>
          Finding devices opens a TCP connection to every address in the range and sends one identification request per ticked protocol: a Modbus read of a single register (function 3), an S7 connection request
          (no S7 job is sent) or an EtherNet/IP ListIdentity. The probes are read-only, nothing is ever written to a device. Even so, fragile PLCs and gateways can react badly to unexpected connections:
          scan only networks you are allowed to scan, keep the range small, and prefer a maintenance window.
        </p>
        <p>
          The server refuses to scan private (LAN) ranges unless it was started with <span className="mono rounded bg-black/20 px-1">MANIFOLD_ALLOW_PRIVATE_TARGETS=1</span> (only safe on a trusted network).
          Loopback, link-local and cloud-metadata addresses are always refused.
        </p>
      </div>
    </div>
  );
}
