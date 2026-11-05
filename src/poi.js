// Categorizes a POI by keyword-matching its name, since the source GPX only
// tags every waypoint with a generic "Dot" symbol.
const CATEGORIES = [
  {
    id: 'resupply',
    emoji: '🛒',
    label: 'Resupply',
    color: '#e8590c',
    match: /joker|kiwi|spar|extra|rema|coop|intersport|sport ?1|kiosk|bua|supermarket|store/i,
  },
  {
    id: 'camping',
    emoji: '🏕️',
    label: 'Camping',
    color: '#2f9e44',
    match: /camping|campground/i,
  },
  {
    id: 'lodging',
    emoji: '🏨',
    label: 'Lodging',
    color: '#5f3dc4',
    match: /hotel|fjellstue|fjellhotell|hytter|hostel|lodge/i,
  },
  {
    id: 'station',
    emoji: '🚉',
    label: 'Train station',
    color: '#1864ab',
    match: /station/i,
  },
  {
    id: 'ferry',
    emoji: '⛴️',
    label: 'Ferry',
    color: '#0c8599',
    match: /ferry/i,
  },
  {
    id: 'food',
    emoji: '☕',
    label: 'Food & drink',
    color: '#a3610a',
    match: /cafe|canteen|coffee|restaurant/i,
  },
  {
    id: 'swim',
    emoji: '🏊',
    label: 'Swimming',
    color: '#1098ad',
    match: /swim|lake|vasskanten/i,
  },
  {
    id: 'water',
    emoji: '💧',
    label: 'Water refill',
    color: '#1971c2',
    match: /water|fountain|refill|spigot|tap\b/i,
  },
  {
    id: 'fuel',
    emoji: '⛽',
    label: 'Gas station',
    color: '#c92a2a',
    match: /gas station|fuel|petrol/i,
  },
  {
    id: 'sight',
    emoji: '👁️',
    label: 'Sight / viewpoint',
    color: '#c2255c',
    match: /stavkyrkje|church|museum|zipline|highest point|top of|view|bench|mountain/i,
  },
];

const DEFAULT_CATEGORY = { id: 'other', emoji: '📍', label: 'Other', color: '#495057' };

export function categorize(name) {
  for (const cat of CATEGORIES) {
    if (cat.match.test(name)) return cat;
  }
  return DEFAULT_CATEGORY;
}

export function allCategories() {
  return [...CATEGORIES, DEFAULT_CATEGORY];
}

// A POI can carry an explicit `category` id (OSM-derived stores do, since
// their names are arbitrary brands); otherwise fall back to name matching.
export function poiCategory(poi) {
  if (poi.category) {
    const explicit = allCategories().find((c) => c.id === poi.category);
    if (explicit) return explicit;
  }
  return categorize(poi.name);
}
