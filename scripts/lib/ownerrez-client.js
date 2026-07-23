'use strict';

const DEFAULT_BASE_URL = 'https://api.ownerrez.com/v2';

// OwnerRez v2 API (https://api.ownerrez.com/help/v2) auth: HTTP Basic with
// the account's API Key as the username and API Token as the password
// (both generated on the API settings page in the OwnerRez account).
function requireEnv(name) {
  const value = process.env[name];
  if (!value || value === 'tobemodified') {
    throw new Error(`Missing required env var ${name} - set it in .env before running the OwnerRez sync`);
  }
  return value;
}

function authHeader() {
  const apiKey = requireEnv('OWNERREZ_API_KEY');
  const apiToken = requireEnv('OWNERREZ_API_TOKEN');
  const encoded = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
  return `Basic ${encoded}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || attempt * 2;
      console.warn(`[ownerrez] rate limited on ${url}, retrying in ${retryAfter}s (attempt ${attempt}/5)`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OwnerRez API ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`);
    }

    return res.json();
  }

  throw new Error(`OwnerRez API rate-limited too many times for ${url}`);
}

function buildUrl(path, searchParams = {}) {
  const baseUrl = process.env.OWNERREZ_API_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

// Handles both pagination styles documented across OwnerRez v2 list
// endpoints: cursor-based via `next_page_url` (e.g. reviews) and
// offset/limit/count based (e.g. properties).
async function fetchAllPages(path, params = {}) {
  const items = [];
  let url = buildUrl(path, params);

  while (url) {
    const data = await requestJson(url);
    const pageItems = data.items || data.results || [];
    items.push(...pageItems);

    if (data.next_page_url) {
      // OwnerRez returns this as a root-relative path (e.g. "/v2/reviews?...")
      // rather than an absolute URL, so resolve it against the API origin.
      const origin = new URL(process.env.OWNERREZ_API_BASE_URL || DEFAULT_BASE_URL).origin;
      url = new URL(data.next_page_url, origin);
      continue;
    }

    if (typeof data.count === 'number' && typeof data.limit === 'number' && pageItems.length > 0) {
      const seenSoFar =
        (typeof data.offset === 'number' ? data.offset : items.length - pageItems.length) + pageItems.length;
      if (seenSoFar >= data.count) break;
      url = buildUrl(path, { ...params, offset: seenSoFar });
      continue;
    }

    break;
  }

  return items;
}

async function getProperty(propertyId) {
  return requestJson(buildUrl(`properties/${propertyId}`));
}

async function listProperties(params = {}) {
  return fetchAllPages('properties', params);
}

async function getListing(listingId) {
  return requestJson(buildUrl(`listings/${listingId}`));
}

async function listReviewsForProperty(propertyId) {
  return fetchAllPages('reviews', { property_id: propertyId });
}

async function listTagsForProperty(propertyId) {
  return fetchAllPages('tags', { entity_type: 'property', entity_id: propertyId });
}

module.exports = {
  getProperty,
  listProperties,
  getListing,
  listReviewsForProperty,
  listTagsForProperty,
};
