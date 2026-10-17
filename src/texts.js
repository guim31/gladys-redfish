// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, health words, the "Test the connection" report,
// scene event variables, scene action outputs and errors. Four languages, the
// four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './redfish/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noBmc: {
    en: 'Enter the address of a management controller (iDRAC, iLO…) in the configuration.',
    fr: "Saisissez l'adresse d'un contrôleur de gestion (iDRAC, iLO…) dans la configuration.",
    de: 'Gib die Adresse eines Management-Controllers (iDRAC, iLO …) in der Konfiguration ein.',
    es: 'Introduzca la dirección de un controlador de gestión (iDRAC, iLO…) en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. 192.168.1.30 or https://idrac.lan',
    fr: 'Adresse incomprise, ex. 192.168.1.30 ou https://idrac.lan',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.30 oder https://idrac.lan',
    es: 'Dirección no válida, p. ej. 192.168.1.30 o https://idrac.lan',
  },
};

// One short explanation per error kind (src/redfish/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer',
    fr: 'ne répond pas',
    de: 'antwortet nicht',
    es: 'no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user name or password refused',
    fr: "nom d'utilisateur ou mot de passe refusé",
    de: 'Benutzername oder Passwort abgelehnt',
    es: 'nombre de usuario o contraseña rechazados',
  },
  [ERROR_KINDS.NOT_REDFISH]: {
    en: 'no Redfish service at this address',
    fr: 'aucun service Redfish à cette adresse',
    de: 'kein Redfish-Dienst unter dieser Adresse',
    es: 'no hay ningún servicio Redfish en esta dirección',
  },
  [ERROR_KINDS.NO_SYSTEM]: {
    en: 'the controller lists no server',
    fr: 'le contrôleur ne liste aucun serveur',
    de: 'der Controller listet keinen Server',
    es: 'el controlador no lista ningún servidor',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// Health words (Redfish Status.Health): the text feature, widget, scenes.
export const HEALTH_TEXT = {
  OK: { en: 'OK', fr: 'OK', de: 'OK', es: 'OK' },
  Warning: { en: 'Warning', fr: 'Avertissement', de: 'Warnung', es: 'Advertencia' },
  Critical: { en: 'Critical', fr: 'Critique', de: 'Kritisch', es: 'Crítico' },
};

export const POWER_TEXT = {
  on: { en: 'On', fr: 'Allumé', de: 'An', es: 'Encendido' },
  off: { en: 'Off', fr: 'Éteint', de: 'Aus', es: 'Apagado' },
};

// Errors of the commands (switch, widget buttons, scene action).
export const ACTION_TEXT = {
  noBmc: CONNECTION_TEXT.noBmc,
  unknownServer: {
    en: 'This server is not one of the integration (choose it again in the scene).',
    fr: "Ce serveur n'appartient pas à l'intégration (choisissez-le de nouveau dans la scène).",
    de: 'Dieser Server gehört nicht zur Integration (wähle ihn in der Szene erneut aus).',
    es: 'Este servidor no pertenece a la integración (elíjalo de nuevo en la escena).',
  },
  controlDisabled: {
    en: 'Power control is off: tick "Allow power control" in the configuration.',
    fr: "Le pilotage est désactivé : cochez « Autoriser le pilotage de l'alimentation » dans la configuration.",
    de: 'Die Steuerung ist aus: Aktiviere „Stromsteuerung erlauben“ in der Konfiguration.',
    es: 'El control está desactivado: marque «Permitir el control de la alimentación» en la configuración.',
  },
  notSupported: {
    en: 'This controller does not offer this command for this server.',
    fr: 'Ce contrôleur ne propose pas cette commande pour ce serveur.',
    de: 'Dieser Controller bietet diesen Befehl für diesen Server nicht an.',
    es: 'Este controlador no ofrece este comando para este servidor.',
  },
  failed: {
    en: 'The controller refused the command, see the integration logs.',
    fr: "Le contrôleur a refusé la commande, voir les logs de l'intégration.",
    de: 'Der Controller hat den Befehl abgelehnt, sieh in den Protokollen der Integration nach.',
    es: 'El controlador ha rechazado el comando, consulte los registros de la integración.',
  },
  unknownCommand: {
    en: 'Unknown command.',
    fr: 'Commande inconnue.',
    de: 'Unbekannter Befehl.',
    es: 'Comando desconocido.',
  },
};

// What a command sent, for the widget toast and the logs.
export const COMMAND_TEXT = {
  on: {
    en: 'Power on requested.',
    fr: 'Allumage demandé.',
    de: 'Einschalten angefordert.',
    es: 'Encendido solicitado.',
  },
  shutdown: {
    en: 'Clean shutdown requested.',
    fr: 'Arrêt propre demandé.',
    de: 'Sauberes Herunterfahren angefordert.',
    es: 'Apagado ordenado solicitado.',
  },
  restart: {
    en: 'Restart requested.',
    fr: 'Redémarrage demandé.',
    de: 'Neustart angefordert.',
    es: 'Reinicio solicitado.',
  },
  force_restart: {
    en: 'Forced restart requested.',
    fr: 'Redémarrage forcé demandé.',
    de: 'Erzwungener Neustart angefordert.',
    es: 'Reinicio forzado solicitado.',
  },
};

// The "Test the connection" report and the summary of a server.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    servers: (count) => `${count} server(s)`,
    session: 'session login',
    basic: 'Basic authentication',
    none: 'no authentication',
    control: (on) => (on ? 'power control allowed' : 'power control off'),
  },
  fr: {
    ok: 'OK',
    servers: (count) => `${count} serveur(s)`,
    session: 'connexion par session',
    basic: 'authentification Basic',
    none: 'sans authentification',
    control: (on) => (on ? 'pilotage autorisé' : 'pilotage désactivé'),
  },
  de: {
    ok: 'OK',
    servers: (count) => `${count} Server`,
    session: 'Anmeldung per Sitzung',
    basic: 'Basic-Authentifizierung',
    none: 'ohne Authentifizierung',
    control: (on) => (on ? 'Stromsteuerung erlaubt' : 'Stromsteuerung aus'),
  },
  es: {
    ok: 'OK',
    servers: (count) => `${count} servidor(es)`,
    session: 'inicio de sesión',
    basic: 'autenticación Basic',
    none: 'sin autenticación',
    control: (on) => (on ? 'control permitido' : 'control desactivado'),
  },
};

export const SUMMARY_TEXT = {
  en: {
    unreachable: 'controller unreachable',
    health: 'health',
    intake: 'intake',
    cpu: 'CPU',
    fans: 'fans',
    supplies: (count) => `${count} power supply(ies) failing`,
  },
  fr: {
    unreachable: 'contrôleur injoignable',
    health: 'santé',
    intake: 'entrée',
    cpu: 'processeur',
    fans: 'ventilateurs',
    supplies: (count) => `${count} alimentation(s) en défaut`,
  },
  de: {
    unreachable: 'Controller nicht erreichbar',
    health: 'Zustand',
    intake: 'Zuluft',
    cpu: 'Prozessor',
    fans: 'Lüfter',
    supplies: (count) => `${count} Netzteil(e) gestört`,
  },
  es: {
    unreachable: 'controlador inaccesible',
    health: 'estado',
    intake: 'entrada',
    cpu: 'procesador',
    fans: 'ventiladores',
    supplies: (count) => `${count} fuente(s) de alimentación con fallo`,
  },
};

export const UNIT_TEXT = {
  rpm: { en: 'rpm', fr: 'tr/min', de: 'U/min', es: 'rpm' },
};

/** The text of a multi-language object in a language, English otherwise. */
export const pick = (text, language) => (text ? (text[language] ?? text.en) : '');

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;

const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

export function formatNumber(value, language, digits = 0) {
  return new Intl.NumberFormat(LOCALES[language] ?? 'en-GB', {
    maximumFractionDigits: digits,
  }).format(value);
}

export const formatCelsius = (value, language) => `${formatNumber(value, language)} °C`;

export const formatWatts = (value, language) => `${formatNumber(value, language)} W`;

/** A fan speed in its unit. */
export function formatFans(fans, language) {
  return fans.unit === 'percent'
    ? `${formatNumber(fans.speed, language)} %`
    : `${formatNumber(fans.speed, language)} ${pick(UNIT_TEXT.rpm, language)}`;
}
