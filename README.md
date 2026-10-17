# Redfish (iDRAC, iLO) for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration that follows
rack and tower servers through their management controller (BMC) and the
standard [Redfish](https://www.dmtf.org/standards/redfish) API of the DMTF:
Dell iDRAC 8 and 9, HPE iLO 4 to 6, Lenovo XClarity Controller, Supermicro,
OpenBMC.

**Developed without the hardware: feedback welcome** in
[the issues](https://github.com/guim31/gladys-redfish/issues). It was tested
against the official DMTF Redfish mockup server, not yet on a real iDRAC or
iLO.

## Features

- **One device per server**: power (on/off), health (OK, Warning, Critical),
  power draw (W), intake temperature, hottest processor temperature, mean fan
  speed (rpm or %), failing power supplies. Only what the controller reports.
- **Power control, off by default**: once allowed, the power feature becomes
  a switch (on, **clean** shutdown — never a forced power off), and the
  widget and a scene action can restart the server.
- **Dashboard widget** "Servers (Redfish)": one line per server, or one
  server in detail with its power buttons (each confirmed).
- **Scene triggers**: server health degraded, new critical entry in the event
  log (SEL, IEL, IML, EventLog), server powered on, server powered off.
- **Scene actions**: state of a server (figures and a ready-made summary),
  power command (on, clean shutdown, restart, forced restart).
- Up to three controllers; session login (Basic when the controller has no
  sessions); self-signed certificates only when explicitly accepted.
- Four languages: English, French, German, Spanish.

## Requirements

- Gladys Assistant 5.1.0 or later.
- A controller with Redfish enabled, reachable in HTTPS from the Gladys
  machine, and an account on it (read-only is enough without power control).

## Installation

In Gladys: **Integrations → Install from GitHub**, then enter
`https://github.com/guim31/gladys-redfish`. Fill in the controller address,
user name and password in the **Configuration** tab, click **Test the
connection**, then add the server from the **Discover** tab.

The full documentation: [English](docs/en.md), [français](docs/fr.md),
[Deutsch](docs/de.md), [español](docs/es.md).

## How it works

The integration reads each controller on its own timer (30 s to 5 min,
1 min by default), following the `@odata.id` links from the service root:
the system, its chassis' legacy `Thermal` and `Power` resources (one request
each), or the newer `ThermalSubsystem` and `PowerSubsystem` when the legacy
ones are gone. The topology is kept an hour. The event logs are read every
5 minutes, the first page and its tail. Only the changes are sent to Gladys,
the moving values at most once a minute.

## Checked, and what was not

Checked against the `dmtf/redfish-mockup-server` Docker image
(`public-rackmount1` mockup), in a container locked like the Gladys sandbox:
session login and logout, the readings of both resource generations, the
event logs, the `ComputerSystem.Reset` action, the errors (wrong password,
certificate, wrong address). The vendor differences of the iLO 4 (Redfish 1.0
names, no `GracefulShutdown`) are frozen from its documented schema. Not yet
checked on a real iDRAC, iLO, XClarity or Supermicro.

## Limitations

- One chassis per server (the first linked to the system).
- A very long event log is read by its first and last pages only.
- IPMI-only controllers are not supported.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and an in-memory controller (`test/helpers/fakeRedfish.js`) serving the DMTF
mockup (`test/fixtures/redfish/`). See [`CLAUDE.md`](CLAUDE.md) for the
project rules.

## Credits

- [DMTF Redfish Mockup Server](https://github.com/DMTF/Redfish-Mockup-Server)
  and its `public-rackmount1` mockup (BSD 3-Clause): the test fixtures and
  the Docker image the integration was tested against.
- The architecture and the conformity tests follow
  [gladys-glances](https://github.com/guim31/gladys-glances) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Dell, HPE,
Lenovo, Supermicro or the DMTF. iDRAC, iLO, XClarity and Redfish are
trademarks of their owners.

## License

Apache-2.0
