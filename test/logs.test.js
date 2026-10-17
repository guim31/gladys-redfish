// -----------------------------------------------------------------------------
// The logs the Gladys supervisor keeps: at the info level, only the life
// cycle. A normal reading cycle (reads, states, scene events) writes nothing;
// a failure that repeats at every read writes one line, then one when it
// heals. No password ever reaches the logs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeRedfish,
  PASSWORD,
  URL_1,
  createClock,
  createDevices,
  createWorld,
} from './helpers/world.js';

/** The lines written at `LOG_LEVEL=info` from now on. */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

async function rackWorld(t) {
  const clock = createClock();
  const bmc = new FakeRedfish();
  const world = await createWorld({ clock, controllers: { [URL_1]: bmc } });
  t.after(() => world.app.stop());
  return { ...world, bmc };
}

test('a normal cycle writes nothing: reads, states, scene events', async (t) => {
  const world = await rackWorld(t);
  const lines = captureLogs(t);
  await createDevices(world);
  const power = world.bmc.resource('/redfish/v1/Chassis/1U/Power');
  for (let read = 0; read < 6; read += 1) {
    world.clock.advance(5 * 60_000);
    power.PowerControl[0].PowerConsumedWatts = 300 + read * 7;
    world.bmc.setPower(read % 2 ? 'On' : 'Off');
    world.bmc.setHealth(read === 3 ? 'Warning' : 'OK');
    world.bmc.addLogEntry('/redfish/v1/Managers/BMC/LogServices/Log/Entries', {
      Id: `n${read}`,
      Severity: 'Critical',
      Created: `2026-10-17T10:0${read}:00Z`,
      Message: 'Voltage out of range',
    });
    await world.hub.pollAll();
  }
  await world.hub.rediscover();
  assert.ok(world.fake.states.length > 20, 'states published');
  assert.ok(world.fake.sceneEvents.length >= 10, 'scene events fired');
  assert.deepEqual(lines, []);
});

test('a controller down for several reads: one line, then one when it answers again', async (t) => {
  const world = await rackWorld(t);
  await createDevices(world);
  const lines = captureLogs(t);
  world.bmc.failure = 'down';
  for (let read = 0; read < 5; read += 1) {
    world.clock.advance(61_000);
    await world.hub.pollAll();
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*Controller 1 \(192\.0\.2\.30\)/);
  world.bmc.failure = null;
  await world.hub.pollAll();
  await world.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*Controller 1 \(192\.0\.2\.30\) answers again/);
});

test('Gladys refusing the states for several reads: one line, then one', async (t) => {
  const world = await rackWorld(t);
  await createDevices(world);
  const lines = captureLogs(t);
  const publishStates = world.gladys.publishStates.bind(world.gladys);
  let refuse = true;
  t.mock.method(world.gladys, 'publishStates', async (states) => {
    if (refuse) {
      throw new Error('Gladys is away');
    }
    return publishStates(states);
  });
  const power = world.bmc.resource('/redfish/v1/Chassis/1U/Power');
  for (let read = 0; read < 5; read += 1) {
    world.clock.advance(61_000);
    power.PowerControl[0].PowerConsumedWatts = 300 + read;
    await world.hub.pollAll();
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*States refused: Gladys is away/);
  refuse = false;
  world.clock.advance(61_000);
  await world.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*States accepted again/);
});

test('the start, a power command and a refused login never show the password', async (t) => {
  const lines = captureLogs(t);
  const bmc = new FakeRedfish();
  const world = await createWorld({
    controllers: { [URL_1]: bmc },
    config: {
      bmc_1_url: '192.0.2.30',
      bmc_1_username: 'gladys',
      bmc_1_password: PASSWORD,
      allow_power_control: true,
    },
  });
  t.after(() => world.app.stop());
  await world.fake.sceneAction('power_command', {
    server: world.fake.discoveredDevices[0].external_id,
    command: 'restart',
  });
  await world.fake.configUpdated({
    bmc_1_url: '192.0.2.30',
    bmc_1_username: 'gladys',
    bmc_1_password: 'wrong-password',
  });
  const text = lines.join('\n');
  assert.match(text, /GracefulRestart sent/);
  assert.match(text, /Login refused/);
  assert.doesNotMatch(text, new RegExp(PASSWORD));
  assert.doesNotMatch(text, /wrong-password/);
});
