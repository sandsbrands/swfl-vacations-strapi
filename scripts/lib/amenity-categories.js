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
// apiProperty.property_type from the Properties endpoint; "Bathrooms" and
// "Where you'll sleep" are per-room detail beyond what the site needs today.
const IGNORED_CATEGORIES = new Set(['property type', 'bathrooms', 'where you ll sleep']);

function normalize(caption) {
  return String(caption || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractItem(item) {
  const name = item.text || item.title;
  const note = item.title && item.text && item.title !== item.text ? item.title : undefined;
  return { name, note };
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
    const items = (category.amenities || []).map(extractItem).filter((item) => item.name);
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

module.exports = { processCategories, normalize };
