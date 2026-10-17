// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake controllers on a fake
// network, a temporary /data and a manual clock, with the integration wired
// on top through registerHandlers. No timer runs unless `timers` is set: the
// tests read the controllers with `world.hub.pollAll()`.
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { deviceIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { FakeRedfish, PASSWORD, USERNAME, createNetwork } from './fakeRedfish.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const URL_1 = 'https://192.0.2.30';
export const URL_2 = 'https://198.51.100.40';

export const RACK_ID = '437XR1138R2';

/** A manual clock, shared by the hub and the tests. */
export function createClock(start = Date.UTC(2026, 9, 17, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export const baseConfig = (extra = {}) => ({
  bmc_1_url: '192.0.2.30',
  bmc_1_username: USERNAME,
  bmc_1_password: PASSWORD,
  language: 'en',
  ...extra,
});

/**
 * @param {object} [options]
 * @param {Record<string, FakeRedfish>} [options.controllers] by base URL
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] devices already created in Gladys
 */
export async function createWorld({
  clock = createClock(),
  controllers,
  config = baseConfig(),
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-redfish-')),
  timings = {},
  timers = false,
} = {}) {
  const network = createNetwork(controllers ?? { [URL_1]: new FakeRedfish() });
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: network.request,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, network, app, hub: app.hub, clock, dataDir };
}

export const deviceId = (gladys, systemId = RACK_ID, slot = 1) =>
  deviceIds(gladys, slot, systemId).device;

export const featureId = (gladys, feature, systemId = RACK_ID, slot = 1) =>
  deviceIds(gladys, slot, systemId).feature(feature);

/** Add the discovered devices in Gladys, as the user would. */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

export { FakeRedfish, PASSWORD, USERNAME };
