// -----------------------------------------------------------------------------
// From the raw Redfish resources of a system (src/redfish/client.js) to the
// few figures the integration shows: power state, health, power drawn,
// intake and processor temperatures, fans, power supplies, and the critical
// log entries.
//
// Vendors differ in the details, all handled here and frozen by the tests:
//   - the legacy Thermal/Power resources (iDRAC, iLO, XClarity, OpenBMC) or
//     the newer ThermalSubsystem/PowerSubsystem (recent firmware, DMTF);
//   - fans as `Reading` + `ReadingUnits`, or `CurrentReading` + `Units` and
//     `FanName` (iLO 4, Redfish 1.0 schema);
//   - an absent or disabled sensor, a reading of null: ignored, never 0.
// -----------------------------------------------------------------------------

const HEALTH_ORDER = { OK: 0, Warning: 1, Critical: 2 };

/** The health of a Status object: rollup first, the resource itself otherwise. */
export function healthOf(status) {
  const value = status?.HealthRollup ?? status?.Health;
  return value in HEALTH_ORDER ? value : null;
}

/** The worst of several healths, null when none is known. */
export function worstHealth(...values) {
  let worst = null;
  for (const value of values) {
    if (value in HEALTH_ORDER && (worst === null || HEALTH_ORDER[value] > HEALTH_ORDER[worst])) {
      worst = value;
    }
  }
  return worst;
}

export const healthRank = (health) => HEALTH_ORDER[health] ?? -1;

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// A sensor that is not there: Absent, Disabled, or UnavailableOffline.
const present = (item) => {
  const state = item?.Status?.State;
  return state === undefined || state === null || state === 'Enabled' || state === 'StandbyOffline';
};

const failing = (item) => {
  const health = item?.Status?.Health;
  return health === 'Warning' || health === 'Critical';
};

const INTAKE = /inlet|intake|ambient|ambiant/i;
const PROCESSOR = /\bcpu|proc/i;

/** Intake and processor temperatures from a legacy Thermal resource. */
function legacyTemperatures(thermal) {
  let intake = null;
  let cpu = null;
  for (const sensor of Array.isArray(thermal?.Temperatures) ? thermal.Temperatures : []) {
    const reading = number(sensor?.ReadingCelsius);
    if (!present(sensor) || reading === null) {
      continue;
    }
    const name = String(sensor.Name ?? '');
    const context = String(sensor.PhysicalContext ?? '');
    if (intake === null && (context === 'Intake' || INTAKE.test(name))) {
      intake = reading;
    } else if (context === 'CPU' || PROCESSOR.test(name)) {
      cpu = cpu === null ? reading : Math.max(cpu, reading);
    }
  }
  return { intake, cpu };
}

function subsystemTemperatures(metrics) {
  const summary = metrics?.TemperatureSummaryCelsius ?? {};
  const intake = number(summary.Intake?.Reading) ?? number(summary.Ambient?.Reading);
  let cpu = null;
  for (const entry of Array.isArray(metrics?.TemperatureReadingsCelsius)
    ? metrics.TemperatureReadingsCelsius
    : []) {
    const reading = number(entry?.Reading);
    const label = `${entry?.DeviceName ?? ''} ${entry?.DataSourceUri ?? ''}`;
    if (reading !== null && PROCESSOR.test(label)) {
      cpu = cpu === null ? reading : Math.max(cpu, reading);
    }
  }
  return { intake, cpu };
}

/**
 * The fans: their mean speed (in the unit most of them report), how many
 * there are and how many are failing.
 * @returns {{ speed: number|null, unit: 'rpm'|'percent'|null, count: number, failed: number }|null}
 */
function summarizeFans(readings) {
  if (readings.length === 0) {
    return null;
  }
  const byUnit = { rpm: [], percent: [] };
  for (const fan of readings) {
    if (fan.value !== null && fan.unit) {
      byUnit[fan.unit].push(fan.value);
    }
  }
  const unit =
    byUnit.rpm.length === 0 && byUnit.percent.length === 0
      ? null
      : byUnit.rpm.length >= byUnit.percent.length
        ? 'rpm'
        : 'percent';
  const values = unit ? byUnit[unit] : [];
  return {
    speed: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    unit,
    count: readings.length,
    failed: readings.filter((fan) => fan.failed).length,
  };
}

const unitOf = (text) => {
  const unit = String(text ?? '').toLowerCase();
  if (unit === 'rpm') {
    return 'rpm';
  }
  return unit === 'percent' || unit === '%' ? 'percent' : null;
};

function legacyFans(thermal) {
  const fans = Array.isArray(thermal?.Fans) ? thermal.Fans : [];
  return fans.filter(present).map((fan) => ({
    value: number(fan.Reading) ?? number(fan.CurrentReading),
    unit: unitOf(fan.ReadingUnits ?? fan.Units),
    failed: failing(fan),
  }));
}

function subsystemFans(fans) {
  return fans.filter(present).map((fan) => {
    const percent = number(fan.SpeedPercent?.Reading);
    const rpm = number(fan.SpeedPercent?.SpeedRPM);
    // The percent is the schema's reading; the RPM only an extra.
    return percent !== null
      ? { value: percent, unit: 'percent', failed: failing(fan) }
      : { value: rpm, unit: rpm === null ? null : 'rpm', failed: failing(fan) };
  });
}

function summarizeSupplies(supplies) {
  const list = supplies.filter(present);
  return list.length === 0
    ? null
    : { count: list.length, failed: list.filter((supply) => failing(supply)).length };
}

/** On, off, or null when the controller says nothing usable. */
export function isOn(powerState) {
  if (powerState === 'On' || powerState === 'PoweringOn' || powerState === 'Paused') {
    return true;
  }
  if (powerState === 'Off' || powerState === 'PoweringOff') {
    return false;
  }
  return null;
}

/**
 * The figures of one system.
 * @param {object} raw `{ entry, system, thermal, power, subsystem }` from the client
 */
export function parseSystem(raw) {
  const { entry, system, thermal, power, subsystem } = raw;
  const temperatures = thermal
    ? legacyTemperatures(thermal)
    : subsystemTemperatures(subsystem?.thermalMetrics);
  const fans = summarizeFans(thermal ? legacyFans(thermal) : subsystemFans(subsystem?.fans ?? []));
  const supplies = power
    ? summarizeSupplies(Array.isArray(power.PowerSupplies) ? power.PowerSupplies : [])
    : summarizeSupplies(subsystem?.powerSupplies ?? []);
  const watts = power
    ? number(
        (Array.isArray(power.PowerControl) ? power.PowerControl : [])
          .map((control) => control?.PowerConsumedWatts)
          .find((value) => number(value) !== null),
      )
    : number(subsystem?.environment?.PowerWatts?.Reading);
  const manufacturer = typeof system.Manufacturer === 'string' ? system.Manufacturer.trim() : '';
  const model = typeof system.Model === 'string' ? system.Model.trim() : '';

  return {
    id: entry.id,
    path: entry.path,
    name:
      [system.HostName, system.Name].find((value) => typeof value === 'string' && value.trim()) ??
      entry.id,
    hostName:
      typeof system.HostName === 'string' && system.HostName.trim() ? system.HostName : null,
    model: [manufacturer, model].filter(Boolean).join(' ') || null,
    serial: typeof system.SerialNumber === 'string' ? system.SerialNumber : null,
    bios: typeof system.BiosVersion === 'string' ? system.BiosVersion : null,
    powerState: typeof system.PowerState === 'string' ? system.PowerState : null,
    on: isOn(system.PowerState),
    health: worstHealth(
      healthOf(system.Status),
      healthOf(raw.chassis?.Status ?? entry.chassisHealth),
    ),
    watts,
    intake: temperatures.intake,
    cpu: temperatures.cpu,
    fans,
    supplies,
    canReset: Boolean(system.Actions?.['#ComputerSystem.Reset']),
  };
}

// The log services worth watching: the hardware event logs (iDRAC Sel, iLO
// IEL and IML, OpenBMC EventLog, Supermicro Log1, XClarity PlatformLog). Never the Lifecycle log of an iDRAC (every
// configuration change) nor dumps, journals and POST codes.
const EVENT_LOG = /^(sel|iel|iml|event|eventlog|platformlog|standardlog|log\d*)$/i;
const SKIPPED_LOG = /lclog|lifecycle|journal|audit|dump|crash|postcode|diag|fault/i;

/** The log services of a system to watch for critical entries. */
export function watchedLogServices(services) {
  const usable = services.filter(
    (service) => service.entries && !SKIPPED_LOG.test(`${service.id} ${service.name}`),
  );
  const events = usable.filter((service) => EVENT_LOG.test(service.id));
  return events.length > 0 ? events : usable;
}

/**
 * The critical entries of a log page, newest first, with a stable key.
 * @returns {Array<{ key: string, message: string, created: string|null }>}
 */
export function criticalEntries(entries) {
  return entries
    .filter((entry) => entry.Severity === 'Critical')
    .map((entry) => ({
      // With the date: a cleared SEL numbers its entries from 1 again.
      key: `${entry['@odata.id'] ?? entry.Id}|${entry.Created ?? ''}`,
      message: String(entry.Message ?? entry.Name ?? entry.MessageId ?? '').trim(),
      created: typeof entry.Created === 'string' ? entry.Created : null,
    }))
    .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
}
