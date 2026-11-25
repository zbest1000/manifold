/** Help dialog body for the Pipelines page (rendered inside <HelpButton>). */
export default function PipelinesHelp() {
  return (
    <>
    <p>
      A <b>pipeline</b> reshapes your live message stream and sends the result somewhere else. It runs on the
      server as messages arrive. Nothing is stored unless you route it to a historian or the recorder.
    </p>
    <p>The five tabs each do one job. Alert rules live in Settings.</p>

    <div className="space-y-2.5">
      <div>
        <p className="font-medium text-fg">Routes</p>
        <p>The core building block. A route is <code>source → transforms → target</code>:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li><b>Source</b>: a broker and a topic filter, for example <code>factory/+/temperature</code>.</li>
          <li><b>Transforms</b>: an ordered chain. Re-path the topic, pick or rename fields, scale a number, flatten Sparkplug metrics, or wrap a value in a TVQ envelope.</li>
          <li><b>Target</b>: publish to another broker topic, or write to a historian.</li>
        </ul>
        <p className="mt-1">
          Example: read <code>plc/+/tempF</code>, scale it (multiply by <code>0.5556</code>, add <code>-17.78</code>) to
          convert Fahrenheit to Celsius, then publish to <code>{'uns/{1}/tempC'}</code>. Use <b>Dry run</b> in the route editor to preview
          the in and out mapping against live topics before you save.
        </p>
      </div>
      <div>
        <p className="font-medium text-fg">Models</p>
        <p>
          Merge fields from several topics into one object at a clean UNS path. Example: combine
          <code>line1/motor1/temp</code>, <code>line1/motor1/rpm</code>, and <code>line1/motor1/state</code> into a
          single <code>line1/motor1</code> object shaped like <code>{'{ temp, rpm, state }'}</code>.
        </p>
      </div>
      <div>
        <p className="font-medium text-fg">Historians</p>
        <p>
          Connections to a time-series database: InfluxDB, TimescaleDB, or Timebase. Routes and the recorder write
          into them, and the <b>Trends</b> page reads them back. An on-prem historian that uses a self-signed
          certificate needs "Allow self-signed TLS" turned on.
        </p>
      </div>
      <div>
        <p className="font-medium text-fg">Recorder</p>
        <p>
          Capture a topic filter to a local file for later replay or charting. It works like a lightweight historian
          with no database. Example: record <code>energy/#</code> for an hour, then scrub through it on Trends.
        </p>
      </div>
      <div>
        <p className="font-medium text-fg">Contracts</p>
        <p>
          Declare the shape a topic&apos;s payload should have, for example <code>{'{ value: number, unit: string }'}</code>.
          Manifold flags drift when a message stops matching, so you catch a firmware change that renamed a field.
        </p>
      </div>
    </div>

    <p className="text-subtle">
      A good first pipeline: a Route from <code>sensors/#</code>, one repath transform, into a TimescaleDB historian,
      then chart it on Trends.
    </p>
    </>
  );
}
