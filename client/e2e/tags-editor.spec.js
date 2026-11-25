import { test, expect } from './fixtures.js';
import { api, unique, startModbus, createModbusDevice, deviceByName, subscribe, subscribeRaw, sparkplugDecoder, startHistorianStub, cleanup } from './support.js';

const shots = process.env.E2E_SHOTS_DIR;
const latestOf = (mqtt) => (topic) => mqtt.messages.filter((m) => m.topic === topic).at(-1)?.payload;

async function deviceWithTemp(sim, name) {
  const device = await createModbusDevice({ name, port: sim.port, tags: [{ key: 'temp', address: '40101', property: 'temperature', unit: 'degC', description: 'Water temperature', range: { min: 0, max: 200 } }] });
  await expect.poll(async () => (await deviceByName(name))?.status?.state, { timeout: 30_000 }).toBe('online');
  return device;
}

async function mapping(name, device, target) {
  const res = await api.post('/api/tags/bindings', { name, source: { type: 'device', deviceId: device.id, tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'e2e-broker', format: 'envelope', ...target } });
  expect(res.status, res.text).toBe(201);
  return res.json;
}

async function openEdit(page, name) {
  await page.goto('/tags?view=mappings');
  await page.getByRole('button', { name: `Edit mapping ${name}` }).click();
  // by name: a conflict dialog can sit on top of the editor, and an unnamed locator would match both
  const editor = page.getByRole('dialog', { name: `Edit ${name}`, exact: true });
  await expect(editor.getByRole('heading', { name: `Edit ${name}` })).toBeVisible();
  return editor;
}

/**
 * Payload fields in the order the user wants: move with the arrow buttons and with the keyboard on
 * a row's handle; the live preview and the broker follow that order, and it survives a reopen.
 */
test('payload field order: buttons and keyboard, preview and broker follow it, the order round-trips', async ({ page, consoleErrors }) => {
  const deviceName = unique('E2E order ');
  const name = unique('E2E order map ');
  const asset = `e2e/${unique('ord')}/pump`;
  const sim = await startModbus({ value: 30 });
  const mqtt = await subscribe(`${asset}/#`);
  try {
    const device = await deviceWithTemp(sim, deviceName);
    await mapping(name, device, { assetPath: asset });
    const editor = await openEdit(page, name);
    const list = editor.getByRole('list', { name: 'Payload fields in publish order' });
    await list.scrollIntoViewIfNeeded();
    await expect(list.getByRole('listitem')).toHaveText([/^1v/, /^2t/, /^3q/, /^4u/, /name/, /src/, /ctx/]);
    await list.getByRole('button', { name: 'Move q up' }).click();
    await list.getByRole('button', { name: 'Move q up' }).click();
    // keyboard: the handle moves its row
    await list.getByRole('button', { name: /Reorder t/ }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('button', { name: /Reorder t/ })).toBeFocused();
    await expect(list.getByRole('listitem')).toHaveText([/^1q/, /^2v/, /^3u/, /^4t/, /name/, /src/, /ctx/]);
    if (shots) await list.screenshot({ path: `${shots}/field-reorder.png` });

    const preview = editor.getByRole('complementary', { name: 'Preview' });
    await preview.getByRole('button', { name: 'temperature', exact: true }).click();
    await preview.getByRole('radio', { name: 'Payload' }).click();
    const example = preview.getByRole('region', { name: 'Example payload for temperature' });
    await expect.poll(async () => Object.keys(JSON.parse(await example.textContent())).join(',')).toBe('q,v,u,t');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor).toBeHidden();
    sim.set(31);
    await expect.poll(() => latestOf(mqtt)(`${asset}/temperature`)?.v, { timeout: 20_000 }).toBe(31);
    expect(Object.keys(latestOf(mqtt)(`${asset}/temperature`))).toEqual(['q', 'v', 'u', 't']);

    const again = await openEdit(page, name);
    await expect(again.getByRole('list', { name: 'Payload fields in publish order' }).getByRole('listitem')).toHaveText([/^1q/, /^2v/, /^3u/, /^4t/, /name/, /src/, /ctx/]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await cleanup({ bindings: [name], devices: [deviceName] });
    await mqtt.close();
    await sim.close();
  }
});

/**
 * Two people edit one mapping, for real: two browser contexts open the same mapping, B saves first,
 * A's save (based on the revision A loaded) is refused by the server with 409 stale. The dialog
 * shows what changed there and here; Cancel keeps editing, "Take theirs" reloads their version and a
 * save on top of it is clean; "Keep mine" overwrites on purpose. Nothing is mocked.
 */
test('stale edit (two contexts): the conflict dialog shows both sides; cancel keeps edits, take theirs reloads, keep mine overwrites', async ({ browser }) => {
  const deviceName = unique('E2E stale ');
  const name = unique('E2E stale map ');
  const asset = `e2e/${unique('stale')}/pump`;
  const sim = await startModbus({ value: 3 });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const stored = async () => (await api.get('/api/tags/bindings')).json.bindings.find((x) => x.id === created.id);
  let created;
  try {
    const device = await deviceWithTemp(sim, deviceName);
    created = await mapping(name, device, { assetPath: asset });
    expect(Number.isInteger(created.rev)).toBe(true);

    let editorA = await openEdit(pageA, name);
    const editorB = await openEdit(pageB, name);

    // B moves the asset first
    await editorB.getByLabel('Asset path', { exact: true }).fill(`${asset}-theirs`);
    await editorB.getByRole('button', { name: 'Save changes' }).click();
    await expect(editorB).toBeHidden();
    await expect.poll(async () => (await stored()).target.assetPath).toBe(`${asset}-theirs`);
    const theirRev = (await stored()).rev;
    expect(theirRev).toBeGreaterThan(created.rev);

    // A, still on the old revision, renames and saves: the real server refuses it
    await editorA.getByLabel('Name', { exact: true }).fill(`${name} mine`);
    await editorA.getByRole('button', { name: 'Save changes' }).click();
    let dialog = pageA.getByRole('dialog', { name: 'This mapping was changed elsewhere' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Changed elsewhere' })).toContainText('target.assetPath');
    await expect(dialog.getByRole('region', { name: 'Changed elsewhere' })).toContainText(`${asset}-theirs`);
    await expect(dialog.getByRole('region', { name: 'Your changes' })).toContainText(`${name} mine`);
    if (shots) await pageA.screenshot({ path: `${shots}/stale-edit-dialog.png` });
    expect((await stored()).name).toBe(name); // nothing was overwritten

    // Cancel: back to editing, edits untouched
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(editorA.getByLabel('Name', { exact: true })).toHaveValue(`${name} mine`);

    // Take theirs: the editor reloads their version (the user chose to drop the edits)
    await editorA.getByRole('button', { name: 'Save changes' }).click();
    dialog = pageA.getByRole('dialog', { name: 'This mapping was changed elsewhere' });
    await dialog.getByRole('button', { name: 'Take theirs' }).click();
    editorA = pageA.getByRole('dialog', { name: `Edit ${name}` });
    await expect(editorA.getByLabel('Asset path', { exact: true })).toHaveValue(`${asset}-theirs`);
    await expect(editorA.getByLabel('Name', { exact: true })).toHaveValue(name);

    // A edits on top of their version: a clean save (A now holds the current revision)
    await editorA.getByLabel('Name', { exact: true }).fill(`${name} A`);
    await editorA.getByRole('button', { name: 'Save changes' }).click();
    await expect(editorA).toBeHidden();
    await expect.poll(async () => (await stored()).name).toBe(`${name} A`);
    expect((await stored()).target.assetPath).toBe(`${asset}-theirs`);

    // Keep mine: both open the current version, A saves, then B (now stale) overwrites on purpose
    editorA = await openEdit(pageA, `${name} A`);
    const editorB2 = await openEdit(pageB, `${name} A`);
    await editorA.getByLabel('Name', { exact: true }).fill(`${name} A2`);
    await editorA.getByRole('button', { name: 'Save changes' }).click();
    await expect(editorA).toBeHidden();
    await expect.poll(async () => (await stored()).name).toBe(`${name} A2`);
    await editorB2.getByLabel('Name', { exact: true }).fill(`${name} mine`);
    await editorB2.getByRole('button', { name: 'Save changes' }).click();
    await pageB.getByRole('dialog', { name: 'This mapping was changed elsewhere' }).getByRole('button', { name: 'Keep mine (overwrite)' }).click();
    await expect(editorB2).toBeHidden();
    await expect.poll(async () => (await stored()).name).toBe(`${name} mine`);
  } finally {
    await ctxA.close();
    await ctxB.close();
    await cleanup({ bindings: [name, `${name} A`, `${name} A2`, `${name} mine`], devices: [deviceName] });
    await sim.close();
  }
});

/**
 * Sparkplug B as the target, decoded at the broker with the repo's decoder: typed metrics and BIRTH
 * properties from unit / description / range, a new DBIRTH when the metadata changes, DDEATH when
 * the device is lost.
 */
test('Sparkplug target: typed DBIRTH with properties, re-BIRTH on a unit change, DDEATH on source loss', async ({ page }) => {
  const deviceName = unique('E2E spb ');
  const name = unique('E2E spb map ');
  const group = unique('G');
  const sim = await startModbus({ value: 42 });
  const sp = await subscribeRaw(`spBv1.0/${group}/#`);
  const dec = sparkplugDecoder();
  const of = (kind) => sp.messages.filter((m) => m.topic === `spBv1.0/${group}/${kind}/E1/Pump1`);
  try {
    const device = await deviceWithTemp(sim, deviceName);
    await page.goto(`/tags?source=device:${device.id}`);
    await page.getByRole('treeitem', { name: /temperature/ }).click();
    await page.getByRole('button', { name: /Add to UNS \(1\)/ }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill(name);
    await editor.getByRole('radio', { name: 'Sparkplug B device' }).click();
    await editor.getByLabel('Group').fill(group);
    await editor.getByLabel('Edge node').fill('E1');
    await editor.getByLabel('Device', { exact: true }).fill('Pump1');
    await expect(editor.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    await expect.poll(() => of('DBIRTH').length, { timeout: 20_000 }).toBeGreaterThan(0);
    const metric = (m) => dec.decode(m.payload).metrics.find((x) => x.name === 'temperature');
    const t = metric(of('DBIRTH').at(-1));
    expect(t.datatypeName || dec.getDataTypeName?.(t.datatype)).toBe('UInt16');
    expect(t.properties).toMatchObject({ engUnit: 'degC', description: 'Water temperature' });
    expect(Number(t.properties.engLow)).toBe(0);
    expect(Number(t.properties.engHigh)).toBe(200);
    await expect.poll(() => of('DDATA').concat(of('DBIRTH')).some((m) => Number(metric(m)?.value) === 42), { timeout: 20_000 }).toBe(true);

    // a unit change re-births the device with the new property
    const births = of('DBIRTH').length;
    const again = await openEdit(page, name);
    await again.getByLabel(/^Unit for temperature/).fill('K');
    await again.getByRole('button', { name: 'Save changes' }).click();
    await expect(again).toBeHidden();
    await expect.poll(() => of('DBIRTH').length, { timeout: 20_000 }).toBeGreaterThan(births);
    expect(metric(of('DBIRTH').at(-1)).properties.engUnit).toBe('K');

    // source loss: DDEATH
    await sim.close();
    await expect.poll(() => of('DDEATH').length, { timeout: 30_000 }).toBeGreaterThan(0);
  } finally {
    await cleanup({ bindings: [name], devices: [deviceName] });
    await sp.close();
    await sim.close().catch(() => {});
  }
});

/**
 * Direct historian target against the historian stub: points carry the resolved topic as tag and
 * the quality, the source loss writes a Bad sample, and InfluxDB is refused with the explanation.
 */
test('historian target: points with topic and quality reach the stub, Bad on source loss; InfluxDB refused with the reason', async ({ page }) => {
  const deviceName = unique('E2E hist ');
  const name = unique('E2E hist map ');
  const asset = `e2e/${unique('hist')}/pump`;
  const stub = await startHistorianStub();
  const sim = await startModbus({ value: 55 });
  const made = [];
  try {
    const h = await api.post('/api/historians', { type: 'timebase', name: unique('Stub '), url: stub.url, dataset: 'e2e' });
    expect(h.ok, h.text).toBe(true);
    made.push(h.json.id);
    const influx = await api.post('/api/historians', { type: 'influxdb', name: unique('Influx '), url: 'http://127.0.0.1:9', org: 'o', bucket: 'b', token: 't' });
    expect(influx.ok, influx.text).toBe(true);
    made.push(influx.json.id);
    const device = await deviceWithTemp(sim, deviceName);

    await page.goto(`/tags?source=device:${device.id}`);
    await page.getByRole('treeitem', { name: /temperature/ }).click();
    await page.getByRole('button', { name: /Add to UNS \(1\)/ }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill(name);
    await editor.getByLabel('Asset path', { exact: true }).fill(asset);
    const delivery = editor.locator('#map-delivery');
    await delivery.getByText('Also write every published sample to a historian').click();
    const influxRadio = delivery.getByRole('radio', { name: new RegExp(influx.json.name) });
    await expect(influxRadio).toBeDisabled();
    await expect(delivery).toContainText('its writer does not store quality');
    await expect(delivery.getByRole('radio', { name: new RegExp(h.json.name) })).toBeChecked();
    await expect(editor.getByRole('complementary', { name: 'Preview' }).getByText('Checked by the server', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Create mapping' }).click();
    await expect(editor).toBeHidden();

    const points = () => stub.received.flatMap((r) => Object.entries(r.body || {}).flatMap(([tag, arr]) => (Array.isArray(arr) ? arr.map((p) => ({ tag, ...p })) : [])));
    await expect.poll(() => points().some((p) => p.tag === `${asset}/temperature` && p.q === 192 && p.v === 55), { timeout: 30_000 }).toBe(true);
    await sim.close();
    await expect.poll(() => points().some((p) => p.tag === `${asset}/temperature` && p.q === 0), { message: 'Bad sample on source loss', timeout: 30_000 }).toBe(true);

    const refused = await api.post('/api/tags/bindings', { name: unique('E2E influx '), source: { type: 'device', deviceId: device.id, tags: ['temp'] }, target: { mode: 'mqtt', brokerId: 'e2e-broker', assetPath: `${asset}2`, historian: { historianId: influx.json.id } } });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/InfluxDB/);
  } finally {
    await cleanup({ bindings: [name], devices: [deviceName] });
    for (const id of made) await api.del(`/api/historians/${id}`).catch(() => {});
    await stub.close();
    await sim.close().catch(() => {});
  }
});

/**
 * CSV for any source: import rows into the per-tag table (per-line errors for what cannot apply),
 * a downloadable template, and export of the table.
 */
test('CSV: import rows with per-line errors, download the template, export the table', async ({ page }) => {
  const deviceName = unique('E2E csv ');
  const name = unique('E2E csv map ');
  const sim = await startModbus({ value: 1 });
  try {
    const device = await createModbusDevice({ name: deviceName, port: sim.port, tags: [{ key: 'temp', address: '40101', property: 'temperature' }, { key: 'rpm', address: '40101' }] });
    await mapping(name, device, { assetPath: `e2e/${unique('csv')}` });
    const editor = await openEdit(page, name);
    await editor.getByRole('button', { name: 'Import CSV' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import mapping rows from CSV' });
    const [template] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download template' }).click()]);
    expect(template.suggestedFilename()).toBe('mapping-device-template.csv');
    await dialog.getByRole('textbox', { name: /^CSV/ }).fill('address,name,unit,scale\ntemp,waterTemp,degC,\nrpm,speed,rpm,0\nnope,x,,\n');
    await expect(dialog).toContainText('0 to add, 1 to update, 2 with problems');
    await expect(dialog).toContainText('line 3: rpm: scale cannot be 0');
    await expect(dialog).toContainText('line 4: "nope" is not a tag of the device');
    await dialog.getByRole('button', { name: 'Apply 1 line' }).click();
    await expect(editor.getByLabel('Published name for temp', { exact: true })).toHaveValue('waterTemp');
    await expect(editor).toContainText('Imported 0 new and updated 1 tag from CSV; 2 lines skipped.');
    const [download] = await Promise.all([page.waitForEvent('download'), editor.getByRole('button', { name: 'Export CSV' }).click()]);
    const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
    expect(text.split('\n')[1]).toBe('temp,waterTemp,true,degC,,,,,,,');
  } finally {
    await cleanup({ bindings: [name], devices: [deviceName] });
    await sim.close();
  }
});
