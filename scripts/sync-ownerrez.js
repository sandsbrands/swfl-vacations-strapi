'use strict';

// Syncs property content from OwnerRez into Strapi.
//
// Usage:
//   node scripts/sync-ownerrez.js                        sync all active OwnerRez properties
//   node scripts/sync-ownerrez.js --property-id=12345    sync one property (repeatable)
//   node scripts/sync-ownerrez.js --fixture=path/to.json sync from a local fixture instead of the live API
//   node scripts/sync-ownerrez.js --dry-run              log what would happen, write nothing
//   node scripts/sync-ownerrez.js --with-photos           also download + upload OwnerRez photos (slow, opt-in)
//
// What gets synced (see MEMORY notes from the OwnerRez review): amenities,
// long-form descriptions, guest info, location, reviews, and the booking
// URL all come from OwnerRez. Ops-only fields (lockbox_code,
// stripe_product_id, qbo_project_id, management_tier, ical_feed_url,
// is_active, images) are never touched by this script - those are curated
// by hand in Strapi. `name`/`slug` are only set the first time a property
// is created, so a human can rename/re-slug afterward without the sync
// reverting it. wifi_password is intentionally NOT synced onto `property` -
// it stays scoped to the per-booking `booking.wifi_password` field.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');
const ownerRez = require('./lib/ownerrez-client');
const { processCategories } = require('./lib/amenity-categories');
const { syncPhotos } = require('./lib/photo-sync');

function parseArgs(argv) {
  const args = { propertyIds: [], dryRun: false, withPhotos: false };
  for (const raw of argv) {
    if (raw.startsWith('--fixture=')) args.fixture = raw.slice('--fixture='.length);
    else if (raw.startsWith('--property-id=')) args.propertyIds.push(raw.slice('--property-id='.length));
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--with-photos') args.withPhotos = true;
  }
  return args;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

async function bootStrapi() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  return app;
}

async function loadFixtureBundles(fixturePath) {
  const abs = path.resolve(process.cwd(), fixturePath);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return Array.isArray(data) ? data : [data];
}

// OwnerRez listings don't have their own id - GET /v2/listings/{id} takes
// the property id directly, and the response echoes it back as
// `property_id`. So there's only ever one id per property to track.
async function loadLiveBundles(propertyIds) {
  let ids = propertyIds;
  if (ids.length === 0) {
    const properties = await ownerRez.listProperties({ active: true });
    ids = properties.map((p) => p.id);
  }

  const bundles = [];
  for (const id of ids) {
    try {
      const [property, listing, reviews] = await Promise.all([
        ownerRez.getProperty(id),
        ownerRez.getListing(id),
        ownerRez.listReviewsForProperty(id),
      ]);
      bundles.push({ property, listing, reviews });
    } catch (err) {
      console.error(`[sync] failed to fetch OwnerRez data for property #${id}, skipping: ${err.message}`);
    }
  }
  return bundles;
}

async function ensureAmenity(app, name, category) {
  const existing = await app.documents('api::amenity.amenity').findFirst({
    filters: { name: { $eqi: name }, category },
  });
  if (existing) return existing;

  const created = await app.documents('api::amenity.amenity').create({ data: { name, category } });
  console.log(`[sync] created amenity "${name}" (${category})`);
  return created;
}

async function syncAmenitiesAndCategories(app, listing) {
  const { amenityItems, locationTags, structuredFields, unmapped } = processCategories(listing.amenity_categories);

  const amenityDocIds = [];
  const amenityNotes = {};
  for (const { name, category, note } of amenityItems) {
    const amenity = await ensureAmenity(app, name, category);
    amenityDocIds.push(amenity.documentId);
    if (note) amenityNotes[`${category}:${name}`] = note;
  }

  if (unmapped.length > 0) {
    console.warn(`[sync] unrecognized amenity categories, skipped: ${unmapped.join(', ')}`);
  }

  return { amenityDocIds, amenityNotes, locationTags, structuredFields };
}

function buildSyncedFields(apiProperty, listing, categoryData) {
  const address = apiProperty.address || {};
  const descriptions = listing.descriptions || {};
  const { locationTags, structuredFields, amenityNotes } = categoryData;

  return stripUndefined({
    accommodation_type: structuredFields.accommodation_type,
    checkin_type: structuredFields.checkin_type,
    house_rules: structuredFields.house_rules,
    checkout_tasks: structuredFields.checkout_tasks,
    location_tags: Object.keys(locationTags).length > 0 ? locationTags : undefined,
    amenity_notes: Object.keys(amenityNotes).length > 0 ? amenityNotes : undefined,

    ownerrez_public_url: apiProperty.public_url,
    cancellation_policy: listing.cancellation_policy,
    property_type: apiProperty.property_type,
    address: address.street1,
    address_line_2: address.street2,
    city: address.city,
    state: address.state,
    zip: address.postal_code,
    country: address.country,
    latitude: apiProperty.latitude,
    longitude: apiProperty.longitude,
    bedrooms: apiProperty.bedrooms,
    bathrooms: apiProperty.bathrooms,
    max_occupancy: apiProperty.max_guests,
    check_in_time: apiProperty.check_in,
    check_in_end_time: apiProperty.check_in_end,
    check_out_time: apiProperty.check_out,

    headline: descriptions.headline,
    summary: descriptions.short_description,
    description: descriptions.description,
    accommodations_summary: descriptions.accommodations_summary,
    accommodations_detail: descriptions.accommodations_detail,
    features_description: descriptions.features_description,
    location_description: descriptions.location_description,
    location_other_activities: descriptions.location_other_activities,
    getting_there: descriptions.getting_there,
    getting_around: descriptions.getting_around,
    owner_listing_story: descriptions.owner_listing_story,
    why_purchased: descriptions.why_purchased,
    unique_benefits: descriptions.unique_benefits,
    year_purchased: descriptions.year_purchased,
    guest_access: descriptions.guest_access,

    checkin_instructions: listing.check_in_instructions,
    directions: listing.directions,
    house_manual: listing.house_manual,
    internet_info: listing.internet_info,
    wifi_network: listing.wifi_network,

    review_average: listing.review_average,
    review_count: listing.review_count,

    amenity_call_outs: listing.amenity_call_outs || [],
  });
}

function buildInitialFields(apiProperty) {
  const name = apiProperty.name || apiProperty.external_name || `OwnerRez Property ${apiProperty.id}`;
  return { name, slug: slugify(name) };
}

async function syncReviews(app, propertyDocumentId, reviews = []) {
  for (const review of reviews) {
    const ownerrezReviewId = String(review.id);
    const existing = await app.documents('api::review.review').findFirst({
      filters: { ownerrez_review_id: ownerrezReviewId },
    });

    const data = stripUndefined({
      ownerrez_review_id: ownerrezReviewId,
      title: review.title,
      body: review.body,
      stars: review.stars,
      response: review.response,
      listing_site: review.listing_site,
      reviewer_type: review.reviewer_type || (review.host_review ? 'host' : 'guest'),
      display_name: review.display_name,
      display_location: review.display_location,
      review_date: review.date,
      month_of_stay: review.month_of_stay,
      year_of_stay: review.year_of_stay,
      property: propertyDocumentId,
    });

    if (existing) {
      await app.documents('api::review.review').update({ documentId: existing.documentId, data });
    } else {
      await app.documents('api::review.review').create({ data });
    }
  }
  if (reviews.length > 0) {
    console.log(`[sync] synced ${reviews.length} review(s)`);
  }
}

async function upsertProperty(app, bundle, { withPhotos } = {}) {
  const { property: apiProperty, listing, reviews } = bundle;
  const ownerrezPropertyId = String(apiProperty.id);

  const existing = await app.documents('api::property.property').findFirst({
    filters: { ownerrez_property_id: ownerrezPropertyId },
  });

  const { amenityDocIds, amenityNotes, locationTags, structuredFields } = await syncAmenitiesAndCategories(
    app,
    listing
  );
  const syncedFields = buildSyncedFields(apiProperty, listing, { locationTags, structuredFields, amenityNotes });

  let propertyDoc;
  if (existing) {
    propertyDoc = await app.documents('api::property.property').update({
      documentId: existing.documentId,
      data: { ...syncedFields, amenities: amenityDocIds },
    });
    console.log(`[sync] updated property ${existing.documentId} (ownerrez #${ownerrezPropertyId})`);
  } else {
    propertyDoc = await app.documents('api::property.property').create({
      data: {
        ...buildInitialFields(apiProperty),
        ...syncedFields,
        ownerrez_property_id: ownerrezPropertyId,
        is_active: false,
        amenities: amenityDocIds,
      },
    });
    console.log(
      `[sync] created draft property ${propertyDoc.documentId} (ownerrez #${ownerrezPropertyId}) - review and publish in Strapi admin`
    );
  }

  await syncReviews(app, propertyDoc.documentId, reviews);

  if (withPhotos) {
    await syncPhotos(app, propertyDoc, listing.photos);
  }

  return propertyDoc;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundles = args.fixture ? await loadFixtureBundles(args.fixture) : await loadLiveBundles(args.propertyIds);

  if (bundles.length === 0) {
    console.log('[sync] nothing to sync');
    return;
  }

  if (args.dryRun) {
    for (const bundle of bundles) {
      console.log(`[sync] (dry run) would sync ownerrez property #${bundle.property.id}`);
    }
    return;
  }

  const app = await bootStrapi();
  const failures = [];
  try {
    for (const bundle of bundles) {
      try {
        await upsertProperty(app, bundle, { withPhotos: args.withPhotos });
      } catch (err) {
        failures.push(bundle.property.id);
        console.error(`[sync] property #${bundle.property.id} failed, continuing with the rest: ${err.message}`);
      }
    }
  } finally {
    await app.destroy();
  }

  if (failures.length > 0) {
    console.error(`[sync] finished with ${failures.length} failed propert(ies): ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync] failed:', err);
    process.exit(1);
  });
