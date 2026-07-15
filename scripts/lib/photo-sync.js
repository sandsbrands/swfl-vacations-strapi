'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// OwnerRez photo URLs look like https://uc.orez.io/i/<hash>-Large - the hash
// is a stable per-photo id even though the API doesn't expose one directly.
function extractPhotoId(photo) {
  const url = photo.large_url || photo.original_url || photo.cropped_url || '';
  const match = url.match(/\/i\/([a-f0-9]+)-/i);
  if (match) return match[1];
  return crypto.createHash('md5').update(url).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// OwnerRez's image CDN occasionally returns transient 5xx errors under load -
// retry those a few times with backoff before giving up on this photo.
async function downloadToTempFile(url, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? '.png' : '.jpg';
      const tmpPath = path.join(os.tmpdir(), `ownerrez-photo-${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tmpPath, buffer);
      return { tmpPath, size: buffer.length, mime: contentType };
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(attempt * 1000);
    }
  }
  throw new Error(`Failed to download photo ${url} after ${attempts} attempts: ${lastError.message}`);
}

// property-image has draftAndPublish enabled but no independent editorial
// workflow - it should always be visible once its parent property is
// published, regardless of the property's own draft/publish state. Since
// there's no way to disable draftAndPublish without risking a destructive
// migration (confirmed locally: toggling it wiped the whole table), we
// instead just publish every property-image immediately, and backfill any
// pre-existing ones this sync finds still unpublished.
async function ensurePublished(app, doc) {
  if (doc.publishedAt) return;
  await app.documents('api::property-image.property-image').publish({ documentId: doc.documentId });
}

// Downloads and uploads any photos not already synced (matched by
// ownerrez_photo_id), creates a property-image per new photo, and sets
// property.featured_image from the first photo if it isn't set already.
async function syncPhotos(app, propertyDoc, photos = []) {
  if (photos.length === 0) return { created: 0, skipped: 0 };

  let created = 0;
  let skipped = 0;
  let failed = 0;
  let backfillPublished = 0;
  let firstImageFileId = null;

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const ownerrezPhotoId = extractPhotoId(photo);

    const existing = await app.documents('api::property-image.property-image').findFirst({
      filters: { ownerrez_photo_id: ownerrezPhotoId },
      populate: ['image'],
    });

    if (existing) {
      skipped += 1;
      if (!existing.publishedAt) {
        await ensurePublished(app, existing);
        backfillPublished += 1;
      }
      if (index === 0 && existing.image) firstImageFileId = existing.image.id;
      continue;
    }

    const sourceUrl = photo.large_url || photo.original_url || photo.cropped_url;
    if (!sourceUrl) continue;

    try {
      const { tmpPath, size, mime } = await downloadToTempFile(sourceUrl);
      try {
        const [uploaded] = await app.plugin('upload').service('upload').upload({
          data: {},
          files: {
            filepath: tmpPath,
            originalFilename: `${ownerrezPhotoId}${path.extname(tmpPath)}`,
            mimetype: mime,
            size,
          },
        });

        const createdImage = await app.documents('api::property-image.property-image').create({
          data: {
            image: uploaded.id,
            caption: photo.caption,
            alt_text: photo.caption,
            ownerrez_photo_id: ownerrezPhotoId,
            sort_order: index,
            property: propertyDoc.documentId,
          },
        });
        await ensurePublished(app, createdImage);

        created += 1;
        if (index === 0) firstImageFileId = uploaded.id;
      } finally {
        fs.unlinkSync(tmpPath);
      }
    } catch (err) {
      failed += 1;
      console.warn(`[sync] photo ${ownerrezPhotoId} failed, skipping: ${err.message}`);
    }
  }

  if (firstImageFileId && !propertyDoc.featured_image) {
    await app.documents('api::property.property').update({
      documentId: propertyDoc.documentId,
      data: { featured_image: firstImageFileId },
    });
  }

  console.log(
    `[sync] photos: created ${created}, already synced ${skipped} (${backfillPublished} backfill-published), failed ${failed}`
  );
  return { created, skipped, failed, backfillPublished };
}

module.exports = { syncPhotos, extractPhotoId };
