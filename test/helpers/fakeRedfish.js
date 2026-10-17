// -----------------------------------------------------------------------------
// An in-memory Redfish controller serving the fixtures of test/fixtures/redfish
// (the DMTF public-rackmount1 mockup, an iLO 4-shaped tree), with what the
// real mockup server answers too: a session login returning X-Auth-Token and
// Location, 204 on ComputerSystem.Reset, 404 elsewhere. It also enforces the
// credentials (session or Basic) and records the resets it receives. The
// tests change its resources (health, power, a new log entry) between reads.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const USERNAME = 'gladys';
export const PASSWORD = 'test-bmc-password';

export const readFixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/redfish/${name}.json`, import.meta.url), 'utf8'));

const normalize = (path) => {
  const bare = path.split('?')[0].replace(/\/+$/, '');
  return bare === '' ? '/' : bare;
};

export class FakeRedfish {
  /**
   * @param {object} [options]
   * @param {string} [options.fixture] fixture name
   * @param {'session'|'basic'|'none'} [options.auth] what the controller accepts
   * @param {boolean} [options.subsystemOnly] drop the legacy Thermal/Power links
   */
  constructor({ fixture = 'public-rackmount1', auth = 'session', subsystemOnly = false } = {}) {
    this.resources = new Map(
      Object.entries(readFixture(fixture)).map(([path, body]) => [normalize(path), body]),
    );
    this.auth = auth;
    this.tokens = new Set();
    this.sessions = 0;
    this.resets = [];
    this.requests = [];
    /** 'down', 'tls', 'html', or an HTTP status for every request */
    this.failure = null;
    if (subsystemOnly) {
      for (const [path, body] of this.resources) {
        if (body['@odata.type']?.startsWith('#Chassis.')) {
          delete body.Thermal;
          delete body.Power;
        }
        if (/\/(Thermal|Power)$/.test(path)) {
          this.resources.delete(path);
        }
      }
    }
  }

  /** The resource at a path (edit it to change what the controller says). */
  resource(path) {
    return this.resources.get(normalize(path));
  }

  get systemPath() {
    return normalize(this.resource('/redfish/v1/Systems').Members[0]['@odata.id']);
  }

  get system() {
    return this.resource(this.systemPath);
  }

  setHealth(health) {
    this.system.Status.Health = health;
    this.system.Status.HealthRollup = health;
  }

  setPower(state) {
    this.system.PowerState = state;
  }

  /** A new entry at the top of a log (newest first). */
  addLogEntry(entriesPath, entry) {
    const page = this.resource(entriesPath);
    page.Members.unshift({
      '@odata.id': `${normalize(entriesPath)}/${entry.Id}`,
      ...entry,
    });
    page['Members@odata.count'] = page.Members.length;
  }

  authorized(headers) {
    if (this.auth === 'none') {
      return true;
    }
    if (this.auth === 'session' && this.tokens.has(headers['x-auth-token'])) {
      return true;
    }
    const basic = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
    return this.auth === 'basic' && headers.authorization === basic;
  }

  async handle(path, { method = 'GET', headers = {}, body } = {}) {
    this.requests.push({ method, path });
    if (this.failure === 'down') {
      const error = new Error('connect ECONNREFUSED');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    if (this.failure === 'tls') {
      const error = new Error('self-signed certificate');
      error.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
      throw error;
    }
    if (this.failure === 'html') {
      return { status: 200, headers: {}, body: '<!doctype html><title>Router</title>' };
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, headers: {}, body: 'error' };
    }
    const target = normalize(path);
    if (method === 'POST' && target === '/redfish/v1/SessionService/Sessions') {
      if (this.auth !== 'session') {
        return { status: 405, headers: {}, body: '' };
      }
      const payload = JSON.parse(body ?? '{}');
      if (payload.UserName !== USERNAME || payload.Password !== PASSWORD) {
        return { status: 401, headers: {}, body: '' };
      }
      this.sessions += 1;
      const token = `token-${this.sessions}`;
      this.tokens.add(token);
      return {
        status: 204,
        headers: {
          'x-auth-token': token,
          location: `/redfish/v1/SessionService/Sessions/${this.sessions}`,
        },
        body: '{}',
      };
    }
    // The service root is public, the rest needs the credentials.
    if (target !== '/redfish/v1' && !this.authorized(headers)) {
      return { status: 401, headers: {}, body: '{"error":{"code":"Base.1.0.NoValidSession"}}' };
    }
    if (method === 'DELETE' && target.startsWith('/redfish/v1/SessionService/Sessions/')) {
      this.tokens.delete(headers['x-auth-token']);
      return { status: 204, headers: {}, body: '' };
    }
    if (method === 'POST' && target.endsWith('/Actions/ComputerSystem.Reset')) {
      const { ResetType } = JSON.parse(body ?? '{}');
      const allowed =
        this.system.Actions['#ComputerSystem.Reset']['ResetType@Redfish.AllowableValues'];
      if (allowed && !allowed.includes(ResetType)) {
        return {
          status: 400,
          headers: {},
          body: JSON.stringify({
            error: { '@Message.ExtendedInfo': [{ Message: `${ResetType} is not supported` }] },
          }),
        };
      }
      this.resets.push(ResetType);
      return { status: 204, headers: {}, body: '' };
    }
    const resource = this.resources.get(target);
    if (method !== 'GET' || !resource) {
      return { status: 404, headers: {}, body: '{"error":{"code":"Base.1.0.ResourceMissing"}}' };
    }
    return { status: 200, headers: {}, body: JSON.stringify(resource) };
  }
}

/**
 * A network of fake controllers, by base URL: the `request` function the
 * client takes. An unknown address does not answer.
 */
export function createNetwork(controllers) {
  const network = {
    controllers,
    async request(url, options = {}) {
      for (const [base, controller] of Object.entries(network.controllers)) {
        if (url.startsWith(`${base}/`)) {
          return controller.handle(url.slice(base.length), {
            ...options,
            headers: Object.fromEntries(
              Object.entries(options.headers ?? {}).map(([key, value]) => [
                key.toLowerCase(),
                value,
              ]),
            ),
          });
        }
      }
      const error = new Error('connect EHOSTUNREACH');
      error.code = 'EHOSTUNREACH';
      throw error;
    },
  };
  return network;
}
