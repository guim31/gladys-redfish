// -----------------------------------------------------------------------------
// The Gladys device of a server, proposed in the Discovery tab: one per
// computer system a controller manages (usually one per controller).
//
// Identity: the configuration slot of the controller and the Redfish `Id` of
// the system (`System.Embedded.1` on an iDRAC, `1` on an iLO, `system` on
// OpenBMC), stable across firmware updates and address changes.
//
// Features (only the ones the controller reports):
//   - power: switch/binary, read-only unless "Allow power control" is ticked.
//     Off sends a clean shutdown, never a forced one;
//   - health: text/text (OK, Warning, Critical), the rollup of the system;
//   - power draw (W), intake temperature, highest processor temperature;
//   - fans: their mean speed, in rpm or % as the controller reports it;
//   - failing power supplies: a counter, 0 when all is well.
//
// Published with should_poll: false: the integration reads the controllers
// on its own timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { HEALTH_TEXT, pick } from './texts.js';

export const DEVICE_TYPE = 'system';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  POWER: 'power',
  HEALTH: 'health',
  POWER_DRAW: 'power_draw',
  INTAKE: 'intake_temperature',
  CPU: 'cpu_temperature',
  FANS: 'fan_speed',
  FAILED_SUPPLIES: 'failed_power_supplies',
});

const K = FEATURE_KEYS;

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [K.POWER]: 'Power',
    [K.HEALTH]: 'Health',
    [K.POWER_DRAW]: 'Power draw',
    [K.INTAKE]: 'Intake temperature',
    [K.CPU]: 'Processor temperature',
    fan_rpm: 'Fans (rpm)',
    fan_percent: 'Fans (%)',
    [K.FAILED_SUPPLIES]: 'Failing power supplies',
  },
  fr: {
    [K.POWER]: 'Alimentation',
    [K.HEALTH]: 'Santé',
    [K.POWER_DRAW]: 'Consommation',
    [K.INTAKE]: "Température d'entrée",
    [K.CPU]: 'Température processeur',
    fan_rpm: 'Ventilateurs (tr/min)',
    fan_percent: 'Ventilateurs (%)',
    [K.FAILED_SUPPLIES]: 'Alimentations en défaut',
  },
  de: {
    [K.POWER]: 'Stromversorgung',
    [K.HEALTH]: 'Zustand',
    [K.POWER_DRAW]: 'Leistungsaufnahme',
    [K.INTAKE]: 'Zulufttemperatur',
    [K.CPU]: 'Prozessortemperatur',
    fan_rpm: 'Lüfter (U/min)',
    fan_percent: 'Lüfter (%)',
    [K.FAILED_SUPPLIES]: 'Gestörte Netzteile',
  },
  es: {
    [K.POWER]: 'Alimentación',
    [K.HEALTH]: 'Estado',
    [K.POWER_DRAW]: 'Consumo',
    [K.INTAKE]: 'Temperatura de entrada',
    [K.CPU]: 'Temperatura del procesador',
    fan_rpm: 'Ventiladores (rpm)',
    fan_percent: 'Ventiladores (%)',
    [K.FAILED_SUPPLIES]: 'Fuentes con fallo',
  },
};

export const DEFAULT_MODEL = 'Redfish';

// Display bounds (the core never applies them on write).
export const BOUNDS = Object.freeze({
  WATTS_MAX: 10000,
  TEMPERATURE: [-20, 130],
  RPM_MAX: 30000,
  SUPPLIES_MAX: 16,
});

/** A platform id part from a Redfish Id: as is when safe, hashed otherwise. */
export function itemKey(id) {
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(id) && !/^h[0-9a-f]{12}$/.test(id)) {
    return id;
  }
  return `h${createHash('sha1').update(id).digest('hex').slice(0, 12)}`;
}

/** External ids of the device of a system of a controller slot. */
export function deviceIds(gladys, slot, systemId) {
  return gladys.externalIds(DEVICE_TYPE, `${slot}-${itemKey(systemId)}`);
}

/**
 * The slot and system key of a device external id, null when not ours.
 * @returns {{ slot: number, key: string }|null}
 */
export function parseDeviceId(gladys, externalId) {
  if (typeof externalId !== 'string') {
    return null;
  }
  const prefix = gladys.externalIds(DEVICE_TYPE, '').device;
  if (!externalId.startsWith(prefix)) {
    return null;
  }
  const match = externalId.slice(prefix.length).match(/^(\d+)-([A-Za-z0-9_.-]{1,64})$/);
  return match ? { slot: Number(match[1]), key: match[2] } : null;
}

const round = (value, digits) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const temperature = (category) => ({
  definition: {
    category,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.CELSIUS,
    min: BOUNDS.TEMPERATURE[0],
    max: BOUNDS.TEMPERATURE[1],
  },
  digits: 0,
});

/**
 * The features of a server: when they exist, their shape, their value.
 * `s` is the parsed system (src/redfish/model.js), `ctx` { control, language }.
 * `noisy`: moves at every read, published at most once a minute (src/hub.js).
 */
const BLUEPRINT = [
  {
    key: K.POWER,
    definition: { category: CATEGORY.SWITCH, type: TYPE.SWITCH.BINARY, min: 0, max: 1 },
    command: true,
    digits: 0,
    when: (s) => s.on !== null,
    value: (s) => (s.on === null ? null : s.on ? 1 : 0),
  },
  {
    key: K.HEALTH,
    definition: { category: CATEGORY.TEXT, type: TYPE.TEXT.TEXT, min: 0, max: 0 },
    text: true,
    when: (s) => s.health !== null,
    value: (s, ctx) => (s.health === null ? null : pick(HEALTH_TEXT[s.health], ctx.language)),
  },
  {
    key: K.POWER_DRAW,
    definition: {
      category: CATEGORY.ENERGY_SENSOR,
      type: TYPE.ENERGY_SENSOR.POWER,
      unit: UNIT.WATT,
      min: 0,
      max: BOUNDS.WATTS_MAX,
    },
    digits: 0,
    noisy: true,
    when: (s) => s.watts !== null,
    value: (s) => s.watts,
  },
  {
    key: K.INTAKE,
    ...temperature(CATEGORY.TEMPERATURE_SENSOR),
    noisy: true,
    when: (s) => s.intake !== null,
    value: (s) => s.intake,
  },
  {
    key: K.CPU,
    ...temperature(CATEGORY.DEVICE_TEMPERATURE_SENSOR),
    noisy: true,
    when: (s) => s.cpu !== null,
    value: (s) => s.cpu,
  },
  {
    key: K.FANS,
    nameKey: (s) => (fanUnit(s) === 'percent' ? 'fan_percent' : 'fan_rpm'),
    definition: { category: CATEGORY.SPEED_SENSOR, type: TYPE.SPEED_SENSOR.INTEGER, min: 0 },
    shape: (s) =>
      fanUnit(s) === 'percent' ? { unit: UNIT.PERCENT, max: 100 } : { max: BOUNDS.RPM_MAX },
    digits: 0,
    noisy: true,
    when: (s) => s.fans !== null && s.fans.unit !== null,
    // A reading in another unit than the device's is not published.
    value: (s) => (s.fans?.unit === fanUnit(s) ? (s.fans?.speed ?? null) : null),
  },
  {
    key: K.FAILED_SUPPLIES,
    definition: {
      category: CATEGORY.COUNTER_SENSOR,
      type: TYPE.SENSOR.INTEGER,
      min: 0,
      max: BOUNDS.SUPPLIES_MAX,
    },
    digits: 0,
    when: (s) => s.supplies !== null,
    value: (s) => s.supplies?.failed ?? null,
  },
];

// Present when the server reports it now, or reported it once (src/alerts.js).
const present = (feature, system) =>
  !feature.when || feature.when(system) || Boolean(system.known?.keys.has(feature.key));

const fanUnit = (s) => s.known?.fanUnit ?? s.fans?.unit ?? null;

/** The feature keys a server reports now. */
export const featureKeys = (system) =>
  BLUEPRINT.filter((feature) => !feature.when || feature.when(system)).map(
    (feature) => feature.key,
  );

/**
 * The discovery payload of a server.
 * @param {object} gladys SDK client
 * @param {object} options
 * @param {number} options.slot controller slot
 * @param {object} options.system parsed system (src/redfish/model.js)
 * @param {string} options.name device name
 * @param {boolean} [options.control] power control allowed
 * @param {string} [options.language] feature names language
 */
export function buildDevice(gladys, { slot, system, name, control = false, language = 'en' }) {
  const ids = deviceIds(gladys, slot, system.id);
  const names = NAMES[language] ?? NAMES.en;
  const features = BLUEPRINT.filter((feature) => present(feature, system)).map((feature) => {
    const writable = Boolean(feature.command && control);
    return {
      name: names[feature.nameKey ? feature.nameKey(system) : feature.key],
      external_id: ids.feature(feature.key),
      ...feature.definition,
      ...(feature.shape ? feature.shape(system) : {}),
      read_only: !writable,
      has_feedback: writable,
      keep_history: !feature.text,
    };
  });
  const params = [
    ['Redfish Id', system.id],
    ['Serial number', system.serial],
    ['BIOS', system.bios],
  ]
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([paramName, value]) => ({ name: paramName, value: value.slice(0, 255) }));
  return {
    name: name.slice(0, 255),
    external_id: ids.device,
    model: (system.model ?? DEFAULT_MODEL).slice(0, 255),
    should_poll: false,
    params,
    features,
  };
}

/**
 * The value of every feature of a server (null: nothing to publish).
 * @returns {Array<{ key: string, externalId: string, value: number|string|null, text: boolean, noisy: boolean }>}
 */
export function featureValues(gladys, { slot, system, language = 'en' }) {
  const ids = deviceIds(gladys, slot, system.id);
  return BLUEPRINT.filter((feature) => present(feature, system)).map((feature) => {
    const raw = feature.value(system, { language });
    return {
      key: feature.key,
      externalId: ids.feature(feature.key),
      value: feature.text ? raw || null : round(raw, feature.digits),
      text: Boolean(feature.text),
      noisy: Boolean(feature.noisy),
    };
  });
}
