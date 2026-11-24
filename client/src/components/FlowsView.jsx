import { Radio, Users } from 'lucide-react';
import ProducerFlows from '@/components/ProducerFlows';
import ConsumerFlows from '@/components/ConsumerFlows';
import { PressedGroup } from '@/components/CanvasChrome';

/**
 * Flows workspace: live visibility into the producer → topic → consumer fabric.
 *  - Producers: who publishes what — Sparkplug B device topology + $SYS health
 *    (from observed traffic; needs no broker cooperation).
 *  - Consumers: who receives what — per-client subscriptions from a broker admin
 *    API, with every wildcard filter RESOLVED against the observed topic set so
 *    a broad filter like `spBv1.0/#` shows the concrete topics it covers.
 *
 * The perspective (`tab`) is owned by the page so it sits in the page's toolbar row.
 */
export const FLOW_TABS = [
  { value: 'producers', label: 'Producers', icon: Radio, hint: 'Who publishes what (Sparkplug and $SYS)' },
  { value: 'consumers', label: 'Consumers', icon: Users, hint: 'Who receives what (broker admin API, wildcards resolved)' }
];

export function FlowsPerspective({ value, onChange }) {
  return <PressedGroup label="Flows perspective" options={FLOW_TABS} value={value} onChange={onChange} />;
}

export default function FlowsView({ broker, tab = 'producers' }) {
  return <div className="h-full w-full">{tab === 'producers' ? <ProducerFlows broker={broker} /> : <ConsumerFlows key={broker.id} broker={broker} />}</div>;
}
