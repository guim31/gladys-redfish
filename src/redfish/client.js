// -----------------------------------------------------------------------------
// A Redfish client for one management controller (BMC): session login, GETs
// that follow the `@odata.id` links (never a vendor path written by hand),
// the ComputerSystem.Reset action, and the error kinds the user can act on.
//
// Authentication: a Redfish session (POST SessionService/Sessions, then the
// X-Auth-Token header), the way the controllers want to be used — Basic on
// every request makes some iLO and iDRAC versions log a login each time. A
// controller that refuses sessions (404, 405, 501) gets Basic. A token that
// expires (401) is renewed once. No user name: no authentication at all
// (test mockups, a controller behind an authenticating proxy).
//
// The topology (systems, their chassis, thermal and power resources, log
// services) is read once and kept an hour: it changes with the hardware only.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ROOT = '/redfish/v1/';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable',
  TLS: 'tls',
  AUTH: 'auth',
  NOT_REDFISH: 'not_redfish',
  NO_SYSTEM: 'no_system',
  HTTP: 'http',
});

export class RedfishError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

// Status codes that mean "no session service here": fall back to Basic.
const NO_SESSIONS = new Set([400, 404, 405, 501]);

export const TOPOLOGY_TTL_MS = 3600_000;

/** The `@odata.id` of a link object, null when absent. */
export const linkOf = (value) =>
  value && typeof value === 'object' && typeof value['@odata.id'] === 'string'
    ? value['@odata.id']
    : null;

const membersOf = (collection) =>
  Array.isArray(collection?.Members) ? collection.Members.map(linkOf).filter(Boolean) : [];

export class RedfishClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL (`https://host[:port]`)
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {boolean} [options.insecure] accept a self-signed certificate
   * @param {Function} [options.request] HTTP seam (src/redfish/http.js)
   * @param {() => number} [options.now]
   */
  constructor({ url, username = '', password = '', insecure = false, request, now }) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request ?? httpRequest;
    this.now = now ?? (() => Date.now());
    /** 'session' | 'basic' | 'none' once known */
    this.auth = username ? null : 'none';
    this.token = null;
    this.sessionUrl = null;
    this.loggingIn = null;
    this.closed = false;
    this.root = null;
    this.topology = null;
    this.topologyAt = 0;
  }

  // --- Transport ---------------------------------------------------------------

  async send(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { accept: 'application/json', 'odata-version': '4.0' };
    if (auth && this.auth === 'session' && this.token) {
      headers['x-auth-token'] = this.token;
    } else if (auth && this.auth === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString(
        'base64',
      )}`;
    }
    try {
      return await this.request(new URL(path, this.url).href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        insecure: this.insecure,
      });
    } catch (err) {
      if (TLS_CODES.has(err.code) || /certificate|ssl|tls/i.test(err.message ?? '')) {
        throw new RedfishError(ERROR_KINDS.TLS, `TLS: ${err.code ?? err.message}`);
      }
      throw new RedfishError(ERROR_KINDS.UNREACHABLE, err.code ?? err.message);
    }
  }

  /**
   * Log in when needed; the session token, Basic, or nothing. Concurrent
   * calls share one login: a poll and a command never open two sessions.
   */
  login() {
    if (this.auth === 'none' || this.auth === 'basic' || this.token) {
      return Promise.resolve();
    }
    if (this.closed) {
      return Promise.reject(new RedfishError(ERROR_KINDS.UNREACHABLE, 'Client closed'));
    }
    this.loggingIn ??= this.openSession().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  async openSession() {
    const root = await this.getRoot();
    const sessions = linkOf(root?.Links?.Sessions) ?? '/redfish/v1/SessionService/Sessions';
    const response = await this.send(sessions, {
      method: 'POST',
      body: { UserName: this.username, Password: this.password },
      auth: false,
    });
    if (response.status === 401 || response.status === 403) {
      throw new RedfishError(ERROR_KINDS.AUTH, `Login refused (HTTP ${response.status})`, 401);
    }
    const token = response.headers?.['x-auth-token'];
    if (response.status >= 200 && response.status < 300 && token) {
      this.auth = 'session';
      this.token = token;
      // The Location header, or the @odata.id of the session the spec puts in the body.
      const location = response.headers?.location;
      let created = null;
      try {
        created = linkOf(JSON.parse(response.body || 'null'));
      } catch {
        // No JSON body (the DMTF mockup answers 204).
      }
      this.sessionUrl = typeof location === 'string' && location ? location : created;
      if (this.closed) {
        // Stopped while logging in: close it at once.
        await this.logout();
      }
      return;
    }
    if (NO_SESSIONS.has(response.status) || (response.status < 300 && !token)) {
      this.auth = 'basic';
      return;
    }
    throw new RedfishError(
      ERROR_KINDS.HTTP,
      `Login: HTTP ${response.status} from ${sessions}`,
      response.status,
    );
  }

  /**
   * Close the session (best effort): controllers allow few at once.
   * @param {object} [options]
   * @param {boolean} [options.close] for good: no login afterwards (stop, reconfiguration)
   */
  async logout({ close = false } = {}) {
    if (close) {
      this.closed = true;
    }
    if (this.auth !== 'session' || !this.token) {
      return;
    }
    const url = this.sessionUrl;
    const token = this.token;
    this.token = null;
    this.auth = null;
    if (!url) {
      return;
    }
    try {
      await this.request(new URL(url, this.url).href, {
        method: 'DELETE',
        headers: { 'x-auth-token': token },
        insecure: this.insecure,
        timeoutMs: 5000,
      });
    } catch {
      // The session times out on the controller anyway.
    }
  }

  /**
   * A request with authentication, renewing an expired session once.
   * @returns {Promise<{ status: number, headers: object, body: string }>}
   */
  async authorized(path, options = {}) {
    await this.login();
    let response = await this.send(path, options);
    if (response.status === 401 && this.auth === 'session') {
      await this.logout();
      await this.login();
      response = await this.send(path, options);
      if (response.status === 401) {
        // Refused again: do not leave this session open behind.
        await this.logout();
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new RedfishError(
        ERROR_KINDS.AUTH,
        `HTTP ${response.status} on ${path}`,
        response.status,
      );
    }
    return response;
  }

  /** GET a resource as JSON. */
  async get(path, { auth = true } = {}) {
    const response = auth ? await this.authorized(path) : await this.send(path, { auth: false });
    if (response.status < 200 || response.status >= 300) {
      throw new RedfishError(
        response.status === 404 && path === ROOT ? ERROR_KINDS.NOT_REDFISH : ERROR_KINDS.HTTP,
        `HTTP ${response.status} on ${path}`,
        response.status,
      );
    }
    try {
      return JSON.parse(response.body);
    } catch {
      throw new RedfishError(ERROR_KINDS.NOT_REDFISH, `Not JSON on ${path}`);
    }
  }

  /** GET, null on a 404 (an optional resource). */
  async optional(path) {
    if (!path) {
      return null;
    }
    try {
      return await this.get(path);
    } catch (err) {
      // A resource the account may not read (403) is as good as absent.
      if (
        (err.kind === ERROR_KINDS.HTTP && [404, 405, 501].includes(err.status)) ||
        (err.kind === ERROR_KINDS.AUTH && err.status === 403)
      ) {
        return null;
      }
      throw err;
    }
  }

  /** The service root, readable without authentication (Redfish spec). */
  async getRoot() {
    if (!this.root) {
      const root = await this.get(ROOT, { auth: false }).catch((err) => {
        // A controller that wants authentication even there.
        if (err.status === 401 && this.auth !== 'none') {
          return null;
        }
        throw err;
      });
      if (root !== null && (typeof root !== 'object' || !root['@odata.id'])) {
        throw new RedfishError(ERROR_KINDS.NOT_REDFISH, 'No Redfish service root');
      }
      this.root = root;
    }
    return this.root;
  }

  async members(path) {
    const collection = await this.optional(path);
    return membersOf(collection);
  }

  // --- Topology ---------------------------------------------------------------

  /**
   * Every computer system with the links to read it.
   * @returns {Promise<Array<object>>}
   */
  async getTopology({ force = false } = {}) {
    if (!force && this.topology && this.now() - this.topologyAt < TOPOLOGY_TTL_MS) {
      return this.topology;
    }
    await this.login();
    const root = (await this.getRoot()) ?? (this.root = await this.get(ROOT));
    const systemsPath = linkOf(root.Systems);
    if (!systemsPath) {
      throw new RedfishError(ERROR_KINDS.NO_SYSTEM, 'No Systems collection');
    }
    const systems = [];
    for (const path of await this.members(systemsPath)) {
      const system = await this.get(path);
      const chassisPath = linkOf(system.Links?.Chassis?.[0]);
      const chassis = chassisPath ? await this.optional(chassisPath) : null;
      const managerPath = linkOf(system.Links?.ManagedBy?.[0]);
      const manager = managerPath ? await this.optional(managerPath) : null;
      const logServices = [];
      for (const owner of [manager, system]) {
        for (const servicePath of await this.members(linkOf(owner?.LogServices))) {
          const service = await this.optional(servicePath);
          if (service) {
            logServices.push({
              path: servicePath,
              id: String(service.Id ?? ''),
              name: String(service.Name ?? ''),
              entries: linkOf(service.Entries),
            });
          }
        }
      }
      systems.push({
        path,
        id: String(system.Id ?? path.split('/').filter(Boolean).pop()),
        chassisPath,
        thermal: linkOf(chassis?.Thermal),
        power: linkOf(chassis?.Power),
        thermalSubsystem: linkOf(chassis?.ThermalSubsystem),
        powerSubsystem: linkOf(chassis?.PowerSubsystem),
        environment: linkOf(chassis?.EnvironmentMetrics),
        chassisHealth: chassis?.Status ?? null,
        logServices,
      });
    }
    if (systems.length === 0) {
      throw new RedfishError(ERROR_KINDS.NO_SYSTEM, 'The Systems collection is empty');
    }
    this.topology = systems;
    this.topologyAt = this.now();
    return systems;
  }

  /** Forget the topology: read again at the next call (a 404, a new card…). */
  forgetTopology() {
    this.topology = null;
  }

  // --- Reads -----------------------------------------------------------------

  /**
   * The raw resources of every system: the system itself, its thermal and
   * power resources (the legacy Thermal/Power when the controller has them:
   * one request each, everything in it; the newer subsystems otherwise).
   */
  async read() {
    let topology = await this.getTopology();
    try {
      return await this.readTopology(topology);
    } catch (err) {
      if (err.kind !== ERROR_KINDS.HTTP || err.status !== 404) {
        throw err;
      }
      // A link moved (firmware update): read the topology again, once.
      topology = await this.getTopology({ force: true });
      return this.readTopology(topology);
    }
  }

  async readTopology(topology) {
    const results = [];
    for (const entry of topology) {
      const system = await this.get(entry.path);
      // The chassis again: its health rollup moves (a power supply, a fan).
      const chassis = entry.chassisPath ? await this.optional(entry.chassisPath) : null;
      const raw = { entry, system, chassis, thermal: null, power: null, subsystem: null };
      if (entry.thermal) {
        raw.thermal = await this.optional(entry.thermal);
      }
      if (entry.power) {
        raw.power = await this.optional(entry.power);
      }
      if (!raw.thermal || !raw.power) {
        raw.subsystem = await this.readSubsystems(entry, {
          thermal: !raw.thermal,
          power: !raw.power,
        });
      }
      results.push(raw);
    }
    return results;
  }

  async readSubsystems(entry, { thermal, power }) {
    const result = { fans: [], thermalMetrics: null, powerSupplies: [], environment: null };
    if (thermal && entry.thermalSubsystem) {
      const subsystem = await this.optional(entry.thermalSubsystem);
      result.thermalMetrics = await this.optional(linkOf(subsystem?.ThermalMetrics));
      for (const path of await this.members(linkOf(subsystem?.Fans))) {
        const fan = await this.optional(path);
        if (fan) {
          result.fans.push(fan);
        }
      }
    }
    if (power && entry.powerSubsystem) {
      const subsystem = await this.optional(entry.powerSubsystem);
      for (const path of await this.members(linkOf(subsystem?.PowerSupplies))) {
        const supply = await this.optional(path);
        if (supply) {
          result.powerSupplies.push(supply);
        }
      }
    }
    if (power && entry.environment) {
      result.environment = await this.optional(entry.environment);
    }
    return result;
  }

  /**
   * The entries of a log service: the first page, and the last one when the
   * log is longer (the newest entries are first on some controllers, last on
   * others). Null when the log cannot be read: never taken for an empty log.
   */
  async readLog(entriesPath) {
    const page = await this.optional(entriesPath);
    if (!page) {
      return null;
    }
    const entries = Array.isArray(page.Members) ? [...page.Members] : [];
    const count = Number(page['Members@odata.count']);
    if (page['@odata.nextLink'] && Number.isInteger(count) && count > entries.length) {
      const separator = entriesPath.includes('?') ? '&' : '?';
      const tail = await this.optional(
        `${entriesPath}${separator}$skip=${Math.max(0, count - entries.length)}`,
      );
      // No tail ($skip not supported): the first page only.
      if (Array.isArray(tail?.Members)) {
        entries.push(...tail.Members);
      }
    }
    return entries.filter((entry) => entry && typeof entry === 'object');
  }

  // --- Actions -----------------------------------------------------------------

  /**
   * The reset types the system accepts, from the action or its ActionInfo.
   * @returns {Promise<{ target: string|null, allowed: string[]|null }>}
   */
  async resetInfo(systemPath) {
    const system = await this.get(systemPath);
    const action = system.Actions?.['#ComputerSystem.Reset'];
    if (!action) {
      return { target: null, allowed: null, system };
    }
    let allowed = Array.isArray(action['ResetType@Redfish.AllowableValues'])
      ? action['ResetType@Redfish.AllowableValues']
      : null;
    if (!allowed && typeof action['@Redfish.ActionInfo'] === 'string') {
      const info = await this.optional(action['@Redfish.ActionInfo']).catch(() => null);
      const parameter = info?.Parameters?.find?.((p) => p?.Name === 'ResetType');
      allowed = Array.isArray(parameter?.AllowableValues) ? parameter.AllowableValues : null;
    }
    return { target: typeof action.target === 'string' ? action.target : null, allowed, system };
  }

  /** POST ComputerSystem.Reset with this reset type. */
  async reset(target, resetType) {
    const response = await this.authorized(target, {
      method: 'POST',
      body: { ResetType: resetType },
    });
    if (response.status < 200 || response.status >= 300) {
      let detail = '';
      try {
        const message = JSON.parse(response.body)?.error?.['@Message.ExtendedInfo']?.[0]?.Message;
        detail = typeof message === 'string' ? `: ${message.slice(0, 120)}` : '';
      } catch {
        // No JSON error body.
      }
      throw new RedfishError(
        ERROR_KINDS.HTTP,
        `Reset ${resetType} refused (HTTP ${response.status})${detail}`,
        response.status,
      );
    }
  }
}
