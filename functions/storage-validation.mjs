// Server-side only, after authorization and storage.download(serverOwnedPath).
// Content-Type is metadata validation, not a malware or file-format inspection.
export async function verifyUploadedObject(response, { maxBytes, expectedBytes, allowedContentTypes, timeoutMs = 15000 }) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  let reader, timer, timedOut = false;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(expectedBytes)
      || expectedBytes < 0 || expectedBytes > maxBytes || !Array.isArray(allowedContentTypes)
      || allowedContentTypes.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('upload_validation_invalid');
    if (!response.ok || !response.body) throw new Error('upload_object_unavailable');
    if (!allowedContentTypes.includes(type)) throw new Error('upload_type_mismatch');
    reader = response.body.getReader();
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, timeoutMs);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new Error('upload_validation_timeout');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('upload_too_large');
    }
    if (size !== expectedBytes) throw new Error('upload_size_mismatch');
    return { size, contentType: type };
  } finally {
    clearTimeout(timer);
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      await response.body?.cancel().catch(() => {});
    }
  }
}
