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
    ['Cisco', 'Catalyst 2960X-24PS-L', 'switch', 1, 'switch', null, 'snmp', 40],
    ['Cisco', 'Catalyst 9200L-24P', 'switch', 1, 'switch', null, 'snmp', 50],
    ['Cisco', 'CBS350-24P', 'switch', 1, 'switch', null, 'snmp', 30],
    ['Cisco', 'Catalyst 1000-8P', 'switch', 0, 'plain', null, 'snmp', 12],
    ['Cisco', 'ISR 4331', 'gateway', 1, 'switch', null, 'snmp', 60],
    ['Dell', 'PowerEdge R630', 'server', 1, 'dell13', '10x2.5', 'idrac', null],
    ['Dell', 'PowerEdge R730', 'server', 2, 'dell13', '8x3.5', 'idrac', null],
    ['Dell', 'PowerEdge R730xd', 'server', 2, 'dell13', '12x3.5', 'idrac', null],
    ['Dell', 'PowerEdge R640', 'server', 1, 'dell14', '10x2.5', 'idrac', null],
    ['Dell', 'PowerEdge R740', 'server', 2, 'dell14', '8x3.5', 'idrac', null],
    ['Dell', 'PowerEdge R740xd', 'server', 2, 'dell14', '24x2.5', 'idrac', null],
    ['Dell', 'PowerEdge R750', 'server', 2, 'dell14', '8x3.5', 'idrac', null],
    ['Dell', 'PowerEdge T440', 'server', 0, 'plain', null, 'idrac', null],
    ['Dell', 'OptiPlex Micro', 'server', 0, 'plain', null, 'proxmox', 15],
    ['HPE', 'ProLiant DL360 Gen9', 'server', 1, 'hpe', '8x2.5', 'idrac', null],
    ['HPE', 'ProLiant DL380 Gen9', 'server', 2, 'hpe', '8x2.5', 'idrac', null],
    ['HPE', 'ProLiant DL360 Gen10', 'server', 1, 'hpe', '8x2.5', 'idrac', null],
    ['HPE', 'ProLiant DL380 Gen10', 'server', 2, 'hpe', '12x3.5', 'idrac', null],
    ['HPE', 'ProLiant ML350 Gen10', 'server', 0, 'plain', null, 'idrac', null],
    ['HPE', 'ProLiant MicroServer Gen10 Plus', 'server', 0, 'plain', null, 'idrac', 40],
    ['HPE', 'Aruba Instant On 1930 24G', 'switch', 1, 'switch', null, 'snmp', 25],
    ['Lenovo', 'ThinkSystem SR630', 'server', 1, 'lenovo', '10x2.5', 'idrac', null],
    ['Lenovo', 'ThinkSystem SR650', 'server', 2, 'lenovo', '12x3.5', 'idrac', null],
    ['Lenovo', 'ThinkCentre M920q', 'server', 0, 'plain', null, 'proxmox', 15],
    ['Supermicro', 'SYS-5019C-M', 'server', 1, 'supermicro', '4x3.5', 'idrac', 60],
    ['Supermicro', 'SYS-6029P-TR', 'server', 2, 'supermicro', '8x3.5', 'idrac', null],
    ['Synology', 'DS418', 'nas', 0, 'synology-ds', null, 'synology', 26],
    ['Synology', 'DS923+', 'nas', 0, 'synology-ds', null, 'synology', 35],
    ['Synology', 'DS1522+', 'nas', 0, 'synology-ds', null, 'synology', 40],
    ['Synology', 'RS822+', 'nas', 1, 'synology-rs', null, 'synology', 40],
    ['Synology', 'RS1221+', 'nas', 2, 'synology-rs', null, 'synology', 55],
    ['QNAP', 'TS-464', 'nas', 0, 'plain', null, 'snmp', 30],
    ['QNAP', 'TS-873A', 'nas', 0, 'plain', null, 'snmp', 50],
    ['QNAP', 'TS-432PXU', 'nas', 1, 'server', '4x3.5', 'snmp', 40],
    ['TrueNAS', 'Mini X+', 'nas', 0, 'plain', null, 'truenas', 45],
    ['MikroTik', 'CCR2004-16G-2S+', 'gateway', 1, 'switch', null, 'snmp', 20],
    ['MikroTik', 'CRS326-24G-2S+RM', 'switch', 1, 'switch', null, 'snmp', 15],
    ['MikroTik', 'hAP ax³', 'gateway', 0, 'plain', null, 'snmp', 10],
    ['TP-Link Omada', 'ER605', 'gateway', 0, 'plain', null, 'omada', 8],
    ['TP-Link Omada', 'TL-SG3428', 'switch', 1, 'switch', null, 'omada', 20],
    ['TP-Link Omada', 'TL-SG3428XMP', 'switch', 1, 'switch', null, 'omada', 30],
    ['TP-Link Omada', 'EAP650', 'ap', 0, 'plain', null, 'omada', null],
    ['Netgear', 'GS308EP', 'switch', 0, 'plain', null, null, 6],
    ['Netgear', 'GS724T', 'switch', 1, 'switch', null, 'snmp', 20],
    ['APC', 'Smart-UPS SMT1500RMI2U', 'ups', 2, 'plain', null, 'snmp', 25],
    ['APC', 'Back-UPS Pro 1500', 'ups', 0, 'plain', null, 'nut', 10],
    ['Eaton', '5P 1550 Rack', 'ups', 1, 'plain', null, 'snmp', 20],
    ['Eaton', '5E 1100i', 'ups', 0, 'plain', null, 'nut', 8],
    ['Raspberry Pi', 'Raspberry Pi 5', 'other', 0, 'plain', null, null, 6],
    ['Intel', 'NUC 13 Pro', 'server', 0, 'plain', null, 'proxmox', 20],
    ['Minisforum', 'MS-01', 'server', 0, 'plain', null, 'proxmox', 30],
    ['Proxmox', 'Any server running Proxmox VE', 'server', 2, 'server', '8x3.5', 'proxmox', null],
    ['Generic', 'Rack server', 'server', 2, 'server', '8x3.5', null, null],
    ['Generic', 'Rack switch', 'switch', 1, 'switch', null, 'snmp', 20],
    ['Generic', 'PDU', 'pdu', 1, 'plain', null, null, null],
  ];
  const KIND = { gateway: 'gateway', switch: 'switch', ap: 'ap', nvr: 'nas', camera: 'camera', ups: 'ups', pdu: 'pdu', other: 'other' };
  // UniFi: every model in models.js, drawn as it is built
  const unifi = (typeof UNIFI_MODELS === 'undefined' ? [] : UNIFI_MODELS).map((m) => ['UniFi', m.name, KIND[m.type] || 'other', m.form === 'rack' ? m.h : 0, m.front, null, m.live, m.watts ?? null, m]);
  return [...unifi, ...rows].map(([brand, model, kind, height, front, drives, connection, watts, unifiModel = null], i) => ({ id: i, brand, model, kind, height, front, drives, connection, watts, unifi: unifiModel }));
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
