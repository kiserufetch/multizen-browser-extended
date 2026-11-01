/** The pixel size in a JPEG's start-of-frame marker. Null if there isn't one. */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 <= jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1]!;
    // SOF0 to SOF15, without DHT (c4), JPG (c8) and DAC (cc), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (jpeg[at + 5]! << 8) | jpeg[at + 6]!,
        width: (jpeg[at + 7]! << 8) | jpeg[at + 8]!,
      };
    }
    at += 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!);
  }
  return null;
}
