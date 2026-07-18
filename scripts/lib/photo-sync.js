'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// OwnerRez photo URLs look like https://uc.orez.io/i/<hash>-Large. This hash
// is stable per "slot" in OwnerRez's photo list, but NOT a content
// fingerprint - confirmed live (2026-07-18) that deleting all photos and
// re-uploading new ones on a listing can hand back the exact same hashes
// for entirely different images. So this is only used to find "the record
// that used to occupy this slot", never to decide whether content changed -
// that's what content_hash (a real md5 of the downloaded bytes) is for.
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
      return {
        tmpPath,
        size: buffer.length,
        mime: contentType,
        contentHash: crypto.createHash('md5').update(buffer).digest('hex'),
      };
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

// Downloads every current OwnerRez photo exactly once, comparing actual
// content (not just the OwnerRez URL hash - see extractPhotoId) against
// what's already synced: new slot -> create, same slot + same content ->
// skip, same slot + changed content -> re-upload and update in place. Any
// previously-synced photo whose slot no longer appears in OwnerRez's current
// photo list is deleted (handles photos removed/replaced, not just added).
async function syncPhotos(app, propertyDoc, photos = []) {
  const propertyImages = app.documents('api::property-image.property-image');

  const existing = await propertyImages.findMany({
    filters: { property: { documentId: propertyDoc.documentId } },
    populate: ['image'],
  });
  const existingByPhotoId = new Map(existing.map((doc) => [doc.ownerrez_photo_id, doc]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let deleted = 0;
  let backfillPublished = 0;
  let firstImageFileId = null;

  const currentPhotoIds = new Set();

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const ownerrezPhotoId = extractPhotoId(photo);
    currentPhotoIds.add(ownerrezPhotoId);

    const sourceUrl = photo.large_url || photo.original_url || photo.cropped_url;
    if (!sourceUrl) continue;

    const existingDoc = existingByPhotoId.get(ownerrezPhotoId);

    let dl;
    try {
      dl = await downloadToTempFile(sourceUrl);
    } catch (err) {
      failed += 1;
      console.warn(`[sync] photo ${ownerrezPhotoId} failed, skipping: ${err.message}`);
      continue;
    }

    try {
      if (existingDoc && existingDoc.content_hash === dl.contentHash) {
        skipped += 1;
        if (!existingDoc.publishedAt) {
          await ensurePublished(app, existingDoc);
          backfillPublished += 1;
        }
        if (index === 0 && existingDoc.image) firstImageFileId = existingDoc.image.id;
        continue;
      }

      const [uploaded] = await app.plugin('upload').service('upload').upload({
        data: {},
        files: {
          filepath: dl.tmpPath,
          originalFilename: `${ownerrezPhotoId}${path.extname(dl.tmpPath)}`,
          mimetype: dl.mime,
          size: dl.size,
        },
      });

      if (existingDoc) {
        // Same slot, different image content - OwnerRez reused this hash
        // for a photo that isn't the one we already have. Update in place
        // rather than leaving a stale duplicate.
        await propertyImages.update({
          documentId: existingDoc.documentId,
          data: {
            image: uploaded.id,
            caption: photo.caption,
            alt_text: photo.caption,
            sort_order: index,
            content_hash: dl.contentHash,
          },
        });
        await ensurePublished(app, existingDoc);
        updated += 1;
      } else {
        const createdImage = await propertyImages.create({
          data: {
            image: uploaded.id,
            caption: photo.caption,
            alt_text: photo.caption,
            ownerrez_photo_id: ownerrezPhotoId,
            content_hash: dl.contentHash,
            sort_order: index,
            property: propertyDoc.documentId,
          },
        });
        await ensurePublished(app, createdImage);
        created += 1;
      }
      if (index === 0) firstImageFileId = uploaded.id;
    } catch (err) {
      failed += 1;
      console.warn(`[sync] photo ${ownerrezPhotoId} failed, skipping: ${err.message}`);
    } finally {
      fs.unlinkSync(dl.tmpPath);
    }
  }

  // Anything synced before that OwnerRez no longer lists for this property
  // (deleted, not just replaced) has no place in currentPhotoIds - remove it.
  for (const doc of existing) {
    if (!currentPhotoIds.has(doc.ownerrez_photo_id)) {
      await propertyImages.delete({ documentId: doc.documentId });
      deleted += 1;
    }
  }

  // The first photo's underlying file changed (created or updated) - the
  // featured image should follow it rather than keep pointing at whatever
  // was there before, stale or not.
  if (firstImageFileId) {
    await app.documents('api::property.property').update({
      documentId: propertyDoc.documentId,
      data: { featured_image: firstImageFileId },
    });
  }

  console.log(
    `[sync] photos: created ${created}, updated ${updated}, already synced ${skipped} (${backfillPublished} backfill-published), deleted ${deleted}, failed ${failed}`
  );
  return { created, updated, skipped, deleted, failed, backfillPublished };
}

module.exports = { syncPhotos, extractPhotoId };
