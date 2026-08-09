'use strict';

// Signs a stay-page token binding it to an OwnerRez booking id (not the
// internal Strapi documentId, so the token stays stable across resyncs and
// never leaks an internal id). Format: <base64url(id)>.<base64url(hmac)> -
// verification (lib/stay-page-token.js in the frontend repo) recomputes the
// hmac from the same secret and rejects any mismatch, so a token can't be
// forged or enumerated without STAY_PAGE_TOKEN_SECRET.

const crypto = require('crypto');

function sign(ownerrezBookingId) {
  const secret = process.env.STAY_PAGE_TOKEN_SECRET;
  if (!secret) throw new Error('STAY_PAGE_TOKEN_SECRET is not set');
  const payload = Buffer.from(String(ownerrezBookingId)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${hmac}`;
}

module.exports = { sign };
