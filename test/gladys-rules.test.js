// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the DMTF
// public-rackmount1 mockup (legacy Thermal/Power, and the newer subsystems
// alone) and the iLO 4-shaped tree, with power control on and off, in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeRedfish, URL_1, URL_2, baseConfig, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const URL_3 = 'https://192.0.2.31';

async function discover(language, control) {
  const world = await createWorld({
    controllers: {
      [URL_1]: new FakeRedfish(),
      [URL_2]: new FakeRedfish({ subsystemOnly: true }),
      [URL_3]: new FakeRedfish({ fixture: 'ilo4-shaped' }),
    },
    config: baseConfig({
      bmc_2_url: URL_2,
      bmc_2_username: 'gladys',
      bmc_2_password: 'test-bmc-password',
      bmc_3_url: URL_3,
      bmc_3_username: 'gladys',
      bmc_3_password: 'test-bmc-password',
      language,
      allow_power_control: control,
    }),
  });
  await world.app.stop();
  return world.fake.discoveredDevices;
}

const scenarios = [
  { label: 'English names, read-only', language: 'en', control: false },
  { label: 'French names, power control', language: 'fr', control: true },
  { label: 'German names', language: 'de', control: false },
  { label: 'Spanish names, power control', language: 'es', control: true },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = await discover(scenario.language, scenario.control);
    assert.equal(devices.length, 3, 'one server per controller');
    assert.equal(
      new Set(devices.map((device) => device.external_id)).size,
      devices.length,
      'unique device external ids',
    );

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length >= 5, `${where}: features missing`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
      // Only the power switch can be writable, and only when allowed.
      const writable = device.features.filter((feature) => !feature.read_only);
      assert.deepEqual(
        writable.map((feature) => feature.external_id.split(':').pop()),
        scenario.control ? ['power'] : [],
      );
    }
  });
}
