// -----------------------------------------------------------------------------
// From raw Redfish resources to figures, on the DMTF mockup (legacy and
// subsystem resources) and the iLO 4-shaped tree: what each vendor variant
// gives, and what is ignored (absent sensors, null readings).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedfishClient } from '../src/redfish/client.js';
import {
  criticalEntries,
  isOn,
  parseSystem,
  watchedLogServices,
  worstHealth,
} from '../src/redfish/model.js';
import { chooseResetType } from '../src/hub.js';
import { FakeRedfish, PASSWORD, USERNAME, createNetwork } from './helpers/fakeRedfish.js';

async function read(options) {
  const bmc = new FakeRedfish(options);
  const client = new RedfishClient({
    url: 'https://192.0.2.30',
    username: USERNAME,
    password: PASSWORD,
    request: createNetwork({ 'https://192.0.2.30': bmc }).request,
  });
  const raw = await client.read();
  return { raw, systems: raw.map(parseSystem), client, bmc };
}

test('DMTF mockup, legacy Thermal and Power', async () => {
  const { systems } = await read();
  assert.equal(systems.length, 1);
  const [system] = systems;
  assert.equal(system.id, '437XR1138R2');
  assert.equal(system.name, 'web483');
  assert.equal(system.model, 'Contoso 3500');
  assert.equal(system.on, true);
  assert.equal(system.health, 'OK');
  assert.equal(system.watts, 344);
  assert.equal(system.intake, 25, 'Chassis Intake Temp');
  assert.equal(system.cpu, 41, 'CPU2 Temp is disabled, without reading');
  assert.deepEqual(system.fans, { speed: 2075, unit: 'rpm', count: 2, failed: 0 });
  assert.deepEqual(system.supplies, { count: 1, failed: 1 }, 'the bay in Warning');
  assert.equal(system.canReset, true);
});

test('DMTF mockup, ThermalSubsystem and PowerSubsystem only', async () => {
  const { systems, bmc } = await read({ subsystemOnly: true });
  const [system] = systems;
  assert.equal(system.watts, 374, 'EnvironmentMetrics.PowerWatts');
  assert.equal(system.intake, 24.8, 'ThermalMetrics.TemperatureSummaryCelsius.Intake');
  assert.equal(system.cpu, null, 'no processor reading in ThermalMetrics');
  assert.deepEqual(system.fans, { speed: 45, unit: 'percent', count: 4, failed: 0 });
  assert.deepEqual(system.supplies, { count: 1, failed: 1 }, 'Bay2 is Absent');
  assert.ok(!bmc.requests.some((request) => /\/(Thermal|Power)$/.test(request.path)));
});

test('iLO 4 shape: FanName, CurrentReading in percent, CPU contexts', async () => {
  const { systems } = await read({ fixture: 'ilo4-shaped' });
  const [system] = systems;
  assert.equal(system.id, '1');
  assert.equal(system.name, 'Computer System', 'an empty HostName is skipped');
  assert.equal(system.hostName, null);
  assert.equal(system.model, 'HPE ProLiant DL360 Gen9');
  assert.equal(system.intake, 21);
  assert.equal(system.cpu, 44, 'the hottest of the two processors');
  assert.deepEqual(system.fans, { speed: 24, unit: 'percent', count: 2, failed: 0 });
  assert.deepEqual(system.supplies, { count: 2, failed: 0 });
  assert.equal(system.watts, 128);
});

test('health: rollup first, the worst of system and chassis', () => {
  assert.equal(worstHealth('OK', null, 'Warning'), 'Warning');
  assert.equal(worstHealth('Critical', 'Warning'), 'Critical');
  assert.equal(worstHealth(null, 'Unknown'), null);
  const system = {
    entry: { id: '1', path: '/s/1', chassisHealth: { Health: 'OK', HealthRollup: 'Critical' } },
    system: { Status: { Health: 'OK', HealthRollup: 'Warning' }, PowerState: 'Off' },
    thermal: null,
    power: null,
    subsystem: null,
  };
  const parsed = parseSystem(system);
  assert.equal(parsed.health, 'Critical');
  assert.equal(parsed.on, false);
  assert.equal(parsed.fans, null);
  assert.equal(parsed.supplies, null);
  assert.equal(parsed.watts, null);
  assert.equal(parsed.name, '1');
});

test('power states', () => {
  assert.equal(isOn('On'), true);
  assert.equal(isOn('PoweringOn'), true);
  assert.equal(isOn('Off'), false);
  assert.equal(isOn('PoweringOff'), false);
  assert.equal(isOn(undefined), null);
});

test('the event logs watched: SEL, IEL, IML, never the iDRAC Lifecycle log', () => {
  const service = (id, name = id) => ({ id, name, path: `/l/${id}`, entries: `/l/${id}/Entries` });
  const idrac = [
    service('Sel'),
    service('Lclog', 'Lifecycle Controller Log'),
    service('FaultList'),
  ];
  assert.deepEqual(
    watchedLogServices(idrac).map((s) => s.id),
    ['Sel'],
  );
  assert.deepEqual(
    watchedLogServices([service('IEL'), service('IML')]).map((s) => s.id),
    ['IEL', 'IML'],
  );
  assert.deepEqual(
    watchedLogServices([service('EventLog'), service('Journal'), service('Dump')]).map((s) => s.id),
    ['EventLog'],
  );
  // Unknown names: every service but the skipped ones.
  assert.deepEqual(
    watchedLogServices([service('Health'), service('AuditLog')]).map((s) => s.id),
    ['Health'],
  );
  assert.deepEqual(watchedLogServices([{ ...service('Sel'), entries: null }]), []);
});

test('critical entries, newest first, keyed by their link', async () => {
  const { client } = await read({ fixture: 'ilo4-shaped' });
  const entries = await client.readLog('/redfish/v1/Systems/1/LogServices/IML/Entries/');
  assert.equal(entries.length, 2);
  assert.deepEqual(criticalEntries(entries), [
    {
      key: '/redfish/v1/Systems/1/LogServices/IML/Entries/2/|2026-09-02T09:30:00Z',
      message: 'Power Supply Failure (Power Supply 2)',
      created: '2026-09-02T09:30:00Z',
    },
  ]);
});

test('the reset type of each command, never a forced power off', () => {
  const all = ['On', 'ForceOff', 'GracefulShutdown', 'GracefulRestart', 'ForceRestart'];
  const ilo4 = ['On', 'ForceOff', 'ForceRestart', 'Nmi', 'PushPowerButton'];
  assert.equal(chooseResetType('on', all, false), 'On');
  assert.equal(chooseResetType('on', all, true), null, 'already on');
  assert.equal(chooseResetType('shutdown', all, true), 'GracefulShutdown');
  assert.equal(chooseResetType('shutdown', all, false), null, 'already off');
  assert.equal(chooseResetType('shutdown', ilo4, true), 'PushPowerButton');
  assert.equal(chooseResetType('shutdown', ['On', 'ForceOff'], true), undefined);
  assert.equal(chooseResetType('restart', all, true), 'GracefulRestart');
  assert.equal(chooseResetType('restart', ilo4, true), undefined);
  assert.equal(chooseResetType('force_restart', ilo4, true), 'ForceRestart');
  assert.equal(chooseResetType('on', ['ForceOn', 'PushPowerButton'], false), 'PushPowerButton');
  // Not advertised: the standard value is tried.
  assert.equal(chooseResetType('shutdown', null, null), 'GracefulShutdown');
  assert.equal(chooseResetType('force_off', all, true), undefined);
  for (const command of ['on', 'shutdown', 'restart', 'force_restart']) {
    for (const allowed of [all, ilo4, null]) {
      assert.notEqual(chooseResetType(command, allowed, true), 'ForceOff');
      assert.notEqual(chooseResetType(command, allowed, false), 'ForceOff');
    }
  }
});
