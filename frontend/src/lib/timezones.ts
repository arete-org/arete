/** Every IANA zone the browser knows, grouped by region for the settings select. */
const REGIONS: Record<string, string> = {
  Africa: 'Afrique', America: 'Amérique', Antarctica: 'Antarctique', Arctic: 'Arctique', Asia: 'Asie',
  Atlantic: 'Atlantique', Australia: 'Australie', Europe: 'Europe', Indian: 'Océan Indien', Pacific: 'Pacifique',
};
const OTHERS = 'Autres';
/** A browser without `Intl.supportedValuesOf` still offers the former choices. */
const FALLBACK = ['Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];

/** Old names some browsers still list (ICU), shown once under today's name. */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe', 'Africa/Asmera': 'Africa/Asmara', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
};

export interface TimezoneGroup { region: string; zones: { value: string; label: string }[] }

function offset(zone: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat('fr-FR', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    return part ? ` (${part.replace('GMT', 'UTC')})` : '';
  } catch {
    return '';
  }
}

/** The zones by region (French names, regions then cities in order), always including `current`. */
export function timezoneGroups(current: string, at = new Date()): TimezoneGroup[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = FALLBACK;
  }
  if (!zones.length) zones = FALLBACK;
  const all = new Set(zones.map((zone) => RENAMED[zone] ?? zone));
  // A stored old name stays selectable as it is: the server knows both.
  if (current) all.add(current);
  const groups = new Map<string, TimezoneGroup>();
  for (const zone of all) {
    const [head, ...rest] = zone.split('/');
    const region = rest.length && REGIONS[head] ? REGIONS[head] : OTHERS;
    const city = (rest.length && REGIONS[head] ? rest.join(' / ') : zone).replace(/_/g, ' ');
    const group = groups.get(region) ?? { region, zones: [] };
    group.zones.push({ value: zone, label: `${city}${offset(zone, at)}` });
    groups.set(region, group);
  }
  const order = [...Object.values(REGIONS), OTHERS];
  return [...groups.values()]
    .sort((a, b) => order.indexOf(a.region) - order.indexOf(b.region))
    .map((group) => ({ ...group, zones: group.zones.sort((a, b) => a.label.localeCompare(b.label, 'fr')) }));
}
