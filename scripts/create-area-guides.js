'use strict';

// One-time content migration: rebuilds the 4 "Local Attractions" destination
// pages from the live WordPress site (swflvacations.com/vacation-rentals/...)
// as real Travel Guide entries, per Matt's content-parity audit
// (see MIGRATION_REDIRECTS.md in the frontend repo). Real place names/content
// sourced from the live WP pages 2026-07-26, lightly edited for tone
// consistency with the other 7 existing guides - not fabricated.
//
// Usage:
//   node scripts/create-area-guides.js            local DB
//   node scripts/create-area-guides.js --remote   writes to STRAPI_URL via its REST API

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

function p(text) {
  return { type: 'paragraph', children: [{ type: 'text', text }] };
}
function h2(text) {
  return { type: 'heading', level: 2, children: [{ type: 'text', text }] };
}
function ul(items) {
  return {
    type: 'list',
    format: 'unordered',
    children: items.map((text) => ({
      type: 'list-item',
      children: [{ type: 'text', text }],
    })),
  };
}

const PUBLISHED_DATE = '2026-07-26';
const AUTHOR = 'SWFL Vacations Team';

const GUIDES = [
  {
    title: 'Fort Myers Beach: Where to Eat, Play, and Unwind',
    slug: 'fort-myers-beach-area-guide',
    excerpt:
      'Seven miles of Estero Island beach, a laid-back bar-and-grill scene, and dolphin cruises to fill the rest of your day.',
    category: 'Area Guides',
    seo_title: 'Fort Myers Beach Guide | SWFL Vacations',
    seo_description:
      'Where to eat, which beaches to hit, and what to do on Fort Myers Beach - a local guide for guests staying nearby.',
    content: [
      p(
        "Fort Myers Beach runs along Estero Island - seven miles of Gulf-front sand, a laid-back bar scene, and enough on-the-water activities to fill a week. Here's where to start."
      ),
      h2('Where to Eat'),
      p(
        'The food scene here leans casual and waterfront - seafood shacks, sunset patios, and the occasional live band.'
      ),
      ul([
        'Sandy Bottoms Bar & Grill - relaxed, oceanfront, exactly what it sounds like',
        'Matanzas on the Bay - waterfront dining with panoramic Estero Bay views',
        "Doc Ford's Rum Bar & Grill - Caribbean and American plates, named for the Randy Wayne White novels",
        'Fresh Catch Bistro - seafood specialties with sunset views over Estero Bay',
        "Smokin' Oyster Brewery - house-made beers and fresh seafood",
        "Nervous Nellie's - waterfront spot near the pier with live entertainment",
      ]),
      h2('Beaches'),
      ul([
        'Estero Island Beach - the main stretch, family-friendly',
        'Crescent Beach Park - small and quieter, popular with families',
        'Bunche Beach Preserve - tidal flats, a favorite for birdwatching',
        'Lovers Key State Park Beach - more secluded, good shelling and wildlife viewing',
      ]),
      h2('Things to Do'),
      ul([
        'Fort Myers Beach Pier and Times Square - shops, cafes, and street performers',
        'Island Time Dolphin Cruises - dolphin watching and sunset cruises',
        'Adventure Watersports or YOLO Watersports - jet skis, parasailing, paddleboards',
        'Backwater Adventures - fishing charters and eco-tours',
        'Matanzas Pass Preserve - a 60-acre coastal preserve with hiking trails',
      ]),
    ],
  },
  {
    title: 'Classic Cape Coral: Restaurants, Attractions, and Nightlife',
    slug: 'cape-coral-area-guide',
    excerpt:
      'Waterfront dining, Four Mile Cove kayaking, and a marina scene built around Cape Harbour - the essentials for a Cape Coral stay.',
    category: 'Area Guides',
    seo_title: 'Cape Coral Guide | SWFL Vacations',
    seo_description:
      'Restaurants, attractions, and things to do in Cape Coral - a local guide for guests staying in the area.',
    content: [
      p(
        'Cape Coral is a waterfront town built around canals - boating and kayaking are part of daily life here, alongside a growing food and nightlife scene.'
      ),
      h2('Where to Eat'),
      ul([
        'Cape Coral Brewing Company - craft beers with gourmet burgers and sandwiches',
        'Ciao Wood Fired Pizza & Trattoria - Neapolitan-style pizza from a wood-fired oven',
        'Rumrunners - seafood, steaks, and pasta at Cape Harbour',
        'Fathoms Restaurant & Bar - contemporary American with waterfront views and live music',
      ]),
      h2('Attractions'),
      ul([
        'Four Mile Cove Ecological Preserve - walking trails and kayak rentals',
        'Tarpon Point Marina - shops, restaurants, a spa, and boat tours',
        'Sun Splash Family Waterpark - slides, a lazy river, and a wave pool',
        'Coral Oaks Golf Course - a well-maintained public course at affordable rates',
        'Cape Coral Yacht Club Beach - sandy shoreline, picnic areas, and a fishing pier',
        'Cape Harbour - a marina community with shops and waterfront dining',
      ]),
      h2('Nightlife'),
      ul([
        'The Boathouse Tiki Bar & Grill - waterfront, live music, tiki-bar atmosphere',
        "Ralph's Place - a cozy neighborhood bar with live music and karaoke",
        'The Dek Bar - laid-back waterfront bar at Marina Village',
      ]),
      h2('Adventures'),
      ul([
        'Caloosahatchee Creeks Preserve eco kayak tour - hidden mangrove tunnels, good birdwatching',
        'Manatee & dolphin sighting boat tours with guided commentary',
        "Captain Tony's Fishing Adventures - inshore and nearshore charters",
      ]),
    ],
  },
  {
    title: 'Truly Bonita: A Local Guide to Bonita Springs',
    slug: 'bonita-springs-area-guide',
    excerpt:
      'Barefoot Beach Preserve, Everglades day trips, and a dining scene that runs from Italian to Hawaiian fusion - the Bonita Springs highlights.',
    category: 'Area Guides',
    seo_title: 'Bonita Springs Guide | SWFL Vacations',
    seo_description:
      'Where to eat, which beaches to visit, and what to do in Bonita Springs - a local guide for guests staying in the area.',
    content: [
      p(
        'Bonita Springs blends quiet, pristine beaches with easy access to nature preserves, golf, and a dining scene worth planning a night around.'
      ),
      h2('Where to Eat'),
      ul([
        "DeRomo's Gourmet Market & Restaurant - Italian cuisine",
        "Shula's Steak House - prime cuts, classic steakhouse",
        'C Level Bistro & Wine Bar - wine-forward, inventive plates',
        "Roy's Restaurant - Hawaiian fusion with fresh seafood",
      ]),
      h2('Beaches'),
      ul([
        'Barefoot Beach Preserve County Park - pristine, powdery sand',
        'Little Hickory Island Beach Park - a quieter, less-crowded stretch',
        'Dog Beach Park - off-leash and dog-friendly',
      ]),
      h2('Things to Do'),
      ul([
        'Everglades Day Safari - guided eco-adventure with wildlife spotting',
        'Promenade at Bonita Bay - upscale outdoor shopping',
        'Center for the Arts Bonita Springs - exhibitions, workshops, performances',
        'Shell Factory & Nature Park - nature park and shell collection in North Fort Myers',
        'Everglades Wonder Gardens - wildlife sanctuary and botanical gardens',
      ]),
      h2('On the Water'),
      ul([
        'Lovers Key Adventures & Events - kayak tours through mangrove estuaries',
        'Estero Bay Preserve State Park - wetland trails',
        'Bonita Boat Rentals - pontoons, deck boats, and center consoles',
      ]),
    ],
  },
  {
    title: 'Fort Myers Favorites: Restaurants, Beaches, and Nature',
    slug: 'fort-myers-area-guide',
    excerpt:
      'Six Mile Cypress boardwalks, historic downtown dining, and easy access to Sanibel - the Fort Myers area at a glance.',
    category: 'Area Guides',
    seo_title: 'Fort Myers Guide | SWFL Vacations',
    seo_description:
      'Restaurants, beaches, and nature preserves around Fort Myers - a local guide for guests staying in the area.',
    content: [
      p(
        'Fort Myers pairs a historic downtown dining scene with some of the best nature preserves in the region, plus easy access to Sanibel Island.'
      ),
      h2('Where to Eat'),
      ul([
        'The Veranda - historic downtown venue in restored homes, known for shrimp and grits and pecan-crusted grouper',
        "Harold's Restaurant - global flavors at Gulf Coast Town Center",
        'The Melting Pot - cheese and chocolate fondue, tableside entrees',
        "Angelina's Ristorante - handmade pasta and an extensive wine list",
      ]),
      h2('Nature & Outdoors'),
      ul([
        'Six Mile Cypress Preserve - a 3,500-acre wetland sanctuary with elevated boardwalks',
        'Manatee Park - manatees seek refuge here in the warm waters during winter months',
      ]),
      h2('Beaches'),
      ul([
        "Fort Myers Beach - seven miles of shoreline on Estero Island",
        'Lovers Key State Park - secluded beaches and mangrove forests',
        "Sanibel Island beaches - Bowman's Beach, Blind Pass Beach, Lighthouse Beach Park, known for world-class shelling",
        'Bowditch Point Park - panoramic Gulf and Estero Bay views at the tip of Estero Island',
      ]),
      h2('Shopping & More'),
      ul([
        'Bell Tower Shops - an upscale outdoor center',
        'Miromar Outlets - over 140 designer and brand-name stores',
        "Good Time Charters - fishing charters and boat rentals for all experience levels",
        "Adventures in Paradise - guided kayak tours through mangrove tunnels",
      ]),
    ],
  },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = await bootApp(args.remote);

  try {
    let created = 0;
    let skipped = 0;

    for (const guide of GUIDES) {
      const existing = await app.documents('api::travel-guide.travel-guide').findFirst({
        filters: { slug: guide.slug },
      });

      if (existing) {
        console.log(`[area-guides] "${guide.title}" already exists (slug: ${guide.slug}), skipping`);
        skipped += 1;
        continue;
      }

      const doc = await app.documents('api::travel-guide.travel-guide').create({
        data: {
          title: guide.title,
          slug: guide.slug,
          excerpt: guide.excerpt,
          content: guide.content,
          author: AUTHOR,
          published_date: PUBLISHED_DATE,
          category: guide.category,
          seo_title: guide.seo_title,
          seo_description: guide.seo_description,
        },
      });
      console.log(`[area-guides] created "${guide.title}" -> ${doc.documentId}`);
      created += 1;
    }

    console.log(`[area-guides] done: created ${created}, already existed ${skipped}`);
  } finally {
    await app.destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[area-guides] failed:', err);
    process.exit(1);
  });
