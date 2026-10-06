'use strict';
// UniFi models, as they are built: used by the rack (to draw each front or shape) and by the
// catalog in Admin. Front ids start with "u-"; two older ids (udm-pro, usw-24-poe) keep their
// own hand-made drawing.
//
// form: rack (U high) | desktop | ceiling | wall | inwall | outdoor | mesh | camera
// shape (not rack-mounted): the outline drawn outside the rack and in the catalog
// face (rack-mounted): screen touch|lcm|null, rj (LAN jacks), wan (extra jacks on the right),
//   poe, sfp (cages), bays (3.5" drive bays), outlets (PDU), ups (a UPS front)
// codes: the model codes a UniFi console reports for it (when known); live: how it is read

const UNIFI_MODELS = (() => {
  const G = 'gateway';
  const SW = 'switch';
  const AP = 'ap';
  const list = [
    // --- Gateways ---
    { id: 'udm-pro', name: 'Dream Machine Pro', type: G, form: 'rack', h: 1, front: 'udm-pro', screen: 'touch', rj: 8, wan: 1, sfp: 2, bays: 1, watts: 25, codes: ['UDMPRO'], live: 'unifi' },
    { id: 'udm-se', name: 'Dream Machine SE', type: G, form: 'rack', h: 1, screen: 'touch', rj: 8, poe: true, wan: 1, sfp: 2, bays: 1, watts: 35, codes: ['UDMPROSE'], live: 'unifi' },
    { id: 'udm-pro-max', name: 'Dream Machine Pro Max', type: G, form: 'rack', h: 1, screen: 'touch', rj: 8, wan: 1, sfp: 2, bays: 2, watts: 35, codes: ['UDMPROMAX', 'UDMA6A8'], live: 'unifi' },
    { id: 'uxg-pro', name: 'Gateway Pro', type: G, form: 'rack', h: 1, screen: 'lcm', rj: 2, sfp: 2, watts: 20, codes: ['UXGPRO'], live: 'unifi-found' },
    { id: 'uxg-ent', name: 'Gateway Enterprise', type: G, form: 'rack', h: 1, screen: 'lcm', rj: 4, sfp: 4, watts: 40, codes: ['UXGENT', 'UXGA6AE'], live: 'unifi-found' },
    { id: 'efg', name: 'Enterprise Fortress Gateway', type: G, form: 'rack', h: 1, screen: 'touch', rj: 4, sfp: 6, watts: 60, codes: ['EFG', 'UDMENT'], live: 'unifi' },
    { id: 'udr', name: 'Dream Router', type: G, form: 'desktop', shape: 'cylinder', watts: 15, codes: ['UDR'], live: 'unifi' },
    { id: 'udr7', name: 'Dream Router 7', type: G, form: 'desktop', shape: 'cylinder', watts: 18, codes: ['UDR7'], live: 'unifi' },
    { id: 'ucg-ultra', name: 'Cloud Gateway Ultra', type: G, form: 'desktop', shape: 'gateway-small', watts: 8, codes: ['UCGULTRA', 'UDRULT', 'UCG'], live: 'unifi' },
    { id: 'ucg-max', name: 'Cloud Gateway Max', type: G, form: 'desktop', shape: 'gateway-max', watts: 12, codes: ['UCGMAX'], live: 'unifi' },
    { id: 'ucg-fiber', name: 'Cloud Gateway Fiber', type: G, form: 'desktop', shape: 'gateway-max', watts: 20, codes: ['UCGF', 'UCGFIBER'], live: 'unifi' },
    { id: 'ux', name: 'Express', type: G, form: 'desktop', shape: 'cube', watts: 7, codes: ['UX'], live: 'unifi' },
    { id: 'ux7', name: 'Express 7', type: G, form: 'desktop', shape: 'cube', watts: 9, codes: ['UX7'], live: 'unifi' },
    { id: 'udw', name: 'Dream Wall', type: G, form: 'wall', shape: 'dream-wall', watts: 40, codes: ['UDW'], live: 'unifi' },

    // --- Switches in the rack ---
    { id: 'usw-24-poe', name: 'Switch 24 PoE', type: SW, form: 'rack', h: 1, front: 'usw-24-poe', screen: 'lcm', rj: 24, poe: true, sfp: 2, watts: 20, codes: ['USL24P', 'US24P', 'US24P250'], live: 'unifi-found' },
    { id: 'usw-24', name: 'Switch 24', type: SW, form: 'rack', h: 1, screen: 'lcm', rj: 24, sfp: 2, watts: 15, codes: ['USL24', 'US24'], live: 'unifi-found' },
    { id: 'usw-48-poe', name: 'Switch 48 PoE', type: SW, form: 'rack', h: 1, screen: 'lcm', rj: 48, poe: true, sfp: 4, watts: 35, codes: ['USL48P', 'US48P500'], live: 'unifi-found' },
    { id: 'usw-48', name: 'Switch 48', type: SW, form: 'rack', h: 1, screen: 'lcm', rj: 48, sfp: 4, watts: 25, codes: ['USL48', 'US48'], live: 'unifi-found' },
    { id: 'usw-16-poe', name: 'Switch 16 PoE', type: SW, form: 'rack', h: 1, screen: 'lcm', rj: 16, poe: true, sfp: 2, watts: 15, codes: ['USL16P', 'US16P150'], live: 'unifi-found' },
    { id: 'usw-pro-24', name: 'Switch Pro 24', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, sfp: 2, watts: 20, codes: ['US24PRO2'], live: 'unifi-found' },
    { id: 'usw-pro-24-poe', name: 'Switch Pro 24 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, poe: true, sfp: 2, watts: 30, codes: ['US24PRO'], live: 'unifi-found' },
    { id: 'usw-pro-48', name: 'Switch Pro 48', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 48, sfp: 4, watts: 35, codes: ['US48PRO2'], live: 'unifi-found' },
    { id: 'usw-pro-48-poe', name: 'Switch Pro 48 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 48, poe: true, sfp: 4, watts: 45, codes: ['US48PRO'], live: 'unifi-found' },
    { id: 'usw-pro-max-16', name: 'Switch Pro Max 16', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 16, sfp: 2, watts: 15, codes: ['USPM16'], live: 'unifi-found' },
    { id: 'usw-pro-max-16-poe', name: 'Switch Pro Max 16 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 16, poe: true, sfp: 2, watts: 20, codes: ['USPM16P'], live: 'unifi-found' },
    { id: 'usw-pro-max-24', name: 'Switch Pro Max 24', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, sfp: 2, watts: 20, codes: ['USPM24'], live: 'unifi-found' },
    { id: 'usw-pro-max-24-poe', name: 'Switch Pro Max 24 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, poe: true, sfp: 2, watts: 30, codes: ['USPM24P'], live: 'unifi-found' },
    { id: 'usw-pro-max-48', name: 'Switch Pro Max 48', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 48, sfp: 4, watts: 35, codes: ['USPM48'], live: 'unifi-found' },
    { id: 'usw-pro-max-48-poe', name: 'Switch Pro Max 48 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 48, poe: true, sfp: 4, watts: 50, codes: ['USPM48P'], live: 'unifi-found' },
    { id: 'usw-pro-hd-24', name: 'Switch Pro HD 24', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, sfp: 4, watts: 40, codes: ['USPRH24'], live: 'unifi-found' },
    { id: 'usw-pro-hd-24-poe', name: 'Switch Pro HD 24 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, poe: true, sfp: 4, watts: 55, codes: ['USPRH24P'], live: 'unifi-found' },
    { id: 'usw-pro-xg-24', name: 'Switch Pro XG 24', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 24, sfp: 2, watts: 45, codes: ['USPXG24'], live: 'unifi-found' },
    { id: 'usw-pro-xg-48-poe', name: 'Switch Pro XG 48 PoE', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 48, poe: true, sfp: 4, watts: 80, codes: ['USPXG48P'], live: 'unifi-found' },
    { id: 'usw-ent-24-poe', name: 'Switch Enterprise 24 PoE', type: SW, form: 'rack', h: 1, screen: 'lcm', rj: 24, poe: true, sfp: 2, watts: 35, codes: ['US24ENT', 'USWED76'], live: 'unifi-found' },
    { id: 'usw-ent-48-poe', name: 'Switch Enterprise 48 PoE', type: SW, form: 'rack', h: 1, screen: 'lcm', rj: 48, poe: true, sfp: 4, watts: 55, codes: ['US48ENT', 'USWED77'], live: 'unifi-found' },
    { id: 'usw-aggregation', name: 'Switch Aggregation', type: SW, form: 'rack', h: 1, screen: null, rj: 0, sfp: 8, watts: 15, codes: ['USAGG', 'USL8A'], live: 'unifi-found' },
    { id: 'usw-pro-aggregation', name: 'Switch Pro Aggregation', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 0, sfp: 32, watts: 60, codes: ['USAGGPRO'], live: 'unifi-found' },
    { id: 'usw-ecs-aggregation', name: 'ECS Aggregation', type: SW, form: 'rack', h: 1, screen: 'touch', rj: 0, sfp: 48, watts: 120, codes: ['ECSAGG'], live: 'unifi-found' },

    // --- Switches on the desk ---
    { id: 'usw-lite-8-poe', name: 'Switch Lite 8 PoE', type: SW, form: 'desktop', shape: 'switch-desk', ports: 8, watts: 6, codes: ['USL8LP', 'USL8LPB'], live: 'unifi-found' },
    { id: 'usw-lite-16-poe', name: 'Switch Lite 16 PoE', type: SW, form: 'desktop', shape: 'switch-desk', ports: 16, watts: 10, codes: ['USL16LP', 'USL16LPB'], live: 'unifi-found' },
    { id: 'usw-ultra', name: 'Switch Ultra', type: SW, form: 'desktop', shape: 'switch-small', ports: 8, watts: 5, codes: ['USM8P', 'USM8P60', 'USM8P210'], live: 'unifi-found' },
    { id: 'usw-ent-8-poe', name: 'Switch Enterprise 8 PoE', type: SW, form: 'desktop', shape: 'switch-desk', ports: 10, watts: 15, codes: ['US68P', 'USWED35'], live: 'unifi-found' },
    { id: 'usw-pro-xg-8-poe', name: 'Switch Pro XG 8 PoE', type: SW, form: 'desktop', shape: 'switch-desk', ports: 10, watts: 20, codes: ['USPXG8P'], live: 'unifi-found' },
    { id: 'usw-flex', name: 'Switch Flex', type: SW, form: 'desktop', shape: 'switch-small', ports: 5, watts: 5, codes: ['USF5P'], live: 'unifi-found' },
    { id: 'usw-flex-25g', name: 'Switch Flex 2.5G', type: SW, form: 'desktop', shape: 'switch-desk', ports: 8, watts: 8, codes: ['USWF8', 'USF8P'], live: 'unifi-found' },
    { id: 'usw-flex-mini', name: 'Switch Flex Mini', type: SW, form: 'desktop', shape: 'flex-mini', ports: 5, watts: 3, codes: ['USMINI'], live: 'unifi-found' },
    { id: 'usw-flex-mini-25g', name: 'Switch Flex Mini 2.5G', type: SW, form: 'desktop', shape: 'flex-mini', ports: 5, watts: 4, codes: ['USWED37', 'USMINI25'], live: 'unifi-found' },

    // --- Access points ---
    { id: 'u7-pro', name: 'U7 Pro', type: AP, form: 'ceiling', shape: 'ap-square', codes: ['U7PRO', 'UAPA6A4'], live: 'unifi-found' },
    { id: 'u7-pro-max', name: 'U7 Pro Max', type: AP, form: 'ceiling', shape: 'ap-square', codes: ['U7PROMAX', 'UAPA6A5'], live: 'unifi-found' },
    { id: 'u7-pro-xg', name: 'U7 Pro XG', type: AP, form: 'ceiling', shape: 'ap-square', codes: ['U7PROXG'], live: 'unifi-found' },
    { id: 'u7-pro-wall', name: 'U7 Pro Wall', type: AP, form: 'wall', shape: 'ap-wall', codes: ['U7PIW', 'U7PROWALL'], live: 'unifi-found' },
    { id: 'u7-lite', name: 'U7 Lite', type: AP, form: 'ceiling', shape: 'ap-round', codes: ['U7LITE'], live: 'unifi-found' },
    { id: 'u7-in-wall', name: 'U7 In-Wall', type: AP, form: 'inwall', shape: 'in-wall', codes: ['U7IW'], live: 'unifi-found' },
    { id: 'u7-outdoor', name: 'U7 Outdoor', type: AP, form: 'outdoor', shape: 'outdoor', codes: ['U7OUTDOOR', 'U7O'], live: 'unifi-found' },
    { id: 'e7', name: 'E7', type: AP, form: 'ceiling', shape: 'ap-square', codes: ['E7'], live: 'unifi-found' },
    { id: 'u6-plus', name: 'U6+', type: AP, form: 'ceiling', shape: 'ap-round', codes: ['UAPL6', 'U6PLUS'], live: 'unifi-found' },
    { id: 'u6-lite', name: 'U6 Lite', type: AP, form: 'ceiling', shape: 'ap-round', codes: ['UAL6'], live: 'unifi-found' },
    { id: 'u6-lr', name: 'U6 Long-Range', type: AP, form: 'ceiling', shape: 'ap-round', size: 1.2, codes: ['UALR6', 'UALR6v2', 'UALR6v3'], live: 'unifi-found' },
    { id: 'u6-pro', name: 'U6 Pro', type: AP, form: 'ceiling', shape: 'ap-square', codes: ['UAP6MP'], live: 'unifi-found' },
    { id: 'u6-enterprise', name: 'U6 Enterprise', type: AP, form: 'ceiling', shape: 'ap-square', codes: ['U6ENT'], live: 'unifi-found' },
    { id: 'u6-mesh', name: 'U6 Mesh', type: AP, form: 'mesh', shape: 'mesh', codes: ['U6M'], live: 'unifi-found' },
    { id: 'u6-in-wall', name: 'U6 In-Wall', type: AP, form: 'inwall', shape: 'in-wall', codes: ['U6IW'], live: 'unifi-found' },
    { id: 'uap-ac-pro', name: 'AC Pro', type: AP, form: 'ceiling', shape: 'ap-round', codes: ['U7PG2'], live: 'unifi-found' },
    { id: 'uap-ac-lite', name: 'AC Lite', type: AP, form: 'ceiling', shape: 'ap-round', codes: ['U7LT'], live: 'unifi-found' },
    { id: 'uap-ac-lr', name: 'AC Long-Range', type: AP, form: 'ceiling', shape: 'ap-round', size: 1.2, codes: ['U7LR'], live: 'unifi-found' },

    // --- Protect: recorders and cameras (drawn; their live data comes from Protect, not read yet) ---
    { id: 'unvr', name: 'UNVR', type: 'nvr', form: 'rack', h: 1, screen: 'lcm', bays: 4, rj: 1, sfp: 1, watts: 25, codes: ['UNVR'], live: 'unifi-found' },
    { id: 'unvr-pro', name: 'UNVR Pro', type: 'nvr', form: 'rack', h: 2, screen: 'touch', bays: 7, rj: 1, sfp: 1, watts: 45, codes: ['UNVRPRO'], live: 'unifi-found' },
    { id: 'envr', name: 'Enterprise NVR', type: 'nvr', form: 'rack', h: 2, screen: 'touch', bays: 16, rj: 1, sfp: 2, watts: 90, codes: ['ENVR'], live: 'unifi-found' },
    { id: 'unvr-instant', name: 'UNVR Instant', type: 'nvr', form: 'desktop', shape: 'gateway-max', watts: 15, codes: ['UNVRI'], live: 'unifi-found' },
    { id: 'g5-bullet', name: 'G5 Bullet', type: 'camera', form: 'camera', shape: 'cam-bullet', watts: 4, live: null },
    { id: 'g5-turret-ultra', name: 'G5 Turret Ultra', type: 'camera', form: 'camera', shape: 'cam-turret', watts: 4, live: null },
    { id: 'g5-dome', name: 'G5 Dome', type: 'camera', form: 'camera', shape: 'cam-dome', watts: 5, live: null },
    { id: 'g5-pro', name: 'G5 Pro', type: 'camera', form: 'camera', shape: 'cam-bullet', size: 1.25, watts: 8, live: null },
    { id: 'g5-flex', name: 'G5 Flex', type: 'camera', form: 'camera', shape: 'cam-flex', watts: 4, live: null },
    { id: 'g6-bullet', name: 'G6 Bullet', type: 'camera', form: 'camera', shape: 'cam-bullet', watts: 6, live: null },
    { id: 'g6-turret', name: 'G6 Turret', type: 'camera', form: 'camera', shape: 'cam-turret', watts: 6, live: null },
    { id: 'g4-instant', name: 'G4 Instant', type: 'camera', form: 'camera', shape: 'cam-flex', watts: 3, live: null },
    { id: 'g4-doorbell-pro', name: 'G4 Doorbell Pro', type: 'camera', form: 'camera', shape: 'doorbell', watts: 5, live: null },
    { id: 'ai-pro', name: 'AI Pro', type: 'camera', form: 'camera', shape: 'cam-bullet', size: 1.4, watts: 12, live: null },
    { id: 'ai-360', name: 'AI 360', type: 'camera', form: 'camera', shape: 'cam-dome', size: 1.2, watts: 10, live: null },

    // --- Power, Cloud Keys and the rest ---
    { id: 'ups-2u', name: 'UPS 2U', type: 'ups', form: 'rack', h: 2, screen: 'touch', ups: true, watts: 30, codes: ['UPS2U'], live: 'unifi-found' },
    { id: 'ups-tower', name: 'UPS Tower', type: 'ups', form: 'desktop', shape: 'ups-tower', watts: 20, codes: ['UPST'], live: 'unifi-found' },
    { id: 'usp-pdu-pro', name: 'Power Distribution Pro', type: 'pdu', form: 'rack', h: 1, screen: 'lcm', outlets: 16, watts: 8, codes: ['USPPDUP'], live: 'unifi-found' },
    { id: 'usp-pdu-hd', name: 'Power Distribution HD', type: 'pdu', form: 'rack', h: 2, screen: 'touch', outlets: 42, watts: 10, codes: ['USPPDUHD'], live: 'unifi-found' },
    { id: 'usp-rps', name: 'Redundant Power System', type: 'pdu', form: 'rack', h: 1, screen: null, outlets: 6, watts: 10, codes: ['USPRPS'], live: 'unifi-found' },
    { id: 'usp-plug', name: 'SmartPower Plug', type: 'pdu', form: 'desktop', shape: 'plug', watts: 1, codes: ['USPPLUG', 'UP1'], live: 'unifi-found' },
    { id: 'ck-g2-plus', name: 'Cloud Key Gen2 Plus', type: 'other', form: 'desktop', shape: 'cloud-key', watts: 10, codes: ['UCKP'], live: 'unifi' },
    { id: 'ck-enterprise', name: 'Cloud Key Enterprise', type: 'other', form: 'rack', h: 1, screen: 'touch', bays: 2, rj: 2, sfp: 2, watts: 60, codes: ['UCKENT'], live: 'unifi' },
    { id: 'access-hub', name: 'Access Hub', type: 'other', form: 'wall', shape: 'in-wall', watts: 5, live: null },
  ];
  for (const m of list) m.front ||= `u-${m.id}`;
  return list;
})();

const UNIFI_BY_ID = new Map(UNIFI_MODELS.map((m) => [m.id, m]));
const UNIFI_BY_FRONT = new Map(UNIFI_MODELS.map((m) => [m.front, m]));

// The model behind what a console reports: its model code, or else its name
function unifiModelFor(code, name) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c) for (const m of UNIFI_MODELS) if (m.codes?.some((x) => x.toUpperCase() === c)) return m;
  // Protect reports a market name ("G5 Bullet") instead of a code
  if (c) for (const m of UNIFI_MODELS) if (m.name.toUpperCase().replace(/[^A-Z0-9]/g, '') === c) return m;
  const n = String(name || '').toLowerCase().replace(/^(unifi|usw|uap)[\s-]*/, '').replace(/[^a-z0-9+]/g, '');
  if (!n) return null;
  return UNIFI_MODELS.find((m) => m.name.toLowerCase().replace(/[^a-z0-9+]/g, '') === n) || null;
}

// Other brands, drawn the same way. Front ids start with "m-".
// color: the chassis (silver, black, grey, light, cisco, netgear, mikrotik); bay: 3.5 or 2.5 trays
const OTHER_MODELS = (() => {
  const S = 'switch';
  const G = 'gateway';
  const list = [
    // Synology
    { brand: 'Synology', id: 'ds224-plus', name: 'DS224+', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 2, watts: 15, live: 'synology' },
    { brand: 'Synology', id: 'ds418', name: 'DS418', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 4, watts: 26, live: 'synology', rackFront: 'synology-ds' },
    { brand: 'Synology', id: 'ds423-plus', name: 'DS423+', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 4, watts: 28, live: 'synology', rackFront: 'synology-ds' },
    { brand: 'Synology', id: 'ds923-plus', name: 'DS923+', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 4, watts: 35, live: 'synology', rackFront: 'synology-ds' },
    { brand: 'Synology', id: 'ds1522-plus', name: 'DS1522+', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 5, watts: 40, live: 'synology' },
    { brand: 'Synology', id: 'ds1821-plus', name: 'DS1821+', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 8, watts: 60, live: 'synology' },
    { brand: 'Synology', id: 'rs422-plus', name: 'RS422+', type: 'nas', form: 'rack', h: 1, color: 'black', bays: 4, bay: '3.5', rj: 2, watts: 35, live: 'synology' },
    { brand: 'Synology', id: 'rs822-plus', name: 'RS822+', type: 'nas', form: 'rack', h: 1, color: 'black', bays: 4, bay: '3.5', rj: 4, watts: 40, live: 'synology' },
    { brand: 'Synology', id: 'rs1221-plus', name: 'RS1221+', type: 'nas', form: 'rack', h: 2, color: 'black', bays: 8, bay: '3.5', rj: 4, watts: 55, live: 'synology' },
    { brand: 'Synology', id: 'rs2423-plus', name: 'RS2423+', type: 'nas', form: 'rack', h: 2, color: 'black', bays: 12, bay: '3.5', rj: 2, watts: 80, live: 'synology' },
    // QNAP
    { brand: 'QNAP', id: 'ts-264', name: 'TS-264', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 2, watts: 18, live: 'snmp' },
    { brand: 'QNAP', id: 'ts-464', name: 'TS-464', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 4, watts: 30, live: 'snmp' },
    { brand: 'QNAP', id: 'ts-664', name: 'TS-664', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 6, watts: 40, live: 'snmp' },
    { brand: 'QNAP', id: 'ts-873a', name: 'TS-873A', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 8, watts: 50, live: 'snmp' },
    { brand: 'QNAP', id: 'ts-432pxu', name: 'TS-432PXU', type: 'nas', form: 'rack', h: 1, color: 'black', bays: 4, bay: '3.5', rj: 2, sfp: 2, watts: 40, live: 'snmp' },
    { brand: 'QNAP', id: 'ts-864eu', name: 'TS-864eU', type: 'nas', form: 'rack', h: 2, color: 'black', bays: 8, bay: '3.5', rj: 2, watts: 55, live: 'snmp' },
    { brand: 'QNAP', id: 'ts-h1277axu', name: 'TS-h1277AXU-RP', type: 'nas', form: 'rack', h: 2, color: 'black', bays: 12, bay: '3.5', rj: 2, sfp: 2, watts: 90, live: 'snmp' },
    // TrueNAS
    { brand: 'TrueNAS', id: 'mini-x-plus', name: 'Mini X+', type: 'nas', form: 'desktop', shape: 'nas-desk', bays: 5, watts: 45, live: 'truenas' },
    { brand: 'TrueNAS', id: 'mini-r', name: 'Mini R', type: 'nas', form: 'rack', h: 2, color: 'black', bays: 12, bay: '3.5', rj: 2, watts: 90, live: 'truenas' },
    // Cisco
    { brand: 'Cisco', id: 'c9200l-24p', name: 'Catalyst 9200L-24P-4G', type: S, form: 'rack', h: 1, color: 'cisco', screen: null, console: true, rj: 24, poe: true, sfp: 4, watts: 50, live: 'snmp' },
    { brand: 'Cisco', id: 'c9300-48p', name: 'Catalyst 9300-48P', type: S, form: 'rack', h: 1, color: 'cisco', console: true, rj: 48, poe: true, sfp: 0, watts: 120, live: 'snmp' },
    { brand: 'Cisco', id: 'c2960x-24ps', name: 'Catalyst 2960X-24PS-L', type: S, form: 'rack', h: 1, color: 'cisco', console: true, rj: 24, poe: true, sfp: 4, watts: 40, live: 'snmp' },
    { brand: 'Cisco', id: 'c2960x-48fpd', name: 'Catalyst 2960X-48FPD-L', type: S, form: 'rack', h: 1, color: 'cisco', console: true, rj: 48, poe: true, sfp: 2, watts: 70, live: 'snmp' },
    { brand: 'Cisco', id: 'cbs350-24p', name: 'CBS350-24P-4G', type: S, form: 'rack', h: 1, color: 'black', console: true, rj: 24, poe: true, sfp: 4, watts: 30, live: 'snmp' },
    { brand: 'Cisco', id: 'cbs350-48p', name: 'CBS350-48P-4G', type: S, form: 'rack', h: 1, color: 'black', console: true, rj: 48, poe: true, sfp: 4, watts: 50, live: 'snmp' },
    { brand: 'Cisco', id: 'c1000-8p', name: 'Catalyst 1000-8P', type: S, form: 'desktop', shape: 'switch-metal', ports: 10, color: '#2d3a48', watts: 12, live: 'snmp' },
    { brand: 'Cisco', id: 'cbs250-8t', name: 'CBS250-8T', type: S, form: 'desktop', shape: 'switch-metal', ports: 8, color: '#1b1d21', watts: 6, live: 'snmp' },
    { brand: 'Cisco', id: 'isr4331', name: 'ISR 4331', type: G, form: 'rack', h: 1, color: 'cisco', console: true, rj: 3, sfp: 2, watts: 60, live: 'snmp' },
    // HPE Aruba
    { brand: 'HPE', id: 'io-1930-24p', name: 'Aruba Instant On 1930 24G PoE', type: S, form: 'rack', h: 1, color: 'light', rj: 24, poe: true, sfp: 4, watts: 30, live: 'snmp' },
    { brand: 'HPE', id: 'io-1960-24g', name: 'Aruba Instant On 1960 24G', type: S, form: 'rack', h: 1, color: 'light', rj: 24, sfp: 4, watts: 30, live: 'snmp' },
    { brand: 'HPE', id: 'aruba-2930f-24g', name: 'Aruba 2930F 24G', type: S, form: 'rack', h: 1, color: 'grey', console: true, rj: 24, sfp: 4, watts: 35, live: 'snmp' },
    // MikroTik
    { brand: 'MikroTik', id: 'crs326-24g', name: 'CRS326-24G-2S+RM', type: S, form: 'rack', h: 1, color: 'mikrotik', console: true, rj: 24, sfp: 2, watts: 15, live: 'snmp' },
    { brand: 'MikroTik', id: 'crs328-24p', name: 'CRS328-24P-4S+RM', type: S, form: 'rack', h: 1, color: 'mikrotik', console: true, rj: 24, poe: true, sfp: 4, watts: 25, live: 'snmp' },
    { brand: 'MikroTik', id: 'crs317-16s', name: 'CRS317-1G-16S+RM', type: S, form: 'rack', h: 1, color: 'mikrotik', console: true, rj: 1, sfp: 16, watts: 30, live: 'snmp' },
    { brand: 'MikroTik', id: 'ccr2004-16g', name: 'CCR2004-16G-2S+', type: G, form: 'rack', h: 1, color: 'mikrotik', console: true, rj: 16, sfp: 2, watts: 20, live: 'snmp' },
    { brand: 'MikroTik', id: 'ccr2116-12g', name: 'CCR2116-12G-4S+', type: G, form: 'rack', h: 1, color: 'mikrotik', console: true, rj: 12, sfp: 4, watts: 40, live: 'snmp' },
    { brand: 'MikroTik', id: 'rb5009', name: 'RB5009UG+S+IN', type: G, form: 'desktop', shape: 'switch-metal', ports: 9, color: '#c9ccd0', watts: 10, live: 'snmp' },
    { brand: 'MikroTik', id: 'hap-ax3', name: 'hAP ax³', type: G, form: 'desktop', shape: 'router-small', watts: 10, live: 'snmp' },
    { brand: 'MikroTik', id: 'cap-ax', name: 'cAP ax', type: 'ap', form: 'ceiling', shape: 'ap-round', watts: 8, live: 'snmp' },
    // TP-Link Omada
    { brand: 'TP-Link Omada', id: 'er605', name: 'ER605', type: G, form: 'desktop', shape: 'switch-metal', ports: 5, color: '#2a2d31', watts: 8, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'er7206', name: 'ER7206', type: G, form: 'desktop', shape: 'switch-metal', ports: 6, color: '#2a2d31', watts: 10, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'er8411', name: 'ER8411', type: G, form: 'rack', h: 1, color: 'grey', console: true, rj: 8, sfp: 2, watts: 25, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'sg3428', name: 'TL-SG3428', type: S, form: 'rack', h: 1, color: 'grey', console: true, rj: 24, sfp: 4, watts: 20, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'sg3428x', name: 'TL-SG3428X', type: S, form: 'rack', h: 1, color: 'grey', console: true, rj: 24, sfp: 4, watts: 25, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'sg3428xmp', name: 'TL-SG3428XMP', type: S, form: 'rack', h: 1, color: 'grey', console: true, rj: 24, poe: true, sfp: 4, watts: 35, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'sg2210mp', name: 'TL-SG2210MP', type: S, form: 'desktop', shape: 'switch-metal', ports: 10, color: '#2a2d31', watts: 10, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'oc200', name: 'OC200 controller', type: 'other', form: 'desktop', shape: 'oc-small', watts: 4, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'eap650', name: 'EAP650', type: 'ap', form: 'ceiling', shape: 'ap-round', watts: null, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'eap670', name: 'EAP670', type: 'ap', form: 'ceiling', shape: 'ap-round', size: 1.1, watts: null, live: 'omada' },
    { brand: 'TP-Link Omada', id: 'eap772', name: 'EAP772', type: 'ap', form: 'ceiling', shape: 'ap-round', size: 1.1, watts: null, live: 'omada' },
    // Netgear
    { brand: 'Netgear', id: 'gs308ep', name: 'GS308EP', type: S, form: 'desktop', shape: 'switch-metal', ports: 8, color: '#38465a', watts: 6, live: null },
    { brand: 'Netgear', id: 'gs316ep', name: 'GS316EP', type: S, form: 'desktop', shape: 'switch-metal', ports: 16, color: '#38465a', watts: 10, live: null },
    { brand: 'Netgear', id: 'gs724t', name: 'GS724T', type: S, form: 'rack', h: 1, color: 'netgear', rj: 24, sfp: 2, watts: 20, live: 'snmp' },
    { brand: 'Netgear', id: 'gs752tp', name: 'GS752TP', type: S, form: 'rack', h: 1, color: 'netgear', rj: 48, poe: true, sfp: 4, watts: 40, live: 'snmp' },
    // UPS
    { brand: 'APC', id: 'smt1500rmi2u', name: 'Smart-UPS SMT1500RMI2U', type: 'ups', form: 'rack', h: 2, color: 'black', ups: 'lcd', watts: 25, live: 'snmp' },
    { brand: 'APC', id: 'smt3000rmi2u', name: 'Smart-UPS SMT3000RMI2U', type: 'ups', form: 'rack', h: 2, color: 'black', ups: 'lcd', watts: 40, live: 'snmp' },
    { brand: 'APC', id: 'br1500mi', name: 'Back-UPS Pro 1500', type: 'ups', form: 'desktop', shape: 'ups-desk', watts: 10, live: 'nut' },
    { brand: 'APC', id: 'bx700', name: 'Back-UPS 700', type: 'ups', form: 'desktop', shape: 'ups-desk', size: 0.85, watts: 6, live: 'nut' },
    { brand: 'APC', id: 'ap7921b', name: 'Switched Rack PDU AP7921B', type: 'pdu', form: 'rack', h: 1, color: 'black', outlets: 8, watts: 5, live: 'snmp' },
    { brand: 'Eaton', id: '5p1550r', name: '5P 1550 Rack', type: 'ups', form: 'rack', h: 1, color: 'black', ups: 'lcd', watts: 20, live: 'snmp' },
    { brand: 'Eaton', id: '5px1500', name: '5PX 1500 Rack', type: 'ups', form: 'rack', h: 2, color: 'black', ups: 'lcd', watts: 25, live: 'snmp' },
    { brand: 'Eaton', id: '5e1100i', name: '5E 1100i', type: 'ups', form: 'desktop', shape: 'ups-desk', size: 0.85, watts: 8, live: 'nut' },
    { brand: 'Eaton', id: 'ellipse-pro', name: 'Ellipse PRO 1200', type: 'ups', form: 'desktop', shape: 'ups-desk', watts: 8, live: 'nut' },
    { brand: 'CyberPower', id: 'or1500erm1u', name: 'OR1500ERM1U', type: 'ups', form: 'rack', h: 1, color: 'black', ups: 'lcd', watts: 15, live: 'nut' },
    { brand: 'CyberPower', id: 'cp1500epfclcd', name: 'CP1500EPFCLCD', type: 'ups', form: 'desktop', shape: 'ups-desk', watts: 10, live: 'nut' },
    // Small computers
    { brand: 'Raspberry Pi', id: 'pi5', name: 'Raspberry Pi 5', type: 'other', form: 'desktop', shape: 'pi', watts: 6, live: null },
    { brand: 'Raspberry Pi', id: 'pi4', name: 'Raspberry Pi 4', type: 'other', form: 'desktop', shape: 'pi', watts: 5, live: null },
    { brand: 'Intel', id: 'nuc13', name: 'NUC 13 Pro', type: 'server', form: 'desktop', shape: 'mini-pc', watts: 20, live: 'proxmox' },
    { brand: 'Minisforum', id: 'ms01', name: 'MS-01', type: 'server', form: 'desktop', shape: 'mini-pc', size: 1.3, watts: 30, live: 'proxmox' },
    { brand: 'Lenovo', id: 'm920q', name: 'ThinkCentre M920q', type: 'server', form: 'desktop', shape: 'mini-pc', watts: 15, live: 'proxmox' },
    { brand: 'Dell', id: 'optiplex-micro', name: 'OptiPlex Micro', type: 'server', form: 'desktop', shape: 'mini-pc', watts: 15, live: 'proxmox' },
    { brand: 'HP', id: 'elitedesk-mini', name: 'EliteDesk 800 Mini', type: 'server', form: 'desktop', shape: 'mini-pc', watts: 15, live: 'proxmox' },
    { brand: 'Beelink', id: 'eq12', name: 'EQ12', type: 'server', form: 'desktop', shape: 'mini-pc', size: 0.9, watts: 10, live: 'proxmox' },
    // Tower servers
    { brand: 'Dell', id: 't440', name: 'PowerEdge T440', type: 'server', form: 'desktop', shape: 'tower', watts: null, live: 'idrac' },
    { brand: 'HPE', id: 'ml350-g10', name: 'ProLiant ML350 Gen10', type: 'server', form: 'desktop', shape: 'tower', watts: null, live: 'idrac' },
    { brand: 'HPE', id: 'microserver-g10p', name: 'ProLiant MicroServer Gen10 Plus', type: 'server', form: 'desktop', shape: 'microserver', watts: 40, live: 'idrac' },
  ];
  for (const m of list) m.front = `m-${m.id}`;
  return list;
})();

// Every drawn model by its front id
const MODEL_BY_FRONT = new Map([...UNIFI_MODELS, ...OTHER_MODELS].map((m) => [m.front, m]));
