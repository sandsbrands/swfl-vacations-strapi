'use strict';

// OwnerRez's Listings API bundles several different kinds of content into
// the generic `amenity_categories` array - real checkbox amenities,
// location descriptor tags, and structured single/list fields all show up
// there with the same { caption, amenities: [{ text, title }] } shape. This
// module sorts each category into the right bucket for the Strapi schema.
//
// Within a category, an item's `text` is the canonical short label; when
// `title` is also present and differs from `text`, it's a free-text note
// attached to that item, e.g. under Expectations:
//   { text: "Cameras/Surveillance", title: "Ring camera at front door..." }

const AMENITY_CATEGORIES = {
  expectations: 'expectations',
  'popular amenities': 'popular_amenities',
  kitchen: 'kitchen',
  business: 'business',
  entertainment: 'entertainment',
  'pool spa': 'pool_spa',
  outdoor: 'outdoor',
  theme: 'theme',
  family: 'family',
  parking: 'parking',
  safety: 'safety',
  'other services': 'other_services',
  dining: 'other_services',
  accessibility: 'accessibility',
  'where you ll sleep': 'sleeping_arrangements',
};

const LOCATION_TAG_CATEGORIES = {
  'setting view': 'setting_view',
  attractions: 'attractions',
  'sports adventure': 'sports_adventure',
  leisure: 'leisure',
  local: 'local',
};

const STRUCTURED_SINGLE_CATEGORIES = {
  accommodation: 'accommodation_type',
  'check in type': 'checkin_type',
};

const STRUCTURED_LIST_CATEGORIES = {
  'house rules': 'house_rules',
  'check out tasks': 'checkout_tasks',
};

// Recognized but deliberately not modeled yet: "Property Type" duplicates
// apiProperty.property_type from the Properties endpoint; "Bathrooms" is
// per-room detail beyond what the site needs today.
const IGNORED_CATEGORIES = new Set(['property type', 'bathrooms']);

// OwnerRez encodes punctuation as HTML entities even in these plain-text
// fields (e.g. "Main &ndash; 1 King Bed"), so decode before storing.
const HTML_ENTITIES = {
  amp: '&',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(value) {
  return String(value || '').replace(/&(#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') return String.fromCharCode(Number(code.slice(1)));
    return HTML_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function normalize(caption) {
  return String(caption || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Where you'll sleep" mixes a redundant summary item ("3 Bedrooms, sleeps
// 4-6" - already covered by apiProperty.bedrooms/sleeps_max) in with real
// per-room bed entries ("Main - 1 King Bed"). Only the latter have an
// en-dash separator (post-decode), so use that to drop the summary line.
function isRealSleepingArrangementItem({ name }) {
  return name.includes('–');
}

function extractItem(item) {
  const name = decodeEntities(item.text || item.title);
  const rawNote = item.title && item.text && item.title !== item.text ? item.title : undefined;
  return { name, note: rawNote ? decodeEntities(rawNote) : undefined };
}

// "Heated" isn't a real amenity_categories item - OwnerRez only surfaces it
// as free text in a pool call-out's `title` (e.g. "Heated", "Heated / Fenced"),
// separate from `amenity_categories`. Synthesize a real "Heated Pool"
// amenity from it so it's searchable like everything else.
function extractHeatedPoolItem(callOuts = []) {
  const hasHeatedPool = callOuts.some((c) => /pool/i.test(c.text || '') && /heated/i.test(c.title || ''));
  return hasHeatedPool ? { name: 'Heated Pool', category: 'pool_spa' } : null;
}

// Sorts a listing's amenity_categories into:
// - amenityItems: [{ name, category, note }] for the `amenity` relation
// - locationTags: { setting_view: [...], attractions: [...], ... }
// - structuredFields: { accommodation_type, checkin_type, house_rules, checkout_tasks }
// - unmapped: category captions that matched nothing above (caller should log and skip, not fail)
function processCategories(categories = []) {
  const amenityItems = [];
  const locationTags = {};
  const structuredFields = {};
  const unmapped = new Set();

  for (const category of categories) {
    const rawCaption = category.caption || category.type || '';
    const key = normalize(rawCaption);
    let items = (category.amenities || []).map(extractItem).filter((item) => item.name);
    if (key === 'where you ll sleep') items = items.filter(isRealSleepingArrangementItem);
    if (items.length === 0) continue;

    if (AMENITY_CATEGORIES[key]) {
      const mappedCategory = AMENITY_CATEGORIES[key];
      for (const { name, note } of items) {
        amenityItems.push({ name, category: mappedCategory, note });
      }
    } else if (LOCATION_TAG_CATEGORIES[key]) {
      locationTags[LOCATION_TAG_CATEGORIES[key]] = items.map((item) => item.name);
    } else if (STRUCTURED_SINGLE_CATEGORIES[key]) {
      structuredFields[STRUCTURED_SINGLE_CATEGORIES[key]] = items[0].name;
    } else if (STRUCTURED_LIST_CATEGORIES[key]) {
      structuredFields[STRUCTURED_LIST_CATEGORIES[key]] = items.map((item) => item.name);
    } else if (IGNORED_CATEGORIES.has(key)) {
      // intentionally skipped, see comment above
    } else {
      unmapped.add(rawCaption);
    }
  }

  return { amenityItems, locationTags, structuredFields, unmapped: [...unmapped] };
}

module.exports = { processCategories, normalize, extractHeatedPoolItem };
