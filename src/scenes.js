// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "State of a server" is what a condition on the device features cannot do:
// put the state of a server in a message ("web483: on, health OK, 344 W,
// intake 25 °C…"), with every figure as an output too, for a server the user
// did not add. It reads the controller again when the last read is older
// than 15 seconds. An unreachable controller is an answer, not a failure:
// `online` false, and the summary says so.
//
// "Power command" sends on, clean shutdown, restart or forced restart, only
// when "Allow power control" is ticked. Never a forced power off.
// -----------------------------------------------------------------------------

import { COMMANDS } from './hub.js';
import {
  ACTION_TEXT,
  ERROR_TEXT,
  HEALTH_TEXT,
  POWER_TEXT,
  SUMMARY_TEXT,
  formatCelsius,
  formatFans,
  formatWatts,
  labelled,
  pick,
} from './texts.js';

/** The one-line state of a server, in the configured language. */
export function summarize(view, language) {
  const text = SUMMARY_TEXT[language] ?? SUMMARY_TEXT.en;
  if (!view.online) {
    const reason = view.error ? pick(ERROR_TEXT[view.error.kind], language) : text.unreachable;
    return labelled(view.name, reason, language);
  }
  const { system } = view;
  const parts = [];
  if (system.on !== null) {
    parts.push(pick(system.on ? POWER_TEXT.on : POWER_TEXT.off, language).toLowerCase());
  }
  if (system.health) {
    parts.push(`${text.health} ${pick(HEALTH_TEXT[system.health], language)}`);
  }
  if (system.watts !== null) {
    parts.push(formatWatts(system.watts, language));
  }
  if (system.intake !== null) {
    parts.push(`${text.intake} ${formatCelsius(system.intake, language)}`);
  }
  if (system.cpu !== null) {
    parts.push(`${text.cpu} ${formatCelsius(system.cpu, language)}`);
  }
  if (system.fans?.speed !== null && system.fans?.speed !== undefined) {
    parts.push(`${text.fans} ${formatFans(system.fans, language)}`);
  }
  if (system.supplies?.failed) {
    parts.push(text.supplies(system.supplies.failed));
  }
  return labelled(view.name, parts.join(', '), language);
}

/** The server of a scene field, read again when stale. */
async function serverOf(hub, fields) {
  hub.assertReadable();
  const language = hub.config.language;
  const found = hub.find(fields.server);
  if (!found) {
    throw new Error(pick(ACTION_TEXT.unknownServer, language));
  }
  await hub.refreshIfStale([found.record]);
  // Read again: the controller may have been reconfigured meanwhile.
  return hub.find(fields.server) ?? found;
}

export const SCENE_ACTIONS = {
  async get_server_status(hub, { fields = {} }) {
    const language = hub.config?.language;
    const found = await serverOf(hub, fields);
    const view = hub.view(found.record, found.system);
    const outputs = { name: view.name, online: view.online, summary: summarize(view, language) };
    if (!view.online) {
      return outputs;
    }
    const { system } = view;
    const set = (key, value) => {
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        outputs[key] = Math.round(value);
      }
    };
    if (system.on !== null) {
      outputs.power_on = system.on;
    }
    if (system.health) {
      outputs.health = pick(HEALTH_TEXT[system.health], language);
    }
    set('power_watts', system.watts);
    set('intake_temperature', system.intake);
    set('cpu_temperature', system.cpu);
    set('fan_speed', system.fans?.speed);
    set('failed_power_supplies', system.supplies?.failed);
    return outputs;
  },

  async power_command(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!Object.values(COMMANDS).includes(fields.command)) {
      throw new Error(pick(ACTION_TEXT.unknownCommand, language));
    }
    const found = await serverOf(hub, fields);
    if (!found.system) {
      const reason = found.record.error ? ERROR_TEXT[found.record.error.kind] : null;
      throw new Error(pick(reason ?? ACTION_TEXT.unknownServer, language));
    }
    const type = await hub.command(found.record, found.system, fields.command);
    return { reset_type: type ?? '' };
  },
};
