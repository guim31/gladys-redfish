// -----------------------------------------------------------------------------
// The hub, end to end against the SDK's fake Gladys and fake controllers:
// discovery, states of the servers added (only the changes, the noisy values
// once a minute), scene events on transitions (health, power, critical log
// entries), what survives a restart, the power commands and their safety,
// the connection status and the transport badges, the polling timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import {
  FakeRedfish,
  RACK_ID,
  URL_1,
  URL_2,
  baseConfig,
  createClock,
  createDevices,
  createWorld,
  deviceId,
  featureId,
} from './helpers/world.js';

const K = FEATURE_KEYS;
const LOG = '/redfish/v1/Managers/BMC/LogServices/Log/Entries';

const eventsOf = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);

async function rackWorld(options = {}) {
  const bmc = options.bmc ?? new FakeRedfish();
  const world = await createWorld({ controllers: { [URL_1]: bmc }, ...options });
  return { ...world, bmc };
}

test('discovers the server, read-only, nothing published before it is added', async (t) => {
  const world = await rackWorld();
  t.after(() => world.app.stop());
  const [device] = world.fake.discoveredDevices;
  assert.equal(device.name, 'web483');
  assert.equal(device.external_id, deviceId(world.gladys));
  assert.equal(device.should_poll, false);
  assert.equal(device.model, 'Contoso 3500');
  assert.ok(device.features.every((feature) => feature.read_only));
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.states.length, 0);
  assert.equal(world.fake.sceneEvents.length, 0, 'the first read records, announces nothing');
});

test('the configured name wins; two systems on one controller get their id', async (t) => {
  const bmc = new FakeRedfish();
  const system = bmc.system;
  bmc.resources.set('/redfish/v1/Systems/Node2', { ...structuredClone(system), Id: 'Node2' });
  bmc.resource('/redfish/v1/Systems').Members.push({ '@odata.id': '/redfish/v1/Systems/Node2' });
  const world = await rackWorld({ bmc, config: baseConfig({ bmc_1_name: 'Rack' }) });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['Rack 437XR1138R2', 'Rack Node2'],
  );
});

test('a server added gets all its states at once, then only the changes', async (t) => {
  const clock = createClock();
  const world = await rackWorld({ clock });
  t.after(() => world.app.stop());
  await createDevices(world);
  const watts = featureId(world.gladys, K.POWER_DRAW);
  assert.equal(world.fake.lastState(watts), 344);
  assert.equal(world.fake.lastState(featureId(world.gladys, K.POWER)), 1);
  assert.equal(world.fake.lastState(featureId(world.gladys, K.INTAKE)), 25);
  assert.equal(world.fake.lastState(featureId(world.gladys, K.CPU)), 41);
  assert.equal(world.fake.lastState(featureId(world.gladys, K.FANS)), 2075);
  assert.equal(world.fake.lastState(featureId(world.gladys, K.FAILED_SUPPLIES)), 1);
  const health = world.fake.states.find(
    (state) => state.device_feature_external_id === featureId(world.gladys, K.HEALTH),
  );
  assert.equal(health.text, 'OK');
  assert.ok(world.fake.widgetRefreshes.length > 0, 'widget refreshed on creation');

  const count = world.fake.states.length;
  clock.advance(30_000);
  await world.hub.pollAll();
  assert.equal(world.fake.states.length, count, 'nothing changed, nothing sent');

  // A noisy value waits a minute after the last one sent; a quiet one does not.
  world.bmc.resource('/redfish/v1/Chassis/1U/Power').PowerControl[0].PowerConsumedWatts = 400;
  world.bmc.setPower('Off');
  await world.hub.pollAll();
  assert.equal(world.fake.lastState(watts), 344);
  assert.equal(world.fake.lastState(featureId(world.gladys, K.POWER)), 0);
  clock.advance(31_000);
  await world.hub.pollAll();
  assert.equal(world.fake.lastState(watts), 400);

  // Six hours unchanged: sent again before Gladys marks it outdated.
  const sent = world.fake.states.length;
  clock.advance(6 * 3600_000);
  await world.hub.pollAll();
  assert.ok(world.fake.states.length >= sent + 7);
});

test('the health text follows the language of the configuration', async (t) => {
  const world = await rackWorld({ config: baseConfig({ language: 'fr' }) });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.bmc.setHealth('Warning');
  await world.hub.pollAll();
  const id = featureId(world.gladys, K.HEALTH);
  const texts = world.fake.states.filter((s) => s.device_feature_external_id === id);
  assert.deepEqual(
    texts.map((s) => s.text),
    ['OK', 'Avertissement'],
  );
  assert.equal(world.fake.discoveredDevices[0].features[1].name, 'Santé');
});

test('health degraded: OK → Warning → Critical, not on the way back', async (t) => {
  const world = await rackWorld();
  t.after(() => world.app.stop());
  for (const health of ['Warning', 'Critical', 'Critical', 'OK', 'Critical']) {
    world.bmc.setHealth(health);
    await world.hub.pollAll();
  }
  const events = eventsOf(world, TRIGGERS.HEALTH);
  assert.deepEqual(
    events.map((event) => event.data.health),
    ['Warning', 'Critical', 'Critical'],
  );
  assert.deepEqual(events[0].data, {
    server: deviceId(world.gladys),
    server_name: 'web483',
    health: 'Warning',
  });
});

test('powered off, then on: one event each', async (t) => {
  const world = await rackWorld();
  t.after(() => world.app.stop());
  for (const state of ['PoweringOff', 'Off', 'Off', 'PoweringOn', 'On']) {
    world.bmc.setPower(state);
    await world.hub.pollAll();
  }
  assert.equal(eventsOf(world, TRIGGERS.OFF).length, 1);
  assert.equal(eventsOf(world, TRIGGERS.ON).length, 1);
});

test('a new critical log entry: announced once, every 5 minutes, never the old ones', async (t) => {
  const clock = createClock();
  const world = await rackWorld({ clock });
  t.after(() => world.app.stop());
  // The mockup logs already hold three critical entries: recorded silently.
  assert.equal(eventsOf(world, TRIGGERS.LOG).length, 0);
  const entry = (id, minute, severity = 'Critical') => ({
    Id: id,
    Severity: severity,
    Created: `2026-10-17T10:0${minute}:00Z`,
    Message: `Event ${id}`,
  });
  world.bmc.addLogEntry(LOG, entry('a', 1));
  world.bmc.addLogEntry(LOG, entry('b', 2, 'Warning'));
  clock.advance(60_000);
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.LOG).length, 0, 'not yet 5 minutes');
  clock.advance(world.hub.timings.logEveryMs);
  await world.hub.pollAll();
  assert.deepEqual(
    eventsOf(world, TRIGGERS.LOG).map((event) => event.data),
    [
      {
        server: deviceId(world.gladys),
        server_name: 'web483',
        message: 'Event a',
        created: '2026-10-17T10:01:00Z',
      },
    ],
  );
  // Five at once: the three newest, the oldest first.
  for (let i = 3; i <= 7; i += 1) {
    world.bmc.addLogEntry(LOG, entry(`c${i}`, i));
  }
  clock.advance(world.hub.timings.logEveryMs);
  await world.hub.pollAll();
  assert.deepEqual(
    eventsOf(world, TRIGGERS.LOG)
      .slice(1)
      .map((event) => event.data.message),
    ['Event c5', 'Event c6', 'Event c7'],
  );
  clock.advance(world.hub.timings.logEveryMs);
  await world.hub.pollAll();
  assert.equal(eventsOf(world, TRIGGERS.LOG).length, 4, 'never twice');
});

test('what was announced survives a restart; another address starts afresh', async (t) => {
  const bmc = new FakeRedfish();
  const first = await rackWorld({ bmc });
  bmc.setHealth('Warning');
  await first.hub.pollAll();
  await first.app.stop();
  assert.equal(eventsOf(first, TRIGGERS.HEALTH).length, 1);

  const second = await rackWorld({ bmc, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.equal(eventsOf(second, TRIGGERS.HEALTH).length, 0, 'Warning already known');
  bmc.setHealth('Critical');
  await second.hub.pollAll();
  assert.equal(eventsOf(second, TRIGGERS.HEALTH).length, 1);

  // Another controller in slot 1: its state is recorded, not announced.
  const other = new FakeRedfish();
  other.setHealth('Critical');
  second.network.controllers[URL_2] = other;
  await second.fake.configUpdated(baseConfig({ bmc_1_url: URL_2 }));
  other.setHealth('Critical');
  await second.hub.pollAll();
  assert.equal(eventsOf(second, TRIGGERS.HEALTH).length, 1);
});

test('a controller down: unreachable badge, status message, back to local', async (t) => {
  const world = await rackWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
  world.bmc.failure = 'down';
  await world.hub.pollAll();
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  const status = world.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.equal(status.message.en, '192.0.2.30: does not answer');
  assert.equal(status.message.fr, '192.0.2.30 : ne répond pas');
  world.bmc.failure = null;
  await world.hub.pollAll();
  assert.equal(world.fake.transports.at(-1).transport, 'local');
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('no controller, or an address not understood: said in the status', async (t) => {
  const empty = await createWorld({ config: { language: 'en' } });
  t.after(() => empty.app.stop());
  assert.equal(empty.fake.connectionStatus.connected, false);
  assert.match(empty.fake.connectionStatus.message.en, /Enter the address/);
  await empty.fake.configUpdated({ bmc_1_url: 'ftp://x' });
  assert.match(empty.fake.connectionStatus.message.en, /Address not understood/);
  const ack = await empty.fake.sceneAction('get_server_status', { server: 'x' });
  assert.equal(ack.success, false);
});

test('power control off: the switch is read-only and a command is refused', async (t) => {
  const world = await rackWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const [device] = world.fake.devices;
  const feature = device.features.find((f) => f.external_id.endsWith(':power'));
  const ack = await world.fake.setValue(device, feature, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Allow power control/);
  const scene = await world.fake.sceneAction('power_command', {
    server: device.external_id,
    command: 'restart',
  });
  assert.equal(scene.success, false);
  assert.deepEqual(world.bmc.resets, []);
});

test('power control on: off is a clean shutdown, on is On, restart graceful', async (t) => {
  const clock = createClock();
  const world = await rackWorld({ clock, config: baseConfig({ allow_power_control: true }) });
  t.after(() => world.app.stop());
  await createDevices(world);
  const [device] = world.fake.devices;
  const feature = device.features.find((f) => f.external_id.endsWith(':power'));
  assert.equal(feature.read_only, false);
  assert.equal((await world.fake.setValue(device, feature, 0)).success, true);
  assert.equal((await world.fake.setValue(device, feature, 1)).success, true, 'already on');
  world.bmc.setPower('Off');
  assert.equal((await world.fake.setValue(device, feature, 1)).success, true);
  const ack = await world.fake.sceneAction('power_command', {
    server: device.external_id,
    command: 'force_restart',
  });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, { reset_type: 'ForceRestart' });
  assert.deepEqual(world.bmc.resets, ['GracefulShutdown', 'On', 'ForceRestart']);
});

test('iLO 4: shutdown by a short press, no graceful restart', async (t) => {
  const bmc = new FakeRedfish({ fixture: 'ilo4-shaped' });
  const world = await rackWorld({ bmc, config: baseConfig({ allow_power_control: true }) });
  t.after(() => world.app.stop());
  const server = deviceId(world.gladys, '1');
  const shutdown = await world.fake.sceneAction('power_command', { server, command: 'shutdown' });
  assert.deepEqual(shutdown.data.outputs, { reset_type: 'PushPowerButton' });
  const restart = await world.fake.sceneAction('power_command', { server, command: 'restart' });
  assert.equal(restart.success, false);
  assert.match(restart.error, /does not offer this command/);
  assert.deepEqual(bmc.resets, ['PushPowerButton']);
});

test('a refused command says so, in the configured language', async (t) => {
  const world = await rackWorld({
    config: baseConfig({ allow_power_control: true, language: 'de' }),
  });
  t.after(() => world.app.stop());
  world.bmc.failure = 500;
  const ack = await world.fake.sceneAction('power_command', {
    server: deviceId(world.gladys),
    command: 'restart',
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /unerwartete Antwort/);
});

test('ticking power control makes Discovery propose the writable switch', async (t) => {
  const world = await rackWorld();
  t.after(() => world.app.stop());
  await world.fake.configUpdated(baseConfig({ allow_power_control: true }));
  const power = world.fake.discoveredDevices[0].features.find((f) =>
    f.external_id.endsWith(':power'),
  );
  assert.equal(power.read_only, false);
});

test('the state of a server, for a scene', async (t) => {
  const world = await rackWorld({ config: baseConfig({ language: 'fr' }) });
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('get_server_status', { server: deviceId(world.gladys) });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, {
    name: 'web483',
    online: true,
    summary:
      'web483 : allumé, santé OK, 344 W, entrée 25 °C, processeur 41 °C, ventilateurs 2\u202f075 tr/min, 1 alimentation(s) en défaut',
    power_on: true,
    health: 'OK',
    power_watts: 344,
    intake_temperature: 25,
    cpu_temperature: 41,
    fan_speed: 2075,
    failed_power_supplies: 1,
  });
  world.bmc.failure = 'down';
  world.clock.advance(20_000);
  const down = await world.fake.sceneAction('get_server_status', {
    server: deviceId(world.gladys),
  });
  assert.deepEqual(down.data.outputs, {
    name: 'web483',
    online: false,
    summary: 'web483 : ne répond pas',
  });
});

test('the timer of the container reads the controllers, without onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await rackWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  const reads = () =>
    world.bmc.requests.filter((r) => r.path === `/redfish/v1/Systems/${RACK_ID}`).length;
  const before = reads();
  world.bmc.resource('/redfish/v1/Chassis/1U/Power').PowerControl[0].PowerConsumedWatts = 500;
  t.mock.timers.tick(60_000);
  // Let the read chain settle.
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(reads() > before, 'read again by the timer');
});

test('"Test the connection" reports every controller', async (t) => {
  const world = await rackWorld({
    controllers: { [URL_1]: new FakeRedfish(), [URL_2]: new FakeRedfish() },
    config: baseConfig({ bmc_2_url: URL_2, bmc_2_username: 'gladys', bmc_2_password: 'nope' }),
  });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(
    ack.data.message.en,
    '192.0.2.30: OK, 1 server(s) (web483), session login, power control off\n198.51.100.40: user name or password refused',
  );
});
