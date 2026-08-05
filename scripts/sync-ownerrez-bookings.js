'use strict';

// Syncs new OwnerRez bookings into Strapi and triggers the GHL check-in
// workflow for each one.
//
// Usage:
//   node scripts/sync-ownerrez-bookings.js            polls the last 48h of Active bookings
//   node scripts/sync-ownerrez-bookings.js --dry-run  log what would happen, write/call nothing
//   node scripts/sync-ownerrez-bookings.js --remote   write to STRAPI_URL instead of the local database
//
// Each Active booking not yet mirrored in Strapi (matched by
// ownerrez_booking_id, same convention as ownerrez_property_id/
// ownerrez_review_id in sync-ownerrez.js) gets a `booking` record created, a
// GHL contact upserted (name/email/phone/address + checkin_date/
// checkout_date/property_booked/property_type/door_code/reservation_number/
// booking_channel custom fields), and the `str_checkin_start` tag added to
// fire the check-in workflow.
//
// Already-mirrored bookings are skipped entirely on later runs - if
// OwnerRez-side details change afterward (e.g. dates), this deliberately
// does NOT re-sync or re-tag, since re-adding the tag would re-fire the
// workflow and risk duplicate check-in messaging for the guest.
//
// Door code note: OwnerRez's own booking API has no door-code data for this
// account (confirmed against 768 real bookings with include_door_codes=true
// - the field never appears), so the door code sent to GHL comes from the
// already-synced `property` content-type's `lockbox_code` field instead
// (manually curated per property in Strapi, per this project's normal
// workflow). wifi_name/wifi_password are still never populated/sent -
// nothing in this feature's scope needs them.
//
// No persisted cursor/watermark: each run just re-queries a generous 48h
// lookback window and relies on the ownerrez_booking_id dedup check above to
// make reprocessing safe, matching sync-ownerrez.js's existing simple style.

require('dotenv').config();

const { compileStrapi, createStrapi } = require('@strapi/strapi');
const ownerRez = require('./lib/ownerrez-client');
const ghl = require('./lib/ghl-client');
const { createRemoteApp } = require('./lib/strapi-remote-client');

const LOOKBACK_HOURS = 48;
const CHECKIN_TAG = 'str_checkin_start';

function parseArgs(argv) {
  const args = { dryRun: false, remote: false, bookingIds: [] };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--remote') args.remote = true;
    else if (raw.startsWith('--booking-id=')) args.bookingIds.push(raw.slice('--booking-id='.length));
  }
  return args;
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

async function bootApp(remote) {
  if (remote) return createRemoteApp();
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  return app;
}

function pickDefault(list = []) {
  return list.find((item) => item.is_default) || list[0];
}

// The nested `guest` object on a booking only has first_name/last_name/id
// even with include_guest=true (confirmed against live data) - email,
// phone, and address require this separate call.
async function fetchGuestContact(guestId) {
  const guest = await ownerRez.getGuest(guestId);
  const address = pickDefault(guest.addresses);
  return {
    email: pickDefault(guest.email_addresses)?.address,
    phone: pickDefault(guest.phones)?.number,
    address1: address?.street1,
    city: address?.city,
    state: address?.state,
    postalCode: address?.postal_code,
    country: address?.country,
  };
}

// property_type isn't in the booking response's nested `property` object
// (only id/name/external_name/internal_code/public_url), so this is a
// separate OwnerRez call. lockbox_code comes from Strapi instead - see the
// door-code note at the top of this file.
async function fetchPropertyExtras(app, propertyId) {
  const [apiProperty, strapiProperty] = await Promise.all([
    ownerRez.getProperty(propertyId),
    app.documents('api::property.property').findFirst({ filters: { ownerrez_property_id: String(propertyId) } }),
  ]);
  return {
    propertyType: apiProperty.property_type,
    doorCode: strapiProperty?.lockbox_code,
  };
}

function nightsBetween(arrival, departure) {
  const ms = new Date(departure) - new Date(arrival);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

// booking.arrival/departure are the real stay dates. OwnerRez's own
// booking.check_in/check_out fields are just check-in/out *times* (e.g.
// "16:00") - unrelated to the Strapi schema's check_in/check_out date
// fields, which arrival/departure map onto instead.
function buildBookingFields(booking, guestContact, propertyExtras) {
  return stripUndefined({
    ownerrez_booking_id: String(booking.id),
    booking_id: booking.platform_reservation_number,
    guest_first_name: booking.guest?.first_name,
    guest_last_name: booking.guest?.last_name,
    guest_email: guestContact.email,
    guest_phone: guestContact.phone,
    property_name: booking.property?.name || booking.property?.external_name,
    booking_source: booking.listing_site,
    booking_status: booking.status,
    lockbox_code: propertyExtras.doorCode,
    number_of_guests: (booking.adults || 0) + (booking.children || 0) + (booking.infants || 0),
    number_of_nights: nightsBetween(booking.arrival, booking.departure),
    // Schema field is `integer`; OwnerRez returns a decimal dollar amount.
    // Rounded - fine for this internal reference mirror, not the billing
    // source of truth (that stays in OwnerRez/Stripe).
    total_amount: typeof booking.total_amount === 'number' ? Math.round(booking.total_amount) : undefined,
    check_in: booking.arrival,
    check_out: booking.departure,
  });
}

async function syncToGhl(bookingFields, guestContact, propertyExtras) {
  const contact = await ghl.upsertContact({
    firstName: bookingFields.guest_first_name,
    lastName: bookingFields.guest_last_name,
    email: bookingFields.guest_email,
    phone: bookingFields.guest_phone,
    address1: guestContact.address1,
    city: guestContact.city,
    state: guestContact.state,
    postalCode: guestContact.postalCode,
    country: guestContact.country,
    customFields: [
      { key: 'checkin_date', field_value: bookingFields.check_in },
      { key: 'checkout_date', field_value: bookingFields.check_out },
      { key: 'property_booked', field_value: bookingFields.property_name },
      { key: 'property_type', field_value: propertyExtras.propertyType },
      { key: 'door_code', field_value: bookingFields.lockbox_code },
      { key: 'reservation_number', field_value: bookingFields.booking_id },
      { key: 'booking_channel', field_value: bookingFields.booking_source },
    ].filter((f) => f.field_value !== undefined && f.field_value !== null),
  });
  await ghl.addTags({ contactId: contact.id, tags: [CHECKIN_TAG] });
  return contact;
}

async function processBooking(app, booking, { dryRun }) {
  const ownerrezBookingId = String(booking.id);
  const existing = await app.documents('api::booking.booking').findFirst({
    filters: { ownerrez_booking_id: ownerrezBookingId },
  });
  if (existing) return { status: 'skipped' };

  const [guestContact, propertyExtras] = await Promise.all([
    fetchGuestContact(booking.guest_id),
    fetchPropertyExtras(app, booking.property_id),
  ]);
  const bookingFields = buildBookingFields(booking, guestContact, propertyExtras);

  if (dryRun) {
    console.log(`[sync] (dry run) would create booking #${ownerrezBookingId}:`);
    console.log(
      JSON.stringify(
        {
          ...bookingFields,
          guest_address: [guestContact.address1, guestContact.city, guestContact.state, guestContact.postalCode, guestContact.country]
            .filter(Boolean)
            .join(', '),
          property_type: propertyExtras.propertyType,
        },
        null,
        2
      )
    );
    return { status: 'would-create' };
  }

  await app.documents('api::booking.booking').create({ data: bookingFields });

  if (!bookingFields.guest_email) {
    console.warn(`[sync] booking #${ownerrezBookingId} has no guest email - Strapi record created, GHL sync skipped`);
    return { status: 'created-no-ghl' };
  }

  await syncToGhl(bookingFields, guestContact, propertyExtras);
  console.log(
    `[sync] created booking #${ownerrezBookingId}, synced ${bookingFields.guest_email} to GHL, tagged ${CHECKIN_TAG}`
  );
  return { status: 'created' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --booking-id is for targeted manual testing of a specific booking that
  // may be outside the normal rolling window, so it widens the query instead
  // of relying on the 48h default.
  const lookbackHours = args.bookingIds.length > 0 ? 400 * 24 : LOOKBACK_HOURS;
  const sinceUtc = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  let bookings = await ownerRez.listBookings({ since_utc: sinceUtc, status: 'Active', include_guest: true });
  if (args.bookingIds.length > 0) {
    bookings = bookings.filter((b) => args.bookingIds.includes(String(b.id)));
  }

  if (bookings.length === 0) {
    console.log('[sync] no active bookings in the lookback window');
    return;
  }

  const app = await bootApp(args.remote);
  const counts = { created: 0, 'created-no-ghl': 0, skipped: 0, 'would-create': 0, failed: 0 };
  try {
    for (const booking of bookings) {
      try {
        const { status } = await processBooking(app, booking, { dryRun: args.dryRun });
        counts[status] += 1;
      } catch (err) {
        counts.failed += 1;
        console.error(`[sync] booking #${booking.id} failed, continuing with the rest: ${err.message}`);
      }
    }
  } finally {
    await app.destroy();
  }

  console.log(
    `[sync] processed ${bookings.length} booking(s): ${counts.created} created+synced, ` +
      `${counts['created-no-ghl']} created without GHL (no email), ${counts.skipped} already synced, ` +
      `${counts['would-create']} would-create (dry run), ${counts.failed} failed`
  );
  if (counts.failed > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync] failed:', err);
    process.exit(1);
  });
