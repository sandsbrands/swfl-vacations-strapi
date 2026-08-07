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
// Already-mirrored bookings are otherwise skipped on later runs - if
// OwnerRez-side details change afterward (e.g. dates), this deliberately
// does NOT re-sync or re-tag, since re-adding the tag would re-fire the
// workflow and risk duplicate check-in messaging for the guest. The one
// exception is the door code backfill pass below.
//
// Door code note: OwnerRez does have real door-code data
// (`booking.door_codes`, an array of {code, lock_names}), confirmed against
// a real booking - but it's populated close to arrival, not at booking
// time, so a booking synced right after it's made (often months out) won't
// have one yet. A second query below re-checks bookings arriving in the
// next 14 days and backfills `lockbox_code` (Strapi + a GHL custom-field
// update only, no re-tagging) for any that now have a code but didn't
// before. wifi_name/wifi_password are still never populated/sent - nothing
// in this feature's scope needs them.
//
// No persisted cursor/watermark: each run just re-queries a generous 48h
// lookback window (plus the 14-day arrival window for the backfill pass)
// and relies on the ownerrez_booking_id dedup check to make reprocessing
// safe, matching sync-ownerrez.js's existing simple style.

require('dotenv').config();

const { compileStrapi, createStrapi } = require('@strapi/strapi');
const ownerRez = require('./lib/ownerrez-client');
const ghl = require('./lib/ghl-client');
const { createRemoteApp } = require('./lib/strapi-remote-client');

const LOOKBACK_HOURS = 48;
const ARRIVAL_WINDOW_DAYS = 14;
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
// separate OwnerRez call.
async function fetchPropertyType(propertyId) {
  const apiProperty = await ownerRez.getProperty(propertyId);
  return apiProperty.property_type;
}

// booking.door_codes is an array of {code, lock_names} - most properties
// have one lock, but this joins multiple readably rather than just taking
// the first and silently dropping the rest.
function extractDoorCode(booking) {
  const codes = booking.door_codes || [];
  if (codes.length === 0) return undefined;
  if (codes.length === 1) return codes[0].code;
  return codes.map((dc) => (dc.lock_names ? `${dc.lock_names}: ${dc.code}` : dc.code)).join('; ');
}

function nightsBetween(arrival, departure) {
  const ms = new Date(departure) - new Date(arrival);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

// booking.arrival/departure are the real stay dates. OwnerRez's own
// booking.check_in/check_out fields are just check-in/out *times* (e.g.
// "16:00") - unrelated to the Strapi schema's check_in/check_out date
// fields, which arrival/departure map onto instead.
function buildBookingFields(booking, guestContact) {
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
    lockbox_code: extractDoorCode(booking),
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

// contact.booking_channel_tag is a SINGLE_OPTIONS field with a fixed
// picklist (confirmed live: VRBO, Expedia, Airbnb, direct, Whimstay,
// HomestoGo, Other) - OwnerRez's listing_site casing doesn't always match
// (e.g. "Vrbo" vs "VRBO"), so this matches case-insensitively against the
// real options and falls back to the raw value for anything unrecognized
// (e.g. a future channel not yet in the picklist) rather than dropping it.
const BOOKING_CHANNEL_OPTIONS = ['VRBO', 'Expedia', 'Airbnb', 'direct', 'Whimstay', 'HomestoGo', 'Other'];
function normalizeBookingChannel(source) {
  if (!source) return source;
  return BOOKING_CHANNEL_OPTIONS.find((opt) => opt.toLowerCase() === source.toLowerCase()) || source;
}

async function syncToGhl(bookingFields, guestContact, propertyType) {
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
    // Real field keys confirmed live against the swflvacations GHL
    // location's custom-fields list on 2026-08-07 - the previous
    // checkin_date/checkout_date/reservation_number/booking_channel keys
    // used here didn't match any real field and were being silently
    // dropped by GHL's API since this script's very first version.
    customFields: [
      { key: 'date_check_in', field_value: bookingFields.check_in },
      { key: 'date_check_out', field_value: bookingFields.check_out },
      { key: 'property_booked', field_value: bookingFields.property_name },
      { key: 'property_type', field_value: propertyType },
      { key: 'door_code', field_value: bookingFields.lockbox_code },
      { key: 'booking_id', field_value: bookingFields.booking_id },
      { key: 'booking_channel_tag', field_value: normalizeBookingChannel(bookingFields.booking_source) },
    ].filter((f) => f.field_value !== undefined && f.field_value !== null),
  });
  return contact;
}

// The since_utc "new bookings" query matches anything OwnerRez reports as
// created *or changed* recently - and a booking can get touched (a note,
// a payment reconciliation, whatever) long after the guest has already
// stayed and left. Without this guard, a booking like that looks
// indistinguishable from a genuinely new one to the dedup check (it's never
// been in Strapi before) and would wrongly get tagged str_checkin_start for
// a guest who's already gone. Confirmed happening in production: booking
// #18526727 (departed Jul 31) got created and tagged on 2026-08-05 - the
// tag was manually removed from GHL afterward.
function hasAlreadyDeparted(booking) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(booking.departure) < today;
}

async function processBooking(app, booking, { dryRun }) {
  const ownerrezBookingId = String(booking.id);
  const existing = await app.documents('api::booking.booking').findFirst({
    filters: { ownerrez_booking_id: ownerrezBookingId },
  });
  if (existing) return { status: 'skipped' };

  const [guestContact, propertyType] = await Promise.all([
    fetchGuestContact(booking.guest_id),
    fetchPropertyType(booking.property_id),
  ]);
  const bookingFields = buildBookingFields(booking, guestContact);
  const departed = hasAlreadyDeparted(booking);

  if (dryRun) {
    console.log(
      `[sync] (dry run) would create booking #${ownerrezBookingId}${departed ? ' (already departed - GHL sync would be skipped)' : ''}:`
    );
    console.log(
      JSON.stringify(
        {
          ...bookingFields,
          guest_address: [guestContact.address1, guestContact.city, guestContact.state, guestContact.postalCode, guestContact.country]
            .filter(Boolean)
            .join(', '),
          property_type: propertyType,
        },
        null,
        2
      )
    );
    return { status: departed ? 'would-create-departed' : 'would-create' };
  }

  // Still mirrored into Strapi either way - this marks it seen so it's
  // never reconsidered on a later run, and keeps the booking history
  // complete - just never synced to GHL/tagged.
  await app.documents('api::booking.booking').create({ data: bookingFields });

  if (departed) {
    console.log(`[sync] created booking #${ownerrezBookingId} - guest already departed, GHL sync skipped`);
    return { status: 'created-departed' };
  }

  if (!bookingFields.guest_email && !bookingFields.guest_phone) {
    console.warn(`[sync] booking #${ownerrezBookingId} has no guest email or phone - Strapi record created, GHL sync skipped`);
    return { status: 'created-no-ghl' };
  }

  const contact = await syncToGhl(bookingFields, guestContact, propertyType);
  await ghl.addTags({ contactId: contact.id, tags: [CHECKIN_TAG] });
  console.log(
    `[sync] created booking #${ownerrezBookingId}, synced ${bookingFields.guest_email} to GHL, tagged ${CHECKIN_TAG}`
  );
  return { status: 'created' };
}

// Bookings made far ahead of arrival won't have a door code yet (OwnerRez
// only populates booking.door_codes close to the stay - confirmed against
// live data). This re-checks bookings arriving soon and, for any already in
// Strapi with no code yet, updates Strapi + the GHL custom field only - no
// addTags call, so it never re-fires the check-in workflow.
async function backfillDoorCode(app, booking, { dryRun }) {
  const doorCode = extractDoorCode(booking);
  if (!doorCode) return { status: 'no-code-yet' };

  const ownerrezBookingId = String(booking.id);
  const existing = await app.documents('api::booking.booking').findFirst({
    filters: { ownerrez_booking_id: ownerrezBookingId },
  });
  if (!existing || existing.lockbox_code) return { status: 'backfill-skipped' };

  if (dryRun) {
    console.log(`[sync] (dry run) would backfill door code for booking #${ownerrezBookingId}: ${doorCode}`);
    return { status: 'would-backfill' };
  }

  await app.documents('api::booking.booking').update({ documentId: existing.documentId, data: { lockbox_code: doorCode } });

  const contact = await findExistingGhlContact(existing);
  if (!contact) {
    console.warn(`[sync] booking #${ownerrezBookingId} backfilled in Strapi but has no GHL contact - GHL not updated`);
    return { status: 'backfilled-no-ghl' };
  }

  await ghl.updateContact(contact.id, { customFields: [{ key: 'door_code', field_value: doorCode }] });
  console.log(`[sync] backfilled door code for booking #${ownerrezBookingId} in Strapi + GHL`);
  return { status: 'backfilled' };
}

// Looks up the GHL contact by whichever identifier the booking record
// already has on file (email preferred, phone as fallback) - used instead
// of upsertContact for backfills so a newly-available identifier can't
// cause upsert's own matching to create a duplicate contact.
async function findExistingGhlContact(bookingRecord) {
  if (bookingRecord.guest_email) {
    const contact = await ghl.findContactByEmail(bookingRecord.guest_email);
    if (contact) return contact;
  }
  if (bookingRecord.guest_phone) {
    return ghl.findContactByPhone(bookingRecord.guest_phone);
  }
  return null;
}

// Guests sometimes add or correct their email/phone in OwnerRez after their
// booking was already synced (e.g. a guest reachable only by phone at
// booking time adds an email later). Re-checks bookings arriving soon
// (same window as the door-code backfill) and fills in whichever of
// email/phone was missing - never overwrites a value that's already set,
// and always refreshes the standard address fields alongside it since
// those were never persisted in Strapi to check for staleness. No addTags
// call, so this never re-fires the check-in workflow.
async function backfillGuestContact(app, booking, { dryRun }) {
  const ownerrezBookingId = String(booking.id);
  const existing = await app.documents('api::booking.booking').findFirst({
    filters: { ownerrez_booking_id: ownerrezBookingId },
  });
  if (!existing) return { status: 'contact-backfill-skipped' };
  if (existing.guest_email && existing.guest_phone) return { status: 'contact-backfill-skipped' };

  const guestContact = await fetchGuestContact(booking.guest_id);
  const newEmail = !existing.guest_email && guestContact.email ? guestContact.email : undefined;
  const newPhone = !existing.guest_phone && guestContact.phone ? guestContact.phone : undefined;
  if (!newEmail && !newPhone) return { status: 'contact-backfill-skipped' };

  if (dryRun) {
    console.log(
      `[sync] (dry run) would backfill contact info for booking #${ownerrezBookingId}: ${[
        newEmail && `email=${newEmail}`,
        newPhone && `phone=${newPhone}`,
      ]
        .filter(Boolean)
        .join(', ')}`
    );
    return { status: 'would-backfill-contact' };
  }

  await app.documents('api::booking.booking').update({
    documentId: existing.documentId,
    data: stripUndefined({ guest_email: newEmail, guest_phone: newPhone }),
  });

  const contact = await findExistingGhlContact(existing);
  if (!contact) {
    console.warn(`[sync] booking #${ownerrezBookingId} contact info backfilled in Strapi but no GHL contact found`);
    return { status: 'contact-backfilled-no-ghl' };
  }

  await ghl.updateContact(contact.id, {
    ...(newEmail ? { email: newEmail } : {}),
    ...(newPhone ? { phone: newPhone } : {}),
    ...(guestContact.address1 ? { address1: guestContact.address1 } : {}),
    ...(guestContact.city ? { city: guestContact.city } : {}),
    ...(guestContact.state ? { state: guestContact.state } : {}),
    ...(guestContact.postalCode ? { postalCode: guestContact.postalCode } : {}),
    ...(guestContact.country ? { country: guestContact.country } : {}),
  });
  console.log(`[sync] backfilled contact info for booking #${ownerrezBookingId} in Strapi + GHL`);
  return { status: 'contact-backfilled' };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --booking-id is for targeted manual testing of a specific booking that
  // may be outside the normal rolling window, so it widens the query instead
  // of relying on the 48h default.
  const lookbackHours = args.bookingIds.length > 0 ? 400 * 24 : LOOKBACK_HOURS;
  const sinceUtc = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  let newBookings = await ownerRez.listBookings({
    since_utc: sinceUtc,
    status: 'Active',
    include_guest: true,
    include_door_codes: true,
  });
  if (args.bookingIds.length > 0) {
    newBookings = newBookings.filter((b) => args.bookingIds.includes(String(b.id)));
  }

  const today = new Date();
  const windowEnd = new Date(today.getTime() + ARRIVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const arrivingSoonBookings = await ownerRez.listBookings({
    // OwnerRez requires since_utc (or property_ids) on every /bookings call
    // even when filtering by from/to - this is just to satisfy that, not a
    // real filter (from/to already scope this to the arrival window).
    since_utc: new Date('2020-01-01').toISOString(),
    from: isoDate(today),
    to: isoDate(windowEnd),
    status: 'Active',
    include_guest: true,
    include_door_codes: true,
  });

  if (newBookings.length === 0 && arrivingSoonBookings.length === 0) {
    console.log('[sync] nothing to sync');
    return;
  }

  const app = await bootApp(args.remote);
  const counts = {
    created: 0,
    'created-no-ghl': 0,
    'created-departed': 0,
    skipped: 0,
    'would-create': 0,
    'would-create-departed': 0,
    backfilled: 0,
    'backfilled-no-ghl': 0,
    'would-backfill': 0,
    'no-code-yet': 0,
    'backfill-skipped': 0,
    'contact-backfilled': 0,
    'contact-backfilled-no-ghl': 0,
    'would-backfill-contact': 0,
    'contact-backfill-skipped': 0,
    failed: 0,
  };
  try {
    for (const booking of newBookings) {
      try {
        const { status } = await processBooking(app, booking, { dryRun: args.dryRun });
        counts[status] += 1;
      } catch (err) {
        counts.failed += 1;
        console.error(`[sync] booking #${booking.id} failed, continuing with the rest: ${err.message}`);
      }
    }
    for (const booking of arrivingSoonBookings) {
      try {
        const { status } = await backfillDoorCode(app, booking, { dryRun: args.dryRun });
        counts[status] += 1;
      } catch (err) {
        counts.failed += 1;
        console.error(`[sync] door-code backfill for booking #${booking.id} failed, continuing with the rest: ${err.message}`);
      }
      try {
        const { status } = await backfillGuestContact(app, booking, { dryRun: args.dryRun });
        counts[status] += 1;
      } catch (err) {
        counts.failed += 1;
        console.error(`[sync] contact-info backfill for booking #${booking.id} failed, continuing with the rest: ${err.message}`);
      }
    }
  } finally {
    await app.destroy();
  }

  console.log(
    `[sync] new bookings (${newBookings.length}): ${counts.created} created+synced, ` +
      `${counts['created-no-ghl']} created without GHL (no email/phone), ${counts['created-departed']} created (guest already departed, GHL skipped), ` +
      `${counts.skipped} already synced, ${counts['would-create']} would-create (dry run), ` +
      `${counts['would-create-departed']} would-create-departed (dry run); ` +
      `arriving soon (${arrivingSoonBookings.length}): ${counts.backfilled} door codes backfilled, ` +
      `${counts['backfilled-no-ghl']} backfilled without GHL (no contact), ${counts['would-backfill']} would-backfill (dry run), ` +
      `${counts['no-code-yet']} no code yet, ${counts['backfill-skipped']} already had a code or no matching booking, ` +
      `${counts['contact-backfilled']} contact info backfilled, ${counts['contact-backfilled-no-ghl']} contact backfilled without GHL, ` +
      `${counts['would-backfill-contact']} would-backfill-contact (dry run), ${counts['contact-backfill-skipped']} contact already complete; ` +
      `${counts.failed} failed`
  );
  if (counts.failed > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[sync] failed:', err);
    process.exit(1);
  });
