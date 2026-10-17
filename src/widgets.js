// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `servers`.
//
// The use case: a glance at the wall tablet tells whether the servers of the
// rack are on and healthy. Without a server chosen, one row per server (on or
// off, health, power draw), the problems in colour. With one chosen, its
// power draw and temperatures as tiles, its state rows, and the power buttons
// when "Allow power control" is ticked (each asks for a confirmation).
//
// The figures are sent as values, not bound to device features: the widget
// works before any device is added.
//
// Budget (8 components, 2 texts): a heading, three tiles, one status list of
// eight rows at most, Refresh, and two power buttons at most.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { COMMANDS, WIDGET_KEY } from './hub.js';
import {
  COMMAND_TEXT,
  ERROR_TEXT,
  HEALTH_TEXT,
  POWER_TEXT,
  formatFans,
  formatNumber,
  formatWatts,
  labelled,
  pick,
} from './texts.js';

// Action keys of the buttons: permanent once published.
export const ACTIONS = Object.freeze({
  REFRESH: 'refresh',
  POWER_ON: 'power_on',
  SHUTDOWN: 'shutdown',
  RESTART: 'restart',
});

const BUTTON_COMMANDS = {
  [ACTIONS.POWER_ON]: COMMANDS.ON,
  [ACTIONS.SHUTDOWN]: COMMANDS.SHUTDOWN,
  [ACTIONS.RESTART]: COMMANDS.RESTART,
};

export const MAX_ROWS = 8;

export const TEXT = {
  noBmc: {
    en: 'Add a management controller in the configuration of the integration.',
    fr: "Ajoutez un contrôleur de gestion dans la configuration de l'intégration.",
    de: 'Füge in der Konfiguration der Integration einen Management-Controller hinzu.',
    es: 'Añada un controlador de gestión en la configuración de la integración.',
  },
  gone: {
    en: 'This server is no longer in the configuration of the integration.',
    fr: "Ce serveur n'est plus dans la configuration de l'intégration.",
    de: 'Dieser Server ist nicht mehr in der Konfiguration der Integration.',
    es: 'Este servidor ya no está en la configuración de la integración.',
  },
  waiting: {
    en: 'Waiting for the first answer of the controller…',
    fr: 'En attente de la première réponse du contrôleur…',
    de: 'Warte auf die erste Antwort des Controllers …',
    es: 'Esperando la primera respuesta del controlador…',
  },
  title: { en: 'Servers', fr: 'Serveurs', de: 'Server', es: 'Servidores' },
  power: { en: 'Power', fr: 'Alimentation', de: 'Strom', es: 'Alimentación' },
  health: { en: 'Health', fr: 'Santé', de: 'Zustand', es: 'Estado' },
  draw: { en: 'Power draw', fr: 'Consommation', de: 'Leistung', es: 'Consumo' },
  intake: { en: 'Intake', fr: 'Entrée', de: 'Zuluft', es: 'Entrada' },
  cpu: { en: 'Processor', fr: 'Processeur', de: 'Prozessor', es: 'Procesador' },
  fans: { en: 'Fans', fr: 'Ventilateurs', de: 'Lüfter', es: 'Ventiladores' },
  supplies: {
    en: 'Power supplies',
    fr: 'Alimentations',
    de: 'Netzteile',
    es: 'Fuentes',
  },
  failing: { en: 'failing', fr: 'en défaut', de: 'gestört', es: 'con fallo' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  powerOn: { en: 'Power on', fr: 'Allumer', de: 'Einschalten', es: 'Encender' },
  shutdown: { en: 'Shut down', fr: 'Éteindre', de: 'Herunterfahren', es: 'Apagar' },
  restart: { en: 'Restart', fr: 'Redémarrer', de: 'Neu starten', es: 'Reiniciar' },
  refreshed: {
    en: 'Controllers read again.',
    fr: 'Contrôleurs relus.',
    de: 'Controller neu gelesen.',
    es: 'Controladores leídos de nuevo.',
  },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const HEALTH_COLOR = {
  OK: WIDGET_COLORS.SUCCESS,
  Warning: WIDGET_COLORS.WARNING,
  Critical: WIDGET_COLORS.DANGER,
};
const temperatureColor = (celsius, warning, danger) =>
  celsius >= danger
    ? WIDGET_COLORS.DANGER
    : celsius >= warning
      ? WIDGET_COLORS.WARNING
      : WIDGET_COLORS.NEUTRAL;

function message(text, language, ttl = 300) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

const refreshButton = (language) => ({
  type: 'button',
  label: t(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

const powerButton = (key, label, icon, language) => ({
  type: 'button',
  label: t(label, language),
  icon,
  style: 'danger',
  action: { key, confirm: true },
});

/** One row per server: on or off, health and power draw. */
function overviewRows(hub, language) {
  const rows = [];
  for (const { record, system } of hub.servers()) {
    const view = hub.view(record, system);
    if (!view.online) {
      rows.push({
        label: fit(view.name, 40),
        value: fit(view.error ? t(ERROR_TEXT[view.error.kind], language) : '…', 40),
        icon: 'alert-triangle',
        color: view.error ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
      });
      continue;
    }
    const parts = [];
    if (system.on !== null) {
      parts.push(t(system.on ? POWER_TEXT.on : POWER_TEXT.off, language));
    }
    if (system.health) {
      parts.push(t(HEALTH_TEXT[system.health], language));
    }
    if (system.watts !== null && system.on) {
      parts.push(formatWatts(system.watts, language));
    }
    rows.push({
      label: fit(view.name, 40),
      value: fit(parts.join(' · ') || '…', 40),
      icon: system.on === false ? 'power' : 'server',
      color:
        system.health && system.health !== 'OK'
          ? HEALTH_COLOR[system.health]
          : system.on === false
            ? WIDGET_COLORS.NEUTRAL
            : WIDGET_COLORS.SUCCESS,
    });
  }
  if (rows.length > MAX_ROWS) {
    const shown = rows.slice(0, MAX_ROWS - 1);
    shown.push({
      label: t(TEXT.more, language),
      value: `+${rows.length - shown.length}`,
      icon: 'more-horizontal',
      color: WIDGET_COLORS.NEUTRAL,
    });
    return shown;
  }
  return rows;
}

/** The tiles, rows and buttons of one server that answers. */
function serverComponents(view, language) {
  const { system } = view;
  const components = [];
  if (system.watts !== null) {
    components.push({
      type: 'value',
      value: Math.round(system.watts),
      unit: 'W',
      label: t(TEXT.draw, language),
      icon: 'zap',
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (system.intake !== null) {
    components.push({
      type: 'value',
      value: Math.round(system.intake),
      unit: '°C',
      label: t(TEXT.intake, language),
      icon: 'thermometer',
      color: temperatureColor(system.intake, 35, 40),
    });
  }
  if (system.cpu !== null) {
    components.push({
      type: 'value',
      value: Math.round(system.cpu),
      unit: '°C',
      label: t(TEXT.cpu, language),
      icon: 'cpu',
      color: temperatureColor(system.cpu, 80, 90),
    });
  }
  const rows = [];
  if (system.on !== null) {
    rows.push({
      label: t(TEXT.power, language),
      value: t(system.on ? POWER_TEXT.on : POWER_TEXT.off, language),
      icon: 'power',
      color: system.on ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (system.health) {
    rows.push({
      label: t(TEXT.health, language),
      value: t(HEALTH_TEXT[system.health], language),
      icon: system.health === 'OK' ? 'check-circle' : 'alert-triangle',
      color: HEALTH_COLOR[system.health],
    });
  }
  if (system.fans) {
    const speed = system.fans.speed === null ? '' : formatFans(system.fans, language);
    const failed = system.fans.failed ? `${system.fans.failed} ${t(TEXT.failing, language)}` : '';
    rows.push({
      label: t(TEXT.fans, language),
      value: fit([speed, failed].filter(Boolean).join(' · ') || '…', 40),
      icon: 'wind',
      color: system.fans.failed ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (system.supplies) {
    rows.push({
      label: t(TEXT.supplies, language),
      value: system.supplies.failed
        ? `${formatNumber(system.supplies.failed, language)} ${t(TEXT.failing, language)}`
        : `${formatNumber(system.supplies.count, language)} OK`,
      icon: 'battery-charging',
      color: system.supplies.failed ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    });
  }
  if (rows.length > 0) {
    components.push({ type: 'status', items: rows });
  }
  components.push(refreshButton(language));
  if (view.control && system.canReset) {
    if (system.on === false) {
      components.push(powerButton(ACTIONS.POWER_ON, TEXT.powerOn, 'power', language));
    } else if (system.on === true) {
      components.push(powerButton(ACTIONS.SHUTDOWN, TEXT.shutdown, 'power', language));
      components.push(powerButton(ACTIONS.RESTART, TEXT.restart, 'rotate-cw', language));
    }
  }
  return components;
}

async function get(hub, { settings, language = 'en' }) {
  if (hub.records.size === 0) {
    return message(TEXT.noBmc, language);
  }
  const chosen = typeof settings?.server === 'string' ? settings.server : '';
  if (!chosen) {
    const rows = overviewRows(hub, language);
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'heading', text: t(TEXT.title, language) },
        ...(rows.length ? [{ type: 'status', items: rows }] : []),
        refreshButton(language),
      ],
    };
  }
  const found = hub.find(chosen);
  if (!found) {
    return message(TEXT.gone, language);
  }
  const view = hub.view(found.record, found.system);
  if (!view.online) {
    if (!view.error) {
      return message(TEXT.waiting, language, 30);
    }
    return {
      ttl_seconds: 30,
      components: [
        { type: 'text', variant: 'heading', text: fit(view.name, 40) },
        {
          type: 'text',
          variant: 'body',
          text: labelled(view.name, t(ERROR_TEXT[view.error.kind], language), language),
        },
        refreshButton(language),
      ],
    };
  }
  return {
    ttl_seconds: 30,
    components: [
      { type: 'text', variant: 'heading', text: fit(view.name, 40) },
      ...serverComponents(view, language),
    ],
  };
}

async function action(hub, { actionKey, settings }) {
  const found = typeof settings?.server === 'string' ? hub.find(settings.server) : null;
  if (actionKey === ACTIONS.REFRESH) {
    if (found) {
      await hub.afterChanges(await hub.poll(found.record));
    } else {
      await hub.pollAll();
    }
    return { message: TEXT.refreshed };
  }
  const command = BUTTON_COMMANDS[actionKey];
  if (!command) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  if (!found?.system) {
    throw new Error(t(TEXT.gone, hub.config.language));
  }
  await hub.command(found.record, found.system, command);
  return { message: COMMAND_TEXT[command] };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
