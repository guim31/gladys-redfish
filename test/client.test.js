// -----------------------------------------------------------------------------
// The Redfish client against the fake controller: session login and its
// renewal, the Basic fallback, no authentication, the errors the user can act
// on, the topology cache, the log tail, the reset action and its ActionInfo.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, RedfishClient, TOPOLOGY_TTL_MS } from '../src/redfish/client.js';
import { FakeRedfish, PASSWORD, USERNAME, createNetwork } from './helpers/fakeRedfish.js';

const URL = 'https://192.0.2.30';

function clientFor(bmc, options = {}) {
  let time = 0;
  const client = new RedfishClient({
    url: URL,
    username: USERNAME,
    password: PASSWORD,
    request: createNetwork({ [URL]: bmc }).request,
    now: () => time,
    ...options,
  });
  return { client, advance: (ms) => (time += ms) };
}

const kindOf = (kind) => (err) => {
  assert.equal(err.kind, kind, err.message);
  return true;
};

test('a session is opened once, its token used, closed on logout', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  await client.read();
  await client.read();
  assert.equal(client.auth, 'session');
  assert.equal(bmc.sessions, 1);
  assert.equal(bmc.tokens.size, 1);
  await client.logout();
  assert.equal(bmc.tokens.size, 0, 'session deleted on the controller');
  assert.ok(bmc.requests.some((r) => r.method === 'DELETE' && /Sessions\/1$/.test(r.path)));
});

test('an expired session is renewed once', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  await client.read();
  bmc.tokens.clear(); // the controller restarted, or the session timed out
  await client.read();
  assert.equal(bmc.sessions, 2);
});

test('a controller without sessions gets Basic', async () => {
  const bmc = new FakeRedfish({ auth: 'basic' });
  const { client } = clientFor(bmc);
  const raw = await client.read();
  assert.equal(raw.length, 1);
  assert.equal(client.auth, 'basic');
});

test('no user name: no authentication', async () => {
  const bmc = new FakeRedfish({ auth: 'none' });
  const { client } = clientFor(bmc, { username: '', password: '' });
  await client.read();
  assert.equal(client.auth, 'none');
  assert.equal(bmc.sessions, 0);
});

test('a wrong password, a certificate, silence, another service: the error kinds', async () => {
  const bmc = new FakeRedfish();
  await assert.rejects(
    clientFor(bmc, { password: 'nope' }).client.read(),
    kindOf(ERROR_KINDS.AUTH),
  );
  bmc.failure = 'tls';
  await assert.rejects(clientFor(bmc).client.read(), kindOf(ERROR_KINDS.TLS));
  bmc.failure = 'down';
  await assert.rejects(clientFor(bmc).client.read(), kindOf(ERROR_KINDS.UNREACHABLE));
  bmc.failure = 'html';
  await assert.rejects(clientFor(bmc).client.read(), kindOf(ERROR_KINDS.NOT_REDFISH));
  bmc.failure = 404;
  await assert.rejects(clientFor(bmc).client.read(), kindOf(ERROR_KINDS.NOT_REDFISH));
  bmc.failure = 500;
  await assert.rejects(clientFor(bmc).client.read(), kindOf(ERROR_KINDS.HTTP));
  bmc.failure = null;
  bmc.resource('/redfish/v1/Systems').Members = [];
  await assert.rejects(clientFor(bmc).client.read(), kindOf(ERROR_KINDS.NO_SYSTEM));
});

test('a basic-auth controller refusing the password says so', async () => {
  const bmc = new FakeRedfish({ auth: 'basic' });
  await assert.rejects(
    clientFor(bmc, { password: 'nope' }).client.read(),
    kindOf(ERROR_KINDS.AUTH),
  );
});

test('the topology is read once an hour; a moved link reads it again', async () => {
  const bmc = new FakeRedfish();
  const { client, advance } = clientFor(bmc);
  await client.read();
  const count = () => bmc.requests.filter((r) => r.path === '/redfish/v1/Systems').length;
  await client.read();
  assert.equal(count(), 1);
  advance(TOPOLOGY_TTL_MS);
  await client.read();
  assert.equal(count(), 2);
  // A firmware update moved the system: 404, then the topology is read again.
  const system = bmc.resources.get('/redfish/v1/Systems/437XR1138R2');
  bmc.resources.delete('/redfish/v1/Systems/437XR1138R2');
  bmc.resources.set('/redfish/v1/Systems/System.Embedded.1', {
    ...system,
    Id: 'System.Embedded.1',
  });
  bmc.resource('/redfish/v1/Systems').Members = [
    { '@odata.id': '/redfish/v1/Systems/System.Embedded.1' },
  ];
  const raw = await client.read();
  assert.equal(raw[0].entry.id, 'System.Embedded.1');
  assert.equal(count(), 3);
});

test('a long log: the first page, then its tail with $skip', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  const path = '/redfish/v1/Managers/BMC/LogServices/Log/Entries';
  const page = bmc.resource(path);
  page['Members@odata.count'] = 120;
  page['@odata.nextLink'] = `${path}?$skiptoken=50`;
  const entries = await client.readLog(path);
  assert.equal(entries.length, 2, 'the fake serves the same page for the tail');
  assert.ok(bmc.requests.some((r) => r.path === `${path}?$skip=119`));
});

test('the reset types come from the action, or from its ActionInfo', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  const path = '/redfish/v1/Systems/437XR1138R2';
  let info = await client.resetInfo(path);
  assert.equal(info.target, '/redfish/v1/Systems/437XR1138R2/Actions/ComputerSystem.Reset');
  assert.ok(info.allowed.includes('GracefulShutdown'));
  const action = bmc.system.Actions['#ComputerSystem.Reset'];
  delete action['ResetType@Redfish.AllowableValues'];
  action['@Redfish.ActionInfo'] = '/redfish/v1/Systems/437XR1138R2/ResetActionInfo';
  bmc.resources.set('/redfish/v1/Systems/437XR1138R2/ResetActionInfo', {
    Parameters: [{ Name: 'ResetType', AllowableValues: ['On', 'GracefulShutdown'] }],
  });
  info = await client.resetInfo(path);
  assert.deepEqual(info.allowed, ['On', 'GracefulShutdown']);
  await client.reset(info.target, 'GracefulShutdown');
  assert.deepEqual(bmc.resets, ['GracefulShutdown']);
});

test('a refused reset carries the message of the controller', async () => {
  const bmc = new FakeRedfish({ fixture: 'ilo4-shaped' });
  const { client } = clientFor(bmc);
  await assert.rejects(
    client.reset('/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', 'GracefulRestart'),
    /HTTP 400\): GracefulRestart is not supported/,
  );
});

test('a resource the account may not read (403) is as good as absent', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  const handle = bmc.handle.bind(bmc);
  bmc.handle = async (path, options) =>
    path.startsWith('/redfish/v1/Managers/BMC/LogServices')
      ? { status: 403, headers: {}, body: '' }
      : handle(path, options);
  const raw = await client.read();
  assert.deepEqual(
    raw[0].entry.logServices.map((service) => service.id),
    ['Log1'],
  );
  assert.equal(await client.readLog('/redfish/v1/Managers/BMC/LogServices/Log/Entries'), null);
  assert.equal(bmc.sessions, 1, 'the session is kept');
});

test('a password refused after a renewal leaves no session open', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  await client.read();
  // Every token is refused from now on, the login itself still works.
  bmc.authorized = () => false;
  await assert.rejects(client.read(), kindOf(ERROR_KINDS.AUTH));
  assert.equal(bmc.sessions, 2);
  assert.equal(client.token, null);
  assert.equal(bmc.requests.filter((r) => r.method === 'DELETE').length, 2, 'both sessions closed');
});

test('concurrent requests share one login; a closed client opens none', async () => {
  const bmc = new FakeRedfish();
  const { client } = clientFor(bmc);
  await Promise.all([client.read(), client.resetInfo('/redfish/v1/Systems/437XR1138R2')]);
  assert.equal(bmc.sessions, 1);
  await client.logout({ close: true });
  await assert.rejects(client.read(), kindOf(ERROR_KINDS.UNREACHABLE));
  assert.equal(bmc.sessions, 1);
});

test('the session is closed through the @odata.id of the body without Location', async () => {
  const bmc = new FakeRedfish();
  const handle = bmc.handle.bind(bmc);
  bmc.handle = async (path, options) => {
    const response = await handle(path, options);
    if (options.method === 'POST' && /Sessions$/.test(path)) {
      const { location, ...headers } = response.headers;
      return { ...response, headers, body: JSON.stringify({ '@odata.id': location }) };
    }
    return response;
  };
  const { client } = clientFor(bmc);
  await client.read();
  await client.logout();
  assert.equal(bmc.tokens.size, 0);
});
