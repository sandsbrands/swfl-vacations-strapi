'use strict';

// One-time (rerunnable) backfill: OwnerRez's v2 REST API has no field for
// the GUID its booking widget needs (confirmed - checked the full
// properties/{id} and listings/{id} response shapes, no widget-related
// field exists). That GUID only appears in the widget embed OwnerRez's own
// WordPress plugin renders on swflvacations.com
// (<div class="ownerrez-widget" data-propertyId="...">), which we already
// have a URL for on every property (ownerrez_public_url). This script
// fetches that page per property and scrapes the GUID out of the embed.
//
// Usage:
//   node scripts/backfill-widget-ids.js            all properties, local DB
//   node scripts/backfill-widget-ids.js --remote    write to STRAPI_URL via its REST API

require('dotenv').config();

const { compileStrapi, createStrapi } = require('@strapi/strapi');
const { createRemoteApp } = require('./lib/strapi-remote-client');

function parseArgs(argv) {
  return { remote: argv.includes('--remote') };
}

async function bootApp(remote) {
  if (remote) return createRemoteApp();
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  return app;
}

async function scrapeWidgetPropertyId(publicUrl) {
  const res = await fetch(publicUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();
  const match = html.match(/ownerrez-widget"[^>]*data-propertyId="([a-f0-9]+)"/i);
  if (!match) throw new Error('no ownerrez-widget data-propertyId found on page');
  return match[1];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = await bootApp(args.remote);

  try {
    const properties = await app.documents('api::property.property').findMany({
      fields: ['name', 'ownerrez_public_url', 'ownerrez_widget_property_id'],
    });

    console.log(`[backfill] found ${properties.length} properties`);

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const property of properties) {
      if (property.ownerrez_widget_property_id) {
        skipped += 1;
        continue;
      }
      if (!property.ownerrez_public_url) {
        console.warn(`[backfill] "${property.name}" has no ownerrez_public_url, skipping`);
        failed += 1;
        continue;
      }

      try {
        const widgetPropertyId = await scrapeWidgetPropertyId(property.ownerrez_public_url);
        await app.documents('api::property.property').update({
          documentId: property.documentId,
          data: { ownerrez_widget_property_id: widgetPropertyId },
        });
        console.log(`[backfill] "${property.name}" -> ${widgetPropertyId}`);
        updated += 1;
      } catch (err) {
        console.error(`[backfill] "${property.name}" failed: ${err.message}`);
        failed += 1;
      }
    }

    console.log(`[backfill] done: updated ${updated}, already set ${skipped}, failed ${failed}`);
  } finally {
    await app.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] failed:', err);
    process.exit(1);
  });
