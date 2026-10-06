'use strict';
// Device catalog for Admin → Add device: pick a brand and model and the device gets its type, size,
// front in the rack, drive bays, a typical power draw and the right connection to read it live.
// Anything not listed can still be added by hand ("Any other device").
//
// Fields: brand, model, kind, height (U; 0 = not rack-mounted), front, drives, connection, watts
// connection: the type to add (null = drawn only); 'unifi-found' = appears by itself through the
// UniFi console; 'omada' = through the Omada controller.

const CATALOG = (() => {
  const rows = [
    ['Dell', 'PowerEdge R630', 'server', 1, 'dell13', '10x2.5', 'idrac', null],
    ['Dell', 'PowerEdge R730', 'server', 2, 'dell13', '8x3.5', 'idrac', null],
    ['Dell', 'PowerEdge R730xd', 'server', 2, 'dell13', '12x3.5', 'idrac', null],
    ['Dell', 'PowerEdge R640', 'server', 1, 'dell14', '10x2.5', 'idrac', null],
    ['Dell', 'PowerEdge R740', 'server', 2, 'dell14', '8x3.5', 'idrac', null],
    ['Dell', 'PowerEdge R740xd', 'server', 2, 'dell14', '24x2.5', 'idrac', null],
    ['Dell', 'PowerEdge R750', 'server', 2, 'dell14', '8x3.5', 'idrac', null],
    ['HPE', 'ProLiant DL360 Gen9', 'server', 1, 'hpe', '8x2.5', 'idrac', null],
    ['HPE', 'ProLiant DL380 Gen9', 'server', 2, 'hpe', '8x2.5', 'idrac', null],
    ['HPE', 'ProLiant DL360 Gen10', 'server', 1, 'hpe', '8x2.5', 'idrac', null],
    ['HPE', 'ProLiant DL380 Gen10', 'server', 2, 'hpe', '12x3.5', 'idrac', null],
    ['Lenovo', 'ThinkSystem SR630', 'server', 1, 'lenovo', '10x2.5', 'idrac', null],
    ['Lenovo', 'ThinkSystem SR650', 'server', 2, 'lenovo', '12x3.5', 'idrac', null],
    ['Supermicro', 'SYS-5019C-M', 'server', 1, 'supermicro', '4x3.5', 'idrac', 60],
    ['Supermicro', 'SYS-6029P-TR', 'server', 2, 'supermicro', '8x3.5', 'idrac', null],
    ['Proxmox', 'Any server running Proxmox VE', 'server', 2, 'server', '8x3.5', 'proxmox', null],
    ['Generic', 'Rack server', 'server', 2, 'server', '8x3.5', null, null],
    ['Generic', 'Rack switch', 'switch', 1, 'switch', null, 'snmp', 20],
    ['Generic', 'PDU', 'pdu', 1, 'plain', null, null, null],
  ];
  const KIND = { gateway: 'gateway', switch: 'switch', ap: 'ap', nvr: 'nas', nas: 'nas', server: 'server', camera: 'camera', ups: 'ups', pdu: 'pdu', other: 'other' };
  // UniFi: every model in models.js, drawn as it is built
  const drawn = (list, brand) => (typeof list === 'undefined' ? [] : list).map((m) => [brand || m.brand, m.name, KIND[m.type] || m.type || 'other', m.form === 'rack' ? m.h : 0, m.front, null, m.live, m.watts ?? null, m]);
  const unifi = drawn(typeof UNIFI_MODELS === 'undefined' ? undefined : UNIFI_MODELS, 'UniFi');
  const others = drawn(typeof OTHER_MODELS === 'undefined' ? undefined : OTHER_MODELS);
  const last = (brand) => (brand === 'Generic' ? 2 : brand === 'Proxmox' ? 1 : 0);
  // UniFi first, then the brands in alphabetical order with their rack servers among them
  const all = [...rows.map((r) => [...r, null]), ...others].sort((a, b) => last(a[0]) - last(b[0]) || a[0].localeCompare(b[0]) || (b[3] > 0) - (a[3] > 0));
  return [...unifi, ...all].map(([brand, model, kind, height, front, drives, connection, watts, unifiModel], i) => ({ id: i, brand, model, kind, height, front, drives, connection, watts, unifi: unifiModel }));
})();

// Types in the order they are offered after choosing a brand
const CATALOG_TYPES = [
  ['gateway', 'Gateways & routers'], ['switch', 'Switches'], ['ap', 'Access points'], ['server', 'Servers'], ['nas', 'NAS & recorders'],
  ['camera', 'Cameras'], ['ups', 'UPS'], ['pdu', 'Power'], ['other', 'Other'],
];

// What the owner has to set up on the device so it can be read (shown before adding)
const CATALOG_NEEDS = {
  idrac: 'A local user with a read-only role on the management controller (iDRAC, iLO, XClarity or BMC). Power, fans, temperatures and drives are read with Redfish.',
  unifi: 'A local UniFi OS user with the View Only role. Switches and access points behind it then appear by themselves.',
  'unifi-found': 'Appears by itself once its UniFi console is added; you only choose where it sits.',
  synology: 'SNMPv3 turned on in DSM (Control Panel → Terminal & SNMP), with SHA and AES.',
  snmp: 'A read-only SNMPv3 user (authentication and privacy). Ports, traffic, CPU, storage and UPS values are read with standard MIBs.',
  nut: 'NUT on the machine the UPS is plugged into, with upsd listening on the network. No password is needed.',
  omada: 'A Viewer account on the Omada controller; then pick this device from the controller’s list.',
  proxmox: 'A Proxmox API token with the PVEAuditor role, if it runs Proxmox. Otherwise add it without a connection.',
  truenas: 'An API key for a read-only user on TrueNAS.',
  null: 'Nothing: it is drawn in the rack and counted with its estimated power, without live data.',
  protect: 'Nothing for now: UniFi Protect isn’t read yet, so it is drawn and counted with its estimated power.',
};
