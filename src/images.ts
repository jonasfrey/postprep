/**
 * Image metadata sniffing for the formats a browser can render.
 *
 * The server never decodes pixels: it only reads the intrinsic size out of the
 * container header so that uploads can be validated and the client can lay
 * images out without a second round trip. PNG / JPEG / GIF / WebP are supported.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface SniffedImage {
  type: ImageType;
  width: number;
  height: number;
}

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const EXTENSIONS: Record<ImageType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function extensionFor(type: ImageType): string {
  return EXTENSIONS[type];
}

export function isImageType(value: string): value is ImageType {
  return value in EXTENSIONS;
}

/** Detect the image type and intrinsic size, or return null when unsupported. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes) ?? sniffJpeg(bytes);
}

function sniffPng(b: Uint8Array): SniffedImage | null {
  if (b.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (b[i] !== signature[i]) return null;
  }
  // The first chunk of a valid PNG must be IHDR.
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const width = readUint32BE(b, 16);
  const height = readUint32BE(b, 20);
  if (width <= 0 || height <= 0) return null;
  return { type: "image/png", width, height };
}

function sniffGif(b: Uint8Array): SniffedImage | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x38) return null;
  if (b[4] !== 0x37 && b[4] !== 0x39) return null;
  if (b[5] !== 0x61) return null;
  const width = readUint16LE(b, 6);
  const height = readUint16LE(b, 8);
  if (width <= 0 || height <= 0) return null;
  return { type: "image/gif", width, height };
}

function sniffWebp(b: Uint8Array): SniffedImage | null {
  if (b.length < 30) return null;
  if (!(b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46)) return null; // RIFF
  if (!(b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)) return null; // WEBP
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  const p = 20; // start of the first chunk payload
  if (fourcc === "VP8X") {
    const width = readUint24LE(b, p + 4) + 1;
    const height = readUint24LE(b, p + 7) + 1;
    return { type: "image/webp", width, height };
  }
  if (fourcc === "VP8L") {
    if (b[p] !== 0x2f) return null;
    const bits = readUint32LE(b, p + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { type: "image/webp", width, height };
  }
  if (fourcc === "VP8 ") {
    // 3 byte frame tag, 3 byte start code, then 16 bit dimensions.
    const width = readUint16LE(b, p + 6) & 0x3fff;
    const height = readUint16LE(b, p + 8) & 0x3fff;
    if (!width || !height) return null;
    return { type: "image/webp", width, height };
  }
  return null;
}

function sniffJpeg(b: Uint8Array): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = b[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    const size = readUint16BE(b, offset + 2);
    if (size < 2) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = readUint16BE(b, offset + 5);
      const width = readUint16BE(b, offset + 7);
      if (!width || !height) return null;
      return { type: "image/jpeg", width, height };
    }
    offset += 2 + size;
  }
  return null;
}

function readUint16BE(b: Uint8Array, offset: number): number {
  return (b[offset] << 8) | b[offset + 1];
}

function readUint16LE(b: Uint8Array, offset: number): number {
  return b[offset] | (b[offset + 1] << 8);
}

function readUint32BE(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
}

function readUint32LE(b: Uint8Array, offset: number): number {
  return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0;
}

function readUint24LE(b: Uint8Array, offset: number): number {
  return b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16);
}
