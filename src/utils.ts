export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), x => x.toString(16).padStart(2, '0')).join('');
}
// A grouping key, not a cryptographic identity or security boundary.
export function fingerprint(value: unknown): string {
  const input = JSON.stringify(value);
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < input.length; i++) {
    a = Math.imul(a ^ input.charCodeAt(i), 16777619);
    b = Math.imul(b ^ input.charCodeAt(i), 3266489917);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
export const unref = (timer: ReturnType<typeof setTimeout>): void => {
  (timer as unknown as { unref?: () => void }).unref?.();
};
