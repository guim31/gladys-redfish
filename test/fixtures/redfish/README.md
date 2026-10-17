# Redfish fixtures

- `public-rackmount1.json`: resources of the DMTF `public-rackmount1` mockup, as served by the
  `dmtf/redfish-mockup-server` Docker image (Redfish 1.15, both the legacy Thermal/Power and the
  newer ThermalSubsystem/PowerSubsystem resources), one entry per resource path. Copyright DMTF,
  BSD 3-Clause licence (https://github.com/DMTF/Redfish-Mockup-Server).
- `ilo4-shaped.json`: **not a recording**. Written by hand after the HPE iLO 4 Redfish 1.0 schema
  (trailing slashes, `FanName`, `CurrentReading` with `Units`, no `GracefulShutdown` reset
  type, IEL and IML log services), with an invented serial number, to freeze the vendor
  differences the integration handles.
