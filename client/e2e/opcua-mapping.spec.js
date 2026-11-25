import { test, expect } from './fixtures.js';
import { api, unique, subscribe, cleanup, startOpcua, cleanupOpcua } from './support.js';

/**
 * OPC UA nodes into the UNS, driven as a user against a REAL OPC UA server: browse the server's
 * address space on the Tags page, map two variables with envelope payloads, then watch the broker:
 * values with quality and source time, Bad on a status change, `_status` offline on an outage and
 * Good again after recovery, and the `_meta` document. Then mount the server's address space on
 * the UNS page.
 */

let srv;
test.beforeEach(async () => {
  srv = await startOpcua();
});
test.afterEach(async () => {
  await srv?.close();
});

const latestOf = (mqtt) => (topic) => mqtt.messages.filter((m) => m.topic === topic).at(-1)?.payload;

async function connect(name) {
  const res = await api.post('/api/opcua/connections', { name, endpointUrl: srv.endpointUrl });
  if (!res.ok) throw new Error(`connect failed: ${res.status} ${res.text}`);
  return res.json.connectionId;
}

test('map OPC UA variables from the Tags page; values, quality, _status and _meta arrive at the broker', async ({ page, consoleErrors }) => {
  const name = unique('opc-map-');
  const bindingName = unique('E2E opc map ');
  const asset = `e2e/${unique('opc')}/line1/tank`;
  const mqtt = await subscribe(`${asset}/#`);
  const latest = latestOf(mqtt);
  try {
    const id = await connect(name);
    srv.set('Quality.Value', 42.5);

    await page.goto(`/tags?source=opcua:${id}`);
    await expect(page.getByLabel('Source')).toHaveValue(`opcua:${id}`);
    const tree = page.getByRole('tree', { name: `Tags in ${name}` });
    const row = (n) => tree.getByRole('treeitem').filter({ has: page.getByText(n, { exact: true }) });
    // keyboard: Objects -> Manifold -> Quality / Analog
    await row('Objects').focus();
    await page.keyboard.press('ArrowRight');
    await row('Manifold').focus();
    await page.keyboard.press('ArrowRight');
    await row('Quality').focus();
    await page.keyboard.press('ArrowRight');
    await row('Value').focus();
    await page.keyboard.press('Space');
    await row('Analog').click();
    await row('Temperature').click();
    // the Type and Unit columns show what the server publishes for each variable
    await expect(row('Temperature')).toContainText('°C');
    await expect(row('Temperature')).toContainText('float64');
    await expect(row('Value')).toHaveAttribute('aria-selected', 'true');
    await expect(row('Temperature')).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: /Add to UNS \(2\)/ }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill(bindingName);
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);
    await expect(editor.getByRole('radio', { name: 'Envelope' })).toHaveAttribute('aria-checked', 'true');
    // the published names come from the browse names, not the node ids
    await expect(editor.getByLabel(`Published name for ${srv.nodeId('Quality.Value')}`, { exact: true })).toHaveValue(/^value$/i);
    await expect(editor.getByLabel(`Published name for ${srv.nodeId('Analog.Temperature')}`, { exact: true })).toHaveValue(/^temperature$/i);
    // the editor's Unit field shows the server's unit (what publishes unless the mapping sets one)
    await expect(editor.getByLabel(/^Unit for temperature/i)).toHaveAttribute('placeholder', '°C');
    // the server's check of the final draft (saving before it answers asks to press save again)
    const preview = editor.getByRole('complementary', { name: 'Preview' });
    await expect(preview.getByText('Checked by the server', { exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Temperature', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    const topics = () => [...new Set(mqtt.messages.map((m) => m.topic))];
    await expect.poll(topics, { message: 'value topics', timeout: 30_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/\/value$/i), expect.stringMatching(/\/temperature$/i)]));
    const vt = topics().find((t) => /\/value$/i.test(t));
    const tt = topics().find((t) => /\/temperature$/i.test(t));
    expect(latest(vt)).toMatchObject({ v: 42.5, q: 192, t: expect.any(Number) });
    expect(latest(tt)).toMatchObject({ v: 21.5, q: 192 });
    await expect.poll(() => latest(`${asset}/_status`)?.online, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => latest(`${asset}/_meta`), { timeout: 30_000 }).toBeTruthy();
    const meta = latest(`${asset}/_meta`);
    const metaKeys = Object.keys(meta.properties);
    expect(metaKeys.length).toBe(2);
    expect(JSON.stringify(meta)).toContain(srv.nodeId('Quality.Value'));
    // the server's EngineeringUnits / EURange / DataType reach the mapping (it sets none itself)
    await expect.poll(() => Object.values(latest(`${asset}/_meta`)?.properties || {}).find((p) => p.source?.address === srv.nodeId('Analog.Temperature'))?.unit, { timeout: 30_000 }).toBe('°C');
    const tempMeta = Object.values(latest(`${asset}/_meta`).properties).find((p) => p.source?.address === srv.nodeId('Analog.Temperature'));
    expect(tempMeta).toMatchObject({ range: { min: 0, max: 150 }, type: 'float64' });

    // reopened, the preview says where the unit comes from
    await page.goto('/tags?view=mappings');
    await page.getByRole('button', { name: `Edit mapping ${bindingName}` }).click();
    const again = page.getByRole('dialog', { name: `Edit ${bindingName}` });
    const tName = await again.getByLabel(`Published name for ${srv.nodeId('Analog.Temperature')}`, { exact: true }).inputValue();
    await again.getByRole('button', { name: `Details of ${tName}` }).click();
    const details = again.getByRole('region', { name: `Details of ${tName}` });
    await expect(details).toContainText('from server');
    // ...and shows the server's values, although a stored OPC UA mapping carries no browse metadata
    await expect(details.getByRole('textbox', { name: /^Unit/ })).toHaveAttribute('placeholder', '°C');
    await expect(details.getByLabel('Range minimum')).toHaveAttribute('placeholder', '0');
    await expect(details.getByLabel('Range maximum')).toHaveAttribute('placeholder', '150');
    await again.getByRole('button', { name: 'Cancel' }).first().click();

    // a new value, then Bad with the value unchanged
    srv.set('Quality.Value', 43);
    await expect.poll(() => latest(vt)?.v, { timeout: 30_000 }).toBe(43);
    srv.setStatus('Quality.Value', 'BadSensorFailure');
    await expect.poll(() => latest(vt)?.q, { timeout: 30_000 }).toBe(0);
    expect(latest(vt).v).toBe(43);

    // outage: offline status and Bad; recovery: online and Good again
    await srv.stop();
    await expect.poll(() => latest(`${asset}/_status`)?.online, { timeout: 30_000 }).toBe(false);
    expect(latest(tt).q).toBe(0);
    await srv.start();
    await expect.poll(() => latest(`${asset}/_status`)?.online, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => latest(tt)?.q, { timeout: 30_000 }).toBe(192);
    srv.set('Quality.Value', 44);
    await expect.poll(() => latest(vt), { timeout: 30_000 }).toMatchObject({ v: 44, q: 192 });
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [bindingName] });
    await cleanupOpcua({ connections: [name] });
    await mqtt.close();
  }
});

test('mount an OPC UA server on the UNS page and see its address space in the tree', async ({ page }) => {
  const name = unique('opc-mnt-');
  const label = unique('Line PLC ');
  try {
    await connect(name);
    await page.goto('/uns');
    await page.getByRole('button', { name: 'Sources' }).click();
    const panel = page.getByRole('complementary', { name: 'Namespace sources' }).or(page.getByRole('dialog', { name: 'Namespace sources' })).first();
    await panel.getByLabel('OPC UA connection to mount').selectOption({ label: name });
    await panel.getByLabel('Mount label').fill(label);
    await panel.getByRole('button', { name: 'Mount source' }).click();
    await expect(panel.getByRole('listitem').filter({ hasText: label })).toBeVisible();
    expect((await api.get('/api/uns/mounts')).json.mounts.find((m) => m.label === label)?.type).toBe('opcua');

    await page.getByRole('radio', { name: 'Tree' }).click();
    const mounted = page.getByRole('treeitem').filter({ hasText: label }).first();
    await expect(mounted).toBeVisible({ timeout: 30_000 });
    await mounted.focus();
    await mounted.press('ArrowRight');
    const objects = page.getByRole('treeitem').filter({ hasText: 'Objects' }).first();
    await expect(objects).toBeVisible();
    // the second level came in the same server-side walk (one batched browse per level)
    await objects.focus();
    await objects.press('ArrowRight');
    await expect(page.getByRole('treeitem').filter({ hasText: 'Manifold' }).first()).toBeVisible();
    await shot(page, 'opcua-uns-mount');
  } finally {
    await cleanupOpcua({ connections: [name], mounts: [label] });
  }
});

async function shot(page, name) {
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/${name}.png` });
}
