// -----------------------------------------------------------------------------
// The `servers` widget: the overview of every server, one server in detail,
// an unreachable controller, the power buttons (only when allowed, each with
// a confirmation), the budget of the core.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { FakeRedfish, URL_1, URL_2, baseConfig, createWorld, deviceId } from './helpers/world.js';

const get = async (world, settings = {}, language = 'en') => {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings, language });
  assert.equal(ack.success, true, ack.error);
  const content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content), [], 'rendered exactly as sent');
  assert.ok(content.components.length <= 8, 'budget: 8 components');
  assert.ok(content.components.filter((c) => c.type === 'text').length <= 2, 'budget: 2 texts');
  return content;
};

const buttons = (content) =>
  content.components.filter((c) => c.type === 'button').map((c) => c.action.key);

test('the overview: one row per server, the problems in colour', async (t) => {
  const down = new FakeRedfish();
  down.failure = 'down';
  const world = await createWorld({
    controllers: { [URL_1]: new FakeRedfish(), [URL_2]: down },
    config: baseConfig({ bmc_2_url: URL_2, bmc_2_name: 'Backup' }),
  });
  t.after(() => world.app.stop());
  const content = await get(world, {}, 'fr');
  const status = content.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value, item.color]),
    [
      ['web483', 'Allumé · OK · 344 W', 'success'],
      ['Backup', 'ne répond pas', 'danger'],
    ],
  );
  assert.deepEqual(buttons(content), ['refresh']);
});

test('one server: tiles, rows, no power button while control is off', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const content = await get(world, { server: deviceId(world.gladys) });
  assert.deepEqual(
    content.components.filter((c) => c.type === 'value').map((c) => [c.label, c.value, c.unit]),
    [
      ['Power draw', 344, 'W'],
      ['Intake', 25, '°C'],
      ['Processor', 41, '°C'],
    ],
  );
  const rows = content.components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((row) => [row.label, row.value]),
    [
      ['Power', 'On'],
      ['Health', 'OK'],
      ['Fans', '2,075 rpm'],
      ['Power supplies', '1 failing'],
    ],
  );
  assert.deepEqual(buttons(content), ['refresh']);
});

test('power control on: shut down and restart when on, power on when off, confirmed', async (t) => {
  const bmc = new FakeRedfish();
  const world = await createWorld({
    controllers: { [URL_1]: bmc },
    config: baseConfig({ allow_power_control: true }),
  });
  t.after(() => world.app.stop());
  const settings = { server: deviceId(world.gladys) };
  let content = await get(world, settings);
  assert.deepEqual(buttons(content), ['refresh', 'shutdown', 'restart']);
  assert.ok(
    content.components
      .filter((c) => c.type === 'button' && c.action.key !== 'refresh')
      .every((c) => c.action.confirm === true),
  );
  const ack = await world.fake.widgetAction(WIDGET_KEY, 'restart', {}, { settings });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.en, 'Restart requested.');
  assert.deepEqual(bmc.resets, ['GracefulRestart']);

  bmc.setPower('Off');
  await world.fake.widgetAction(WIDGET_KEY, 'refresh', {}, { settings });
  content = await get(world, settings);
  assert.deepEqual(buttons(content), ['refresh', 'power_on']);
  await world.fake.widgetAction(WIDGET_KEY, 'power_on', {}, { settings });
  assert.deepEqual(bmc.resets, ['GracefulRestart', 'On']);
});

test('an unreachable controller, a server gone, no controller at all', async (t) => {
  const bmc = new FakeRedfish();
  const world = await createWorld({ controllers: { [URL_1]: bmc } });
  t.after(() => world.app.stop());
  bmc.failure = 'tls';
  await world.hub.pollAll();
  const content = await get(world, { server: deviceId(world.gladys) });
  assert.equal(
    content.components[1].text,
    'web483: certificate refused: tick "Accept self-signed certificates"',
  );
  const gone = await get(world, { server: deviceId(world.gladys, RACK, 3) });
  assert.match(gone.components[0].text, /no longer in the configuration/);
  await world.fake.configUpdated({ language: 'en' });
  const empty = await get(world);
  assert.match(empty.components[0].text, /Add a management controller/);
});

const RACK = '437XR1138R2';
