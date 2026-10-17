// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Up to three management controllers (iDRAC, iLO, XClarity, OpenBMC…), each
// in its own slot. The slot number is part of every device identity: a new
// address for the same controller keeps the devices and their history.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const SLOTS = [1, 2, 3];

// Refresh intervals offered in the configuration, in seconds. A controller is
// a small ARM chip shared with the fans and the console: no faster than 30 s.
export const POLL_INTERVALS = ['30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  bmc_1_url: '',
  bmc_1_username: '',
  bmc_1_password: '',
  bmc_1_name: '',
  bmc_2_url: '',
  bmc_2_username: '',
  bmc_2_password: '',
  bmc_2_name: '',
  bmc_3_url: '',
  bmc_3_username: '',
  bmc_3_password: '',
  bmc_3_name: '',
  poll_interval: '60',
  allow_self_signed: false,
  allow_power_control: false,
  language: 'fr',
};

export const MAX_NAME_LENGTH = 40;

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`192.0.2.10`, HTTPS assumed: every controller serves Redfish over HTTPS),
 * `host:port`, or the URL copied from the browser. Whatever follows the host
 * (`/redfish/v1`, `/restgui/start.html`…) is dropped: Redfish always lives
 * at `/redfish/v1` of the host.
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port]`, null when unusable
 */
export function parseBmcUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs and the messages.
  if (url.username || url.password) {
    return null;
  }
  return url.origin;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https?:\/\//, '');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const flag = (key) => source[key] === true || source[key] === 'true';
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };

  const bmcs = [];
  const invalid = [];
  for (const slot of SLOTS) {
    const typed = text(`bmc_${slot}_url`);
    if (!typed) {
      continue;
    }
    const url = parseBmcUrl(typed);
    if (!url) {
      invalid.push(slot);
      continue;
    }
    // A pasted password often carries a trailing new line; spaces inside are kept.
    const password =
      typeof source[`bmc_${slot}_password`] === 'string'
        ? source[`bmc_${slot}_password`].replace(/^[\r\n]+|[\r\n]+$/g, '')
        : '';
    bmcs.push({
      slot,
      url,
      username: text(`bmc_${slot}_username`),
      password,
      name: text(`bmc_${slot}_name`).slice(0, MAX_NAME_LENGTH) || null,
    });
  }

  return {
    bmcs,
    invalidSlots: invalid,
    allowSelfSigned: flag('allow_self_signed'),
    allowPowerControl: flag('allow_power_control'),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
