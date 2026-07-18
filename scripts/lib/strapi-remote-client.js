'use strict';

const fs = require('fs');

// Exposes the same surface sync-ownerrez.js/photo-sync.js already call on a
// locally-booted Strapi instance (app.documents(uid), app.plugin('upload')...,
// app.log, app.destroy()) but backed by a remote instance's REST API + a
// bearer token instead of direct database access. This lets the same sync
// logic target either a local dev DB or a deployed Strapi Cloud project.

const PLURAL_ROUTES = {
  'api::property.property': 'properties',
  'api::amenity.amenity': 'amenities',
  'api::review.review': 'reviews',
  'api::property-image.property-image': 'property-images',
};

// Both property and property-image have draftAndPublish enabled. The REST
// API defaults to the *published* version for both reads and writes when no
// status is given - unlike the local Document Service, which defaults to
// draft - so without this, findFirst would never see our own drafts
// (creating duplicates on every re-run) and create would auto-publish
// instead of staying draft. A document's draft version exists regardless of
// whether it's ever been published, so querying status=draft is the
// reliable way to find an entry either way. photo-sync.js explicitly
// publishes each property-image right after finding/creating it, since
// unlike property it has no independent editorial review step.
const DRAFT_UIDS = new Set(['api::property.property', 'api::property-image.property-image']);

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value === 'tobemodified') {
    throw new Error(`Missing required env var ${name} - set it in .env before running with --remote`);
  }
  return value;
}

function baseUrl() {
  return requireEnv('STRAPI_URL').replace(/\/$/, '');
}

function authHeader() {
  return `Bearer ${requireEnv('STRAPI_API_TOKEN')}`;
}

// Serializes nested objects/arrays into Strapi's bracket query-string
// convention, e.g. { filters: { name: { $eqi: 'Wifi' } } } ->
// "filters[name][$eqi]=Wifi".
function serializeParams(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) {
      parts.push(serializeParams(value, paramKey));
    } else {
      parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

async function request(method, path, { query, body } = {}) {
  const qs = query ? serializeParams(query) : '';
  const url = `${baseUrl()}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Strapi remote ${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function documents(uid) {
  const plural = PLURAL_ROUTES[uid];
  if (!plural) throw new Error(`strapi-remote-client: unknown content-type uid "${uid}"`);
  const collectionPath = `/api/${plural}`;
  const draft = DRAFT_UIDS.has(uid);

  return {
    async findFirst({ filters, populate } = {}) {
      const query = { 'pagination[pageSize]': 1 };
      if (draft) query.status = 'draft';
      if (filters) query.filters = filters;
      if (populate) query.populate = populate;
      const json = await request('GET', collectionPath, { query });
      return json.data && json.data.length > 0 ? json.data[0] : null;
    },
    async create({ data }) {
      const json = await request('POST', collectionPath, { query: draft ? { status: 'draft' } : undefined, body: { data } });
      return json.data;
    },
    async update({ documentId, data }) {
      const json = await request('PUT', `${collectionPath}/${documentId}`, {
        query: draft ? { status: 'draft' } : undefined,
        body: { data },
      });
      return json.data;
    },
    async publish({ documentId }) {
      const json = await request('PUT', `${collectionPath}/${documentId}`, {
        query: { status: 'published' },
        body: { data: {} },
      });
      return json.data;
    },
    // Pages through the full result set - callers (photo cleanup) need every
    // matching record, not just the first page's worth.
    async findMany({ filters, populate, fields } = {}) {
      const pageSize = 100;
      let page = 1;
      const all = [];
      for (;;) {
        const query = { 'pagination[page]': page, 'pagination[pageSize]': pageSize };
        if (draft) query.status = 'draft';
        if (filters) query.filters = filters;
        if (populate) query.populate = populate;
        if (fields) query.fields = fields;
        const json = await request('GET', collectionPath, { query });
        all.push(...(json.data || []));
        const pageCount = json.meta?.pagination?.pageCount || 1;
        if (page >= pageCount) break;
        page += 1;
      }
      return all;
    },
    async delete({ documentId }) {
      await request('DELETE', `${collectionPath}/${documentId}`, {});
    },
  };
}

async function uploadFile({ filepath, originalFilename, mimetype }) {
  const buffer = fs.readFileSync(filepath);
  const form = new FormData();
  form.append('files', new Blob([buffer], { type: mimetype }), originalFilename);

  const res = await fetch(`${baseUrl()}/api/upload`, {
    method: 'POST',
    headers: { Authorization: authHeader() },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Strapi remote upload -> ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

function createRemoteApp() {
  return {
    log: { level: 'error' },
    documents,
    plugin(name) {
      if (name !== 'upload') throw new Error(`strapi-remote-client only supports the "upload" plugin, got "${name}"`);
      return {
        service(serviceName) {
          if (serviceName !== 'upload') {
            throw new Error(`strapi-remote-client only supports the "upload" service, got "${serviceName}"`);
          }
          return { upload: async ({ files }) => uploadFile(files) };
        },
      };
    },
    async destroy() {},
  };
}

module.exports = { createRemoteApp };
