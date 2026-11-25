import { Banner, Checkbox } from '@/components/ui';

/**
 * Shown whenever a PLC protocol is ticked. The first time, scanning stays disabled until the user
 * confirms (the choice is remembered in this browser); afterwards it is a reminder.
 */
export default function OtNotice({ acknowledged, onAcknowledge, disabled }) {
  return (
    <Banner variant="warn" title="Looking for PLCs and meters touches an OT network">
      <div role="note" className="space-y-2">
        <p>
          Device probing opens a TCP connection to every address in the range and, where a port is open, sends one identification request per ticked protocol: a Modbus device-identification or single-register
          read, an S7 connection request (and, if the controller accepts it, a read of its identity records), or an EtherNet/IP ListIdentity. The probes only read; nothing is ever written to a device.
        </p>
        <p>
          Even so, fragile PLCs and gateways can react badly to unexpected connections, and intrusion-detection systems may raise an alert. Scan only networks you are allowed to scan, keep the range small,
          and prefer a maintenance window. Each device receives at most a couple of connections at a time (see Advanced options).
        </p>
        {!acknowledged && (
          <Checkbox
            className="pt-1"
            checked={false}
            disabled={disabled}
            onChange={(on) => on && onAcknowledge()}
            label={<span className="font-medium text-fg">I understand, and I am allowed to probe this network</span>}
            description="Required once. This browser remembers it."
          />
        )}
      </div>
    </Banner>
  );
}
