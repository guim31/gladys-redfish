// -----------------------------------------------------------------------------
// The Redfish hub: one record per configured controller, read on a timer of
// the container (the interval chosen in the configuration); the states of the
// servers the user added published to Gladys when they change, the scene
// events fired on transitions (src/alerts.js), the power commands, and the
// views the widget and the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events fire for every server, added to Gladys or not.
//
// The 300 states per minute of Gladys: only the devices added are published,
// only what changed, the values that move at every read at most once a
// minute. Every value is sent again after 6 hours unchanged, before the core
// marks it outdated (48 hours).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { Watcher } from './alerts.js';
import {
  FEATURE_KEYS,
  buildDevice,
  deviceIds,
  featureKeys,
  featureValues,
  itemKey,
  parseDeviceId,
} from './devices.js';
import { ERROR_KINDS, RedfishClient } from './redfish/client.js';
import { criticalEntries, isOn, parseSystem, watchedLogServices } from './redfish/model.js';
import { hostOf } from './config.js';
import { createIssueLog } from './logs.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  HEALTH_TEXT,
  REPORT_TEXT,
  labelled,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'redfish-hub' });

export const WIDGET_KEY = 'servers';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  HEALTH: 'health_degraded',
  LOG: 'critical_log_entry',
  ON: 'server_powered_on',
  OFF: 'server_powered_off',
});

// Power commands (scene action options, widget buttons): permanent once published.
export const COMMANDS = Object.freeze({
  ON: 'on',
  SHUTDOWN: 'shutdown',
  RESTART: 'restart',
  FORCE_RESTART: 'force_restart',
});

export const HUB_TIMINGS = {
  // A controller that fails once is read again this soon, to tell a blip from an outage.
  retryMs: 20_000,
  // The event logs are read this often (they can be long).
  logEveryMs: 5 * 60_000,
  // The values that move at every read (watts, temperatures, fans): at most this often.
  noisyEveryMs: 60_000,
  // An unchanged value is sent again after this long.
  heartbeatMs: 6 * 3600_000,
  // A scene action reads the controller again when the last read is older.
  freshMs: 15_000,
  // After a power command, the server is read again this soon.
  afterCommandMs: 15_000,
};

// Critical log entries announced per server and per read, at most.
export const MAX_LOG_EVENTS = 3;

const MAX_STATES_PER_REQUEST = 100;

const signature = (bmc, config) =>
  JSON.stringify([bmc.url, bmc.username, bmc.password, config.allowSelfSigned]);

export class RedfishHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/redfish/http.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    /** @type {Map<number, object>} controller records, by slot */
    this.records = new Map();
    this.watcher = new Watcher();
    /** Last value published per feature external id, and when. */
    this.published = new Map();
    this.publishedAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.pollTimer = null;
    this.stopped = false;
    this.issues = createIssueLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.watcher = new Watcher(await this.store.load());
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.publishedAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const structureChanged =
      this.config?.language !== config.language ||
      this.config?.allowPowerControl !== config.allowPowerControl;
    this.config = config;
    const wanted = new Map(config.bmcs.map((bmc) => [bmc.slot, bmc]));
    let forgotten = false;
    for (const [slot, record] of this.records) {
      const bmc = wanted.get(slot);
      if (!bmc || record.signature !== signature(bmc, config)) {
        this.dropRecord(record);
        this.records.delete(slot);
        // Another address may be another server: what was announced for the
        // old one must not fire for the new one (recorded again, silently).
        if (bmc && bmc.url !== record.bmc.url) {
          forgotten = this.watcher.forgetSlot(slot) || forgotten;
        }
      }
    }
    const kept = new Set([...wanted.keys(), ...config.invalidSlots]);
    if (this.watcher.forgetSlots(kept) || forgotten) {
      this.store.save(this.watcher.saved);
    }
    for (const bmc of config.bmcs) {
      const record = this.records.get(bmc.slot);
      if (record) {
        record.bmc = bmc; // a new name only
      } else {
        this.records.set(bmc.slot, this.newRecord(bmc, config));
      }
    }
    if (structureChanged) {
      this.discovered = null;
      // The health text follows the language.
      this.published.clear();
    }
    await this.pollAll({ publish: true });
    this.schedulePoll();
  }

  newRecord(bmc, config) {
    return {
      bmc,
      signature: signature(bmc, config),
      client: new RedfishClient({
        url: bmc.url,
        username: bmc.username,
        password: bmc.password,
        insecure: config.allowSelfSigned,
        request: this.request,
        now: this.now,
      }),
      /** @type {Array<object>} parsed systems (src/redfish/model.js) */
      systems: [],
      /** @type {Array<object>} topology entries, for the logs */
      entries: [],
      readAt: 0,
      logReadAt: 0,
      error: null,
      failures: 0,
      polling: null,
      retryTimer: null,
      commandTimer: null,
      dropped: false,
    };
  }

  dropRecord(record) {
    record.dropped = true;
    clearTimeout(record.retryTimer);
    clearTimeout(record.commandTimer);
    record.client.logout({ close: true }).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    for (const record of this.records.values()) {
      clearTimeout(record.retryTimer);
      clearTimeout(record.commandTimer);
    }
    await Promise.all(
      [...this.records.values()].map((record) => record.client.logout({ close: true })),
    );
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || this.records.size === 0) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.issues.ok('poll', 'Polling works again');
      } catch (err) {
        this.issues.fail('poll', 'error', 'Poll failed', err);
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Names and identities ------------------------------------------------------

  /** The name of a server: configured, its host name, its model, or the address. */
  serverName(record, system) {
    const base = record.bmc.name ?? system.hostName ?? system.model ?? hostOf(record.bmc.url);
    return record.systems.length > 1 ? `${base} ${system.id}` : base;
  }

  /** A controller in the logs. */
  label(record) {
    return `Controller ${record.bmc.slot} (${record.bmc.name ?? hostOf(record.bmc.url)})`;
  }

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  systemKey(slot, system) {
    return `${slot}-${itemKey(system.id)}`;
  }

  deviceId(slot, system) {
    return deviceIds(this.gladys, slot, system.id).device;
  }

  /** The devices of a slot the user added, with their system key. */
  createdDevices(slot) {
    const devices = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device.external_id);
      if (parsed?.slot === slot) {
        devices.push({ device, key: parsed.key });
      }
    }
    return devices;
  }

  // --- Devices -----------------------------------------------------------------

  discoveredDevices() {
    const devices = [];
    for (const record of [...this.records.values()].sort((a, b) => a.bmc.slot - b.bmc.slot)) {
      for (const system of record.systems) {
        devices.push(
          buildDevice(this.gladys, {
            slot: record.bmc.slot,
            system,
            name: this.serverName(record, system),
            control: this.config.allowPowerControl,
            language: this.config.language,
          }),
        );
      }
    }
    return devices;
  }

  /** Publish the Discovery list when it changed. */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.issues.ok('discovery', 'Discovered devices accepted again');
    } catch (err) {
      this.issues.fail('discovery', 'warn', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read the topology again, publish the list. */
  async rediscover() {
    for (const record of this.records.values()) {
      record.client.forgetTopology();
    }
    await this.pollAll();
    await this.publishDevices({ force: true });
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    const found = this.find(device.external_id);
    if (!found) {
      return;
    }
    this.transports.delete(device.external_id);
    await this.publishRecordStates(found.record, { force: true, only: device.external_id });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** The user deleted a device: forget what was sent for it. */
  onDeviceDeleted(device) {
    const id = device?.external_id;
    if (typeof id !== 'string') {
      return;
    }
    this.transports.delete(id);
    for (const map of [this.published, this.publishedAt]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${id}:`)) {
          map.delete(key);
        }
      }
    }
  }

  // --- Reading the controllers ---------------------------------------------------

  async pollAll({ publish = false } = {}) {
    const records = [...this.records.values()];
    const changes = await Promise.all(records.map((record) => this.poll(record)));
    await this.afterChanges(changes.some(Boolean), { publish });
  }

  /** Gladys asks for a refresh (onPoll): read that controller now. */
  async pollDevice(device) {
    const found = this.find(device.external_id);
    if (found) {
      await this.afterChanges(await this.poll(found.record));
    }
  }

  /** Read again the controllers whose last read is older than `freshMs`. */
  async refreshIfStale(records = [...this.records.values()]) {
    const stale = records.filter((record) => this.now() - record.readAt >= this.timings.freshMs);
    if (stale.length > 0) {
      const changes = await Promise.all(stale.map((record) => this.poll(record)));
      await this.afterChanges(changes.some(Boolean));
    }
  }

  /**
   * Read one controller and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget should be refreshed now
   */
  poll(record) {
    record.polling ??= this.read(record).finally(() => {
      record.polling = null;
    });
    return record.polling;
  }

  async read(record) {
    let raw;
    try {
      raw = await record.client.read();
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      return this.applyFailure(record, err);
    }
    const changed = await this.applySuccess(record, raw);
    if (!record.dropped && this.now() - record.logReadAt >= this.timings.logEveryMs) {
      await this.readLogs(record);
    }
    return changed;
  }

  async applySuccess(record, raw) {
    if (record.dropped) {
      return false;
    }
    const { slot } = record.bmc;
    const systems = raw.map(parseSystem);
    let widgetChanged = record.error !== null || record.readAt === 0;
    if (record.error) {
      logger.info(`${this.label(record)} answers again`);
    } else if (record.readAt === 0) {
      logger.info(
        `${this.label(record)}: ${systems.length} server(s), ${record.client.auth} authentication`,
      );
    }
    const saved = JSON.stringify(this.watcher.saved);
    const before = new Map(record.systems.map((system) => [system.id, system]));
    record.systems = systems;
    record.entries = raw.map((item) => item.entry);
    record.failures = 0;
    record.error = null;
    record.readAt = this.now();

    for (const system of systems) {
      const previous = before.get(system.id);
      if (
        previous &&
        (previous.on !== system.on ||
          previous.health !== system.health ||
          previous.supplies?.failed !== system.supplies?.failed)
      ) {
        widgetChanged = true;
      }
      const name = this.serverName(record, system);
      const server = this.deviceId(slot, system);
      const seen = this.watcher.observe(this.systemKey(slot, system), system);
      // A feature once seen stays: a server off reports no processor
      // temperature, and its device must not change at every power cycle.
      system.known = this.watcher.rememberFeatures(
        this.systemKey(slot, system),
        featureKeys(system),
        system.fans?.unit ?? null,
      );
      if (seen.degraded) {
        logger.debug(`${name}: health ${seen.previousHealth} → ${system.health}`);
        await this.fireEvent(TRIGGERS.HEALTH, {
          server,
          server_name: name,
          health: pick(HEALTH_TEXT[system.health], this.config.language),
        });
      }
      if (seen.poweredOn || seen.poweredOff) {
        logger.debug(`${name}: ${system.powerState}`);
        await this.fireEvent(seen.poweredOn ? TRIGGERS.ON : TRIGGERS.OFF, {
          server,
          server_name: name,
        });
      }
    }
    this.saveIfChanged(saved);
    await this.publishRecordStates(record);
    return widgetChanged;
  }

  /** The critical entries of the event logs, announced once each. */
  async readLogs(record) {
    record.logReadAt = this.now();
    const { slot } = record.bmc;
    const saved = JSON.stringify(this.watcher.saved);
    // A log of the controller shared by several systems is read once.
    const done = new Set();
    for (const entry of record.entries) {
      const system = record.systems.find((item) => item.id === entry.id);
      if (!system) {
        continue;
      }
      for (const service of watchedLogServices(entry.logServices)) {
        if (done.has(service.path)) {
          continue;
        }
        done.add(service.path);
        let entries;
        try {
          entries = await record.client.readLog(service.entries);
          this.issues.ok(`log:${slot}:${service.path}`, `${service.path} readable again`);
        } catch (err) {
          this.issues.fail(
            `log:${slot}:${service.path}`,
            'warn',
            `${this.label(record)}: cannot read ${service.path}: ${err.message}`,
          );
          continue;
        }
        if (entries === null) {
          // Not readable this time: neither recorded as empty nor announced.
          continue;
        }
        const fresh = this.watcher.newEntries(
          this.systemKey(slot, system),
          service.path,
          criticalEntries(entries),
        );
        // The oldest first, the way they happened.
        for (const item of fresh.slice(0, MAX_LOG_EVENTS).reverse()) {
          logger.debug(`${this.serverName(record, system)}: critical log entry ${item.key}`);
          await this.fireEvent(TRIGGERS.LOG, {
            server: this.deviceId(slot, system),
            server_name: this.serverName(record, system),
            message: item.message.slice(0, 500) || '?',
            created: item.created ?? '',
          });
        }
      }
    }
    this.saveIfChanged(saved);
  }

  /** Write /data only when the watcher changed (an SD card wears). */
  saveIfChanged(before) {
    if (JSON.stringify(this.watcher.saved) !== before) {
      this.store.save(this.watcher.saved);
    }
  }

  async applyFailure(record, err) {
    if (record.dropped) {
      return false;
    }
    const wasError = record.error?.kind;
    record.error = { kind: err.kind, message: err.message };
    record.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`${this.label(record)}: ${err.message}`);
    } else {
      logger.debug(`${this.label(record)}: ${err.message}`);
    }
    if (err.kind === ERROR_KINDS.AUTH && err.status === 401) {
      // A changed password: close the session (controllers allow few), log in again next time.
      await record.client.logout();
    }
    if (err.kind === ERROR_KINDS.UNREACHABLE) {
      record.failures += 1;
      if (record.failures === 1) {
        this.scheduleRetry(record);
      }
    } else {
      record.failures = 0;
    }
    return wasError !== err.kind;
  }

  scheduleRetry(record) {
    clearTimeout(record.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    record.retryTimer = setTimeout(() => {
      this.poll(record)
        .then((changed) => this.afterChanges(changed))
        .then(() => this.issues.ok('retry', 'Retry works again'))
        .catch((err) => this.issues.fail('retry', 'error', 'Retry failed', err));
    }, this.timings.retryMs);
    record.retryTimer.unref?.();
  }

  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.issues.ok('scene', 'Scene events accepted again');
    } catch (err) {
      this.issues.fail('scene', 'warn', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Power commands ----------------------------------------------------------

  /**
   * Send a power command to a server: on, clean shutdown, restart, forced
   * restart. Never a forced power off. Throws a message in the configured
   * language when it cannot be sent.
   * @returns {Promise<string|null>} the Redfish reset type sent, null when nothing was needed
   */
  async command(record, system, command) {
    const language = this.config.language;
    if (!this.config.allowPowerControl) {
      throw new Error(pick(ACTION_TEXT.controlDisabled, language));
    }
    if (!Object.values(COMMANDS).includes(command)) {
      throw new Error(pick(ACTION_TEXT.unknownCommand, language));
    }
    let info;
    try {
      info = await record.client.resetInfo(system.path);
    } catch (err) {
      logger.warn(`${this.serverName(record, system)}: ${err.message}`);
      throw new Error(pick(ERROR_TEXT[err.kind] ?? ACTION_TEXT.failed, language), { cause: err });
    }
    const on = isOn(info.system?.PowerState);
    const type = chooseResetType(command, info.allowed, on);
    if (type === null) {
      // Already in the asked state: nothing to send.
      return null;
    }
    if (!info.target || type === undefined) {
      throw new Error(pick(ACTION_TEXT.notSupported, language));
    }
    try {
      await record.client.reset(info.target, type);
    } catch (err) {
      logger.warn(`${this.serverName(record, system)}: ${err.message}`);
      throw new Error(pick(ACTION_TEXT.failed, language), { cause: err });
    }
    logger.info(`${this.serverName(record, system)}: ${type} sent`);
    this.scheduleAfterCommand(record);
    return type;
  }

  scheduleAfterCommand(record) {
    clearTimeout(record.commandTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    record.commandTimer = setTimeout(() => {
      this.poll(record)
        .then((changed) => this.afterChanges(changed))
        .catch((err) => logger.debug(`Read after a command failed: ${err.message}`));
    }, this.timings.afterCommandMs);
    record.commandTimer.unref?.();
  }

  /** The power switch of a device (onSetValue): 1 on, 0 clean shutdown. */
  async setValue(device, feature, value) {
    const found = this.find(device?.external_id);
    if (!found?.system) {
      throw new Error(pick(ACTION_TEXT.unknownServer, this.config?.language));
    }
    if (!feature?.external_id?.endsWith(`:${FEATURE_KEYS.POWER}`)) {
      throw new Error(pick(ACTION_TEXT.unknownCommand, this.config.language));
    }
    await this.command(
      found.record,
      found.system,
      Number(value) === 1 ? COMMANDS.ON : COMMANDS.SHUTDOWN,
    );
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /**
   * The states of the servers of a controller the user added.
   * @param {object} record
   * @param {object} [options]
   * @param {boolean} [options.force] send even unchanged values (a device just added)
   * @param {string} [options.only] the external id of the one device to send
   */
  async publishRecordStates(record, { force = false, only = null } = {}) {
    if (record.error) {
      return; // the transport badge says it
    }
    const { slot } = record.bmc;
    const values = [];
    for (const { device, key } of this.createdDevices(slot)) {
      if (only && device.external_id !== only) {
        continue;
      }
      const system = record.systems.find((item) => itemKey(item.id) === key);
      if (system) {
        values.push(
          ...featureValues(this.gladys, { slot, system, language: this.config.language }),
        );
      }
    }
    await this.sendStates(values, { force });
  }

  /** Keep what must be sent now: changed, and not too soon for the noisy values. */
  async sendStates(values, { force = false } = {}) {
    const now = this.now();
    const due = [];
    for (const { externalId, value, text, noisy } of values) {
      if (value === null) {
        continue;
      }
      const last = this.published.get(externalId);
      const at = this.publishedAt.get(externalId);
      if (!force) {
        if (last === value && at !== undefined && now - at < this.timings.heartbeatMs) {
          continue;
        }
        if (last !== value && noisy && at !== undefined && now - at < this.timings.noisyEveryMs) {
          continue;
        }
      }
      due.push({ externalId, value, text });
    }
    for (let at = 0; at < due.length; at += MAX_STATES_PER_REQUEST) {
      const batch = due.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(
          batch.map(({ externalId, value, text }) =>
            text
              ? { device_feature_external_id: externalId, text: value }
              : { device_feature_external_id: externalId, state: value },
          ),
        );
        for (const { externalId, value } of batch) {
          this.published.set(externalId, value);
          this.publishedAt.set(externalId, now);
        }
        this.issues.ok('states', 'States accepted again');
      } catch (err) {
        this.issues.fail('states', 'warn', `States refused: ${err.message}`);
      }
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: "local", or "unreachable" with their controller. */
  async publishTransports() {
    const entries = [];
    for (const record of this.records.values()) {
      if (record.readAt === 0) {
        continue;
      }
      const transport =
        record.error === null ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      for (const { device } of this.createdDevices(record.bmc.slot)) {
        if (this.transports.get(device.external_id) !== transport) {
          entries.push({ external_id: device.external_id, transport });
        }
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      for (const entry of entries) {
        this.transports.set(entry.external_id, entry.transport);
      }
      this.issues.ok('transports', 'Transports accepted again');
    } catch (err) {
      this.issues.fail('transports', 'warn', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name: connected when every controller answers. */
  connectionStatus() {
    if (!this.config) {
      return { connected: false, message: CONNECTION_TEXT.noBmc };
    }
    const { bmcs, invalidSlots } = this.config;
    if (bmcs.length === 0) {
      return {
        connected: false,
        message: invalidSlots.length ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.noBmc,
      };
    }
    const failing = [...this.records.values()].filter((record) => record.error);
    if (failing.length === 0 && invalidSlots.length === 0) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noBmc)) {
      const parts = failing.map((record) =>
        labelled(
          record.bmc.name ?? hostOf(record.bmc.url),
          pick(ERROR_TEXT[record.error.kind], language),
          language,
        ),
      );
      if (invalidSlots.length) {
        parts.push(pick(CONNECTION_TEXT.invalidUrl, language));
      }
      message[language] = parts.join(' · ').slice(0, 200);
    }
    // Connected while one controller of several still answers.
    return { connected: failing.length < this.records.size, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.issues.ok('connection', 'Connection status accepted again');
    } catch (err) {
      this.issues.fail('connection', 'warn', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene actions, report) --------------------------------------------

  /**
   * The controller and server of a device external id.
   * @returns {{ record: object, key: string, system: object|null }|null}
   */
  find(externalId) {
    const parsed = parseDeviceId(this.gladys, externalId);
    const record = parsed ? this.records.get(parsed.slot) : null;
    if (!record) {
      return null;
    }
    const system = record.systems.find((item) => itemKey(item.id) === parsed.key) ?? null;
    return { record, key: parsed.key, system };
  }

  /** Every server known, in slot order, with its controller. */
  servers() {
    const list = [];
    for (const record of [...this.records.values()].sort((a, b) => a.bmc.slot - b.bmc.slot)) {
      if (record.systems.length === 0) {
        list.push({ record, system: null });
      }
      for (const system of record.systems) {
        list.push({ record, system });
      }
    }
    return list;
  }

  /** What the widget and the scene actions show of a server. */
  view(record, system) {
    return {
      name: system ? this.serverName(record, system) : (record.bmc.name ?? hostOf(record.bmc.url)),
      online: record.error === null && system !== null && record.readAt > 0,
      error: record.error,
      system,
      control: this.config.allowPowerControl,
    };
  }

  /** "Test the connection": read every controller now, one line each. */
  async testConnection() {
    for (const record of this.records.values()) {
      record.client.forgetTopology();
    }
    await this.pollAll({ publish: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (this.records.size === 0) {
        message[language] = pick(this.connectionStatus().message, language);
        continue;
      }
      const lines = [...this.records.values()].map((record) => {
        const name = record.bmc.name ?? hostOf(record.bmc.url);
        if (record.error) {
          return labelled(name, pick(ERROR_TEXT[record.error.kind], language), language);
        }
        const servers = record.systems.map((system) => this.serverName(record, system));
        return labelled(
          name,
          [
            text.ok,
            `${text.servers(servers.length)} (${servers.join(', ')})`,
            text[record.client.auth] ?? text.none,
            text.control(this.config.allowPowerControl),
          ].join(', '),
          language,
        );
      });
      if (this.config?.invalidSlots.length) {
        lines.push(pick(CONNECTION_TEXT.invalidUrl, language));
      }
      message[language] = lines.join('\n').slice(0, 1000);
    }
    return message;
  }

  /** Throws the reason no controller can answer a scene action, if any. */
  assertReadable() {
    if (this.records.size === 0) {
      throw new Error(pick(ACTION_TEXT.noBmc, this.config?.language));
    }
  }
}

/**
 * The Redfish reset type for a command, given what the controller allows
 * (null: not advertised, the standard value is tried) and the power state.
 * @returns {string|null|undefined} the type; null: nothing to do; undefined: not offered
 */
export function chooseResetType(command, allowed, on) {
  const offers = (type) => Array.isArray(allowed) && allowed.includes(type);
  const can = (type) => !Array.isArray(allowed) || allowed.includes(type);
  switch (command) {
    case COMMANDS.ON:
      if (on === true) {
        return null;
      }
      if (can('On')) {
        return 'On';
      }
      // A short press starts a server known to be off. The button toggles:
      // never pressed when the power state is unknown.
      return on === false && offers('PushPowerButton') ? 'PushPowerButton' : undefined;
    case COMMANDS.SHUTDOWN:
      if (on === false) {
        return null;
      }
      if (can('GracefulShutdown')) {
        return 'GracefulShutdown';
      }
      // A short press asks the operating system to shut down (ACPI), the way
      // iLO 4 does a clean shutdown, only when the server is known to be on.
      // Never ForceOff.
      return on === true && offers('PushPowerButton') ? 'PushPowerButton' : undefined;
    case COMMANDS.RESTART:
      return can('GracefulRestart') ? 'GracefulRestart' : undefined;
    case COMMANDS.FORCE_RESTART:
      return can('ForceRestart') ? 'ForceRestart' : undefined;
    default:
      return undefined;
  }
}
