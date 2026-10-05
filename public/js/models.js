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
  const n = String(name || '').toLowerCase().replace(/^(unifi|usw|uap)[\s-]*/, '').replace(/[^a-z0-9+]/g, '');
  if (!n) return null;
  return UNIFI_MODELS.find((m) => m.name.toLowerCase().replace(/[^a-z0-9+]/g, '') === n) || null;
}
