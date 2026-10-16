/** Clear in-memory run data only after the upload operation has completed successfully. */
export async function uploadAndClearOnSuccess<T>(upload: () => Promise<T>, clear: () => void): Promise<T> {
  const result = await upload();
  clear();
  return result;
}
