'use strict';

// GHL (GoHighLevel) sub-account "swflvacations" - same private-integration
// auth style as app/api/join-list/route.js and app/api/vendor-application/
// route.js in the swfl-vacations (Next.js) repo, ported here because this
// script runs on the self-hosted OwnerRez-sync runner, not on Vercel.
const GHL_LOCATION_ID = 'aWqMyGxVTia0ZOrUKcXG'; // SWFL Vacations sub-account
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

function requireToken() {
  const token = process.env.GHL_SWFL_PRIVATE_TOKEN;
  if (!token) {
    throw new Error('Missing required env var GHL_SWFL_PRIVATE_TOKEN - set it before running with --remote');
  }
  return token;
}

async function ghlRequest(method, path, body) {
  const res = await fetch(`${GHL_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      Version: GHL_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GHL ${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// Deliberately does NOT accept a `tags` field: GHL's upsert endpoint
// overwrites a contact's *entire* tag list rather than appending to it, so
// passing tags here would silently wipe any tags a repeat guest already has
// (newsletter signup, a prior stay, etc.). Use addTags() below instead.
async function upsertContact({
  firstName,
  lastName,
  email,
  phone,
  address1,
  city,
  state,
  postalCode,
  country,
  customFields,
}) {
  const data = await ghlRequest('POST', '/contacts/upsert', {
    locationId: GHL_LOCATION_ID,
    firstName,
    lastName,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address1 ? { address1 } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(country ? { country } : {}),
    ...(customFields ? { customFields } : {}),
  });
  return data.contact;
}

// The dedicated add-tags endpoint appends without touching existing tags.
async function addTags({ contactId, tags }) {
  return ghlRequest('POST', `/contacts/${contactId}/tags`, { tags });
}

async function findContactByEmail(email) {
  const data = await ghlRequest(
    'GET',
    `/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`
  );
  return data.contact || null;
}

async function findContactByPhone(phone) {
  const data = await ghlRequest(
    'GET',
    `/contacts/search/duplicate?locationId=${GHL_LOCATION_ID}&phone=${encodeURIComponent(phone)}`
  );
  return data.contact || null;
}

// Direct PUT by contact id, deliberately separate from upsertContact - used
// when the contact is already known (looked up by whichever identifier was
// on file before) so a newly-available identifier (e.g. an email added
// after the contact was first created by phone alone) can't cause upsert's
// own matching logic to create a duplicate instead of updating the right
// contact.
async function updateContact(contactId, fields) {
  const data = await ghlRequest('PUT', `/contacts/${contactId}`, fields);
  return data.contact;
}

module.exports = { upsertContact, addTags, findContactByEmail, findContactByPhone, updateContact, GHL_LOCATION_ID };
