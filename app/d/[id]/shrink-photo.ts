// Shrinks a label photo in the browser before it is sent (Part B, label photo): at most 1600 px on
// the long side, re-encoded as JPEG. That keeps the upload small and drops everything the file
// carried besides the pixels (location, camera, time), because only the drawn image is re-encoded.
// No dependency: the browser's own image decoder and canvas.

export const MAX_SIDE = 1600;

export class PhotoError extends Error {}

export async function shrinkPhoto(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // Honours the photo's orientation, so a phone photo taken sideways is upright.
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PhotoError("This browser can't open that kind of photo. Choose a JPEG or PNG photo, or a screenshot of the label.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError("This browser can't prepare the photo.");
  // A white backing, so a transparent PNG doesn't turn black as a JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new PhotoError("This browser can't prepare the photo.");
  return blob;
}
