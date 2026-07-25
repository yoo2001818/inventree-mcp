import { hashToken, randomToken } from "./crypto.js";
import { DomainError } from "./domainErrors.js";

export interface ImageMetadata {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  extension: "png" | "jpg" | "gif" | "webp";
  width: number;
  height: number;
  byteSize: number;
}

export interface StoredPartImage extends ImageMetadata {
  ref: string;
  credentialsId: string;
  filename: string;
  bytes: Buffer;
}

const UPLOAD_TTL_MS = 30 * 60_000;
const DOWNLOAD_TTL_MS = 10 * 60_000;

interface UploadSession {
  ref: string;
  credentialsId: string;
  tokenHash: string;
  filenameHint?: string;
  createdAt: number;
  expiresAt: number;
  image?: StoredPartImage;
}

export interface DownloadSession {
  credentialsId: string;
  mediaPath: string;
  filename: string;
  expiresAt: number;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (length >= 8 && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

export function inspectImage(bytes: Buffer): ImageMetadata {
  let detected: Omit<ImageMetadata, "byteSize"> | undefined;
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    detected = { mimeType: "image/png", extension: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    detected = { mimeType: "image/gif", extension: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } else if (bytes.length >= 12 && bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    const dimensions = jpegDimensions(bytes);
    if (dimensions) detected = { mimeType: "image/jpeg", extension: "jpg", ...dimensions };
  } else if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    bytes.subarray(12, 16).toString("ascii") === "VP8X"
  ) {
    detected = {
      mimeType: "image/webp",
      extension: "webp",
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (!detected || detected.width <= 0 || detected.height <= 0) {
    throw new DomainError({ status: "invalid_image" }, "The upload is not a supported PNG, JPEG, GIF, or extended WebP image.");
  }
  return { ...detected, byteSize: bytes.length };
}

function safeFilename(value: string | undefined, extension: ImageMetadata["extension"]): string {
  const basename = (value ?? "part-image")
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120)
    .replace(/\.[^.]*$/, "");
  return `${basename || "part-image"}.${extension}`;
}

export class PartImageUploads {
  private readonly uploads = new Map<string, UploadSession>();
  private readonly uploadTokens = new Map<string, string>();
  private readonly downloads = new Map<string, DownloadSession>();

  constructor(
    readonly maxBytes: number,
    readonly maxPixels: number,
  ) {}

  prepare(credentialsId: string, filenameHint?: string): { uploadRef: string; token: string; expiresAt: number } {
    this.cleanup();
    const activeForCredentials = [...this.uploads.values()].filter((upload) => upload.credentialsId === credentialsId);
    if (activeForCredentials.length >= 4) {
      throw new DomainError(
        { status: "upload_limit", maximum_active_uploads: 4 },
        "Four image uploads are already pending for this credential link. Commit one or wait for an upload to expire.",
      );
    }
    const now = Date.now();
    const ref = `upload_${randomToken(18).replace(/[^a-zA-Z0-9]/g, "")}`;
    const token = randomToken(32);
    const session: UploadSession = {
      ref,
      credentialsId,
      tokenHash: hashToken(token),
      ...(filenameHint ? { filenameHint } : {}),
      createdAt: now,
      expiresAt: now + UPLOAD_TTL_MS,
    };
    this.uploads.set(ref, session);
    this.uploadTokens.set(session.tokenHash, ref);
    return { uploadRef: ref, token, expiresAt: session.expiresAt };
  }

  complete(token: string, bytes: Buffer, claimedMimeType?: string, filename?: string): StoredPartImage {
    this.cleanup();
    const tokenHash = hashToken(token);
    const ref = this.uploadTokens.get(tokenHash);
    const session = ref ? this.uploads.get(ref) : undefined;
    if (!session) {
      throw new DomainError({ status: "not_found", entity_type: "image_upload_session" }, "The signed image-upload URL is invalid or expired.");
    }
    if (session.image) throw new DomainError({ status: "conflict", conflict_type: "upload_already_complete" }, "This signed image-upload URL has already been used.");
    if (bytes.length === 0) throw new DomainError({ status: "invalid_image" }, "The image upload was empty.");
    if (bytes.length > this.maxBytes) {
      throw new DomainError({ status: "image_too_large", max_bytes: this.maxBytes }, `The image exceeds the ${this.maxBytes}-byte upload limit.`);
    }
    const metadata = inspectImage(bytes);
    if (claimedMimeType && claimedMimeType !== "application/octet-stream" && claimedMimeType !== metadata.mimeType) {
      throw new DomainError(
        { status: "invalid_image", claimed_mime_type: claimedMimeType, detected_mime_type: metadata.mimeType },
        `The declared content type ${claimedMimeType} does not match the detected ${metadata.mimeType} image.`,
      );
    }
    if (metadata.width * metadata.height > this.maxPixels) {
      throw new DomainError(
        { status: "image_too_large", max_pixels: this.maxPixels, width: metadata.width, height: metadata.height },
        `The image dimensions ${metadata.width}x${metadata.height} exceed the configured pixel limit.`,
      );
    }
    const upload: StoredPartImage = {
      ...metadata,
      ref: session.ref,
      credentialsId: session.credentialsId,
      filename: safeFilename(filename ?? session.filenameHint, metadata.extension),
      bytes: Buffer.from(bytes),
    };
    session.image = upload;
    return upload;
  }

  get(ref: string, credentialsId: string): StoredPartImage {
    this.cleanup();
    const session = this.uploads.get(ref);
    if (!session || session.credentialsId !== credentialsId) {
      throw new DomainError(
        { status: "not_found", entity_type: "image_upload", upload_ref: ref },
        "The image upload was not found, expired, or belongs to another credential link.",
      );
    }
    if (!session.image) {
      throw new DomainError(
        { status: "upload_pending", entity_type: "image_upload", upload_ref: ref },
        "The image upload is still pending. Open the signed upload URL and select a file first.",
      );
    }
    return session.image;
  }

  status(ref: string, credentialsId: string): { status: "pending" | "ready"; expiresAt: number; image?: StoredPartImage } {
    this.cleanup();
    const session = this.uploads.get(ref);
    if (!session || session.credentialsId !== credentialsId) {
      throw new DomainError({ status: "not_found", entity_type: "image_upload", upload_ref: ref }, "The image upload was not found or expired.");
    }
    return { status: session.image ? "ready" : "pending", expiresAt: session.expiresAt, ...(session.image ? { image: session.image } : {}) };
  }

  uploadSession(token: string): { status: "pending" | "ready"; expiresAt: number } {
    this.cleanup();
    const ref = this.uploadTokens.get(hashToken(token));
    const session = ref ? this.uploads.get(ref) : undefined;
    if (!session) throw new DomainError({ status: "not_found", entity_type: "image_upload_session" }, "The signed image-upload URL is invalid or expired.");
    return { status: session.image ? "ready" : "pending", expiresAt: session.expiresAt };
  }

  prepareDownload(credentialsId: string, mediaPath: string, filename: string): { token: string; expiresAt: number } {
    this.cleanup();
    const token = randomToken(32);
    const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
    this.downloads.set(hashToken(token), { credentialsId, mediaPath, filename, expiresAt });
    return { token, expiresAt };
  }

  download(token: string): DownloadSession {
    this.cleanup();
    const session = this.downloads.get(hashToken(token));
    if (!session) throw new DomainError({ status: "not_found", entity_type: "image_download" }, "The signed image-download URL is invalid or expired.");
    return session;
  }

  remove(ref: string): void {
    const session = this.uploads.get(ref);
    if (session) this.uploadTokens.delete(session.tokenHash);
    this.uploads.delete(ref);
  }

  cleanup(now = Date.now()): void {
    for (const [ref, session] of this.uploads) {
      if (session.expiresAt <= now) {
        this.uploadTokens.delete(session.tokenHash);
        this.uploads.delete(ref);
      }
    }
    for (const [tokenHash, session] of this.downloads) {
      if (session.expiresAt <= now) this.downloads.delete(tokenHash);
    }
  }
}
