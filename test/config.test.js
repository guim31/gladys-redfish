import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseBmcUrl } from '../src/config.js';

test('a controller address: bare host in HTTPS, a pasted URL reduced to its origin', () => {
  assert.equal(parseBmcUrl('192.0.2.30'), 'https://192.0.2.30');
  assert.equal(parseBmcUrl(' idrac.lan:8443 '), 'https://idrac.lan:8443');
  assert.equal(parseBmcUrl('https://ilo.lan/redfish/v1/'), 'https://ilo.lan');
  assert.equal(parseBmcUrl('https://192.0.2.30/restgui/start.html#x'), 'https://192.0.2.30');
  assert.equal(parseBmcUrl('http://192.0.2.31:8000'), 'http://192.0.2.31:8000');
  assert.equal(parseBmcUrl('https://root:calvin@idrac.lan'), null, 'no credentials in the URL');
  assert.equal(parseBmcUrl('ftp://idrac.lan'), null);
  assert.equal(parseBmcUrl('http://'), null);
  assert.equal(parseBmcUrl(''), null);
  assert.equal(parseBmcUrl(42), null);
});

test('the defaults: nothing configured, read-only, certificates checked, French names', () => {
  const config = normalizeConfig(DEFAULT_CONFIG);
  assert.deepEqual(config, {
    bmcs: [],
    invalidSlots: [],
    allowSelfSigned: false,
    allowPowerControl: false,
    pollIntervalMs: 60_000,
    language: 'fr',
  });
  assert.deepEqual(normalizeConfig(null).bmcs, []);
});

test('three slots, an invalid one, options as strings or booleans', () => {
  const config = normalizeConfig({
    bmc_1_url: '192.0.2.30',
    bmc_1_username: ' root ',
    bmc_1_password: 'pass word\n',
    bmc_1_name: ' Rack ',
    bmc_2_url: 'ftp://nope',
    bmc_3_url: 'ilo.lan',
    poll_interval: 300,
    allow_self_signed: 'true',
    allow_power_control: true,
    language: 'de',
  });
  assert.deepEqual(config.bmcs, [
    { slot: 1, url: 'https://192.0.2.30', username: 'root', password: 'pass word', name: 'Rack' },
    { slot: 3, url: 'https://ilo.lan', username: '', password: '', name: null },
  ]);
  assert.deepEqual(config.invalidSlots, [2]);
  assert.equal(config.pollIntervalMs, 300_000);
  assert.equal(config.allowSelfSigned, true);
  assert.equal(config.allowPowerControl, true);
  assert.equal(config.language, 'de');
  assert.equal(normalizeConfig({ poll_interval: '5', language: 'it' }).pollIntervalMs, 60_000);
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
});
