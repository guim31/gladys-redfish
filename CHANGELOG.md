# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-17

### Added

- Servers followed through their management controller and the Redfish API
  (Dell iDRAC, HPE iLO, Lenovo XClarity, Supermicro, OpenBMC), up to three
  controllers: one device per server with power, health, power draw, intake
  and processor temperatures, fan speed and failing power supplies.
- Power control, off by default: on, clean shutdown (never a forced power
  off) and restart, from the power switch, the widget and a scene action.
- Dashboard widget "Servers (Redfish)": every server at a glance, or one in
  detail with its power buttons.
- Scene triggers: server health degraded, new critical log entry, server
  powered on, server powered off.
- Scene actions: state of a server, power command.
- "Test the connection" action, English, French, German and Spanish texts and
  documentation.
- Apache-2.0 `LICENSE` file.

[Unreleased]: https://github.com/guim31/gladys-redfish/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-redfish/releases/tag/v1.0.0
