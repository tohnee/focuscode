import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ImageAttachment } from "./types.js";

export interface ImageLoadOptions {
  cwd: string;
  allowOutsideWorkspace?: boolean;
  allowRemoteUrls?: boolean;
  maxBytes?: number;
}

export async function loadImageAttachment(
  source: string,
  options: ImageLoadOptions,
): Promise<ImageAttachment> {
  if (/^https:\/\//i.test(source)) {
    if (options.allowRemoteUrls === false) {
      throw new Error("Remote image URLs are disabled by policy; download the image locally first");
    }
    const url = new URL(source);
    if (url.username || url.password) throw new Error("Image URLs must not contain credentials");
    const mediaType = mediaTypeFromPath(url.pathname);
    if (!mediaType) throw new Error("Image URL must end in png, jpg, jpeg, webp or gif");
    return {
      type: "image",
      id: "image_" + randomUUID(),
      name: basename(url.pathname) || "remote-image",
      mediaType,
      sizeBytes: 0,
      source: { type: "url", url: url.toString() },
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new Error("Only HTTPS image URLs and local files are supported");
  }
  const root = await realpath(resolve(options.cwd));
  const requested = resolve(options.cwd, source);
  const path = await realpath(requested);
  if (!options.allowOutsideWorkspace) assertInside(root, path);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Image is not a regular file: " + source);
  const maximum = options.maxBytes ?? 20_000_000;
  if (info.size > maximum) throw new Error("Image exceeds " + maximum + " bytes: " + source);
  const data = await readFile(path);
  const mediaType = sniffImageType(data);
  if (!mediaType) throw new Error("Unsupported or invalid image: " + source);
  const digest = createHash("sha256").update(data).digest("hex");
  return {
    type: "image",
    id: "image_" + digest.slice(0, 24),
    name: basename(path),
    mediaType,
    sizeBytes: data.length,
    source: { type: "base64", data: data.toString("base64") },
    sha256: digest,
  };
}

export async function loadImageAttachments(
  sources: string[],
  options: ImageLoadOptions & { maxTotalBytes?: number; maxImages?: number },
): Promise<ImageAttachment[]> {
  const maximumImages = options.maxImages ?? 10;
  if (sources.length > maximumImages)
    throw new Error("At most " + maximumImages + " images may be attached");
  const attachments: ImageAttachment[] = [];
  let total = 0;
  for (const source of sources) {
    const attachment = await loadImageAttachment(source, options);
    total += attachment.sizeBytes;
    if (total > (options.maxTotalBytes ?? 40_000_000)) {
      throw new Error("Image attachments exceed total size limit");
    }
    attachments.push(attachment);
  }
  return attachments;
}

export function validateImageAttachment(
  value: unknown,
  options: { maxBytes?: number } = {},
): ImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Image attachment must be an object");
  }
  const attachment = value as Record<string, unknown>;
  if (attachment.type !== "image") throw new Error("Unsupported attachment type");
  if (typeof attachment.id !== "string" || !/^image_[A-Za-z0-9_-]{1,160}$/.test(attachment.id)) {
    throw new Error("Invalid image attachment id");
  }
  if (typeof attachment.name !== "string" || !/^[^\0\r\n]{1,160}$/.test(attachment.name)) {
    throw new Error("Invalid image attachment name");
  }
  if (!isImageMediaType(attachment.mediaType)) throw new Error("Unsupported image media type");
  if (
    typeof attachment.sizeBytes !== "number" ||
    !Number.isSafeInteger(attachment.sizeBytes) ||
    attachment.sizeBytes < 0
  ) {
    throw new Error("Invalid image attachment size");
  }
  if (
    attachment.detail !== undefined &&
    !["auto", "low", "high"].includes(String(attachment.detail))
  ) {
    throw new Error("Invalid image detail");
  }
  const source = attachment.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Invalid image source");
  }
  const sourceRecord = source as Record<string, unknown>;
  const maximum = options.maxBytes ?? 20_000_000;
  if (sourceRecord.type === "url") {
    if (typeof sourceRecord.url !== "string") throw new Error("Invalid image URL");
    const url = new URL(sourceRecord.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Image URL must use HTTPS without embedded credentials");
    }
    if (attachment.sizeBytes > maximum) throw new Error("Image exceeds " + maximum + " bytes");
  } else if (sourceRecord.type === "base64") {
    if (
      typeof sourceRecord.data !== "string" ||
      sourceRecord.data.length > Math.ceil(maximum / 3) * 4 + 4 ||
      sourceRecord.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(sourceRecord.data)
    ) {
      throw new Error("Invalid image base64 data");
    }
    const decoded = Buffer.from(sourceRecord.data, "base64");
    if (decoded.length > maximum || decoded.length !== attachment.sizeBytes) {
      throw new Error("Image attachment size does not match its data");
    }
    if (sniffImageType(decoded) !== attachment.mediaType) {
      throw new Error("Image attachment media type does not match its data");
    }
    if (attachment.sha256 !== undefined) {
      const digest = createHash("sha256").update(decoded).digest("hex");
      if (attachment.sha256 !== digest) throw new Error("Image attachment digest mismatch");
    }
  } else {
    throw new Error("Unsupported image source");
  }
  return structuredClone(value) as ImageAttachment;
}

export function validateImageAttachments(
  value: unknown,
  options: { maxBytes?: number; maxTotalBytes?: number; maxImages?: number } = {},
): ImageAttachment[] {
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  const maximumImages = options.maxImages ?? 10;
  if (value.length > maximumImages)
    throw new Error("At most " + maximumImages + " images may be attached");
  let total = 0;
  return value.map((item) => {
    const attachment = validateImageAttachment(item, options);
    total += attachment.sizeBytes;
    if (total > (options.maxTotalBytes ?? 40_000_000)) {
      throw new Error("Image attachments exceed total size limit");
    }
    return attachment;
  });
}

export function imageDataUrl(attachment: ImageAttachment): string {
  return attachment.source.type === "url"
    ? attachment.source.url
    : "data:" + attachment.mediaType + ";base64," + attachment.source.data;
}

function sniffImageType(data: Buffer): ImageAttachment["mediaType"] | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  const firstSix = data.subarray(0, 6).toString("ascii");
  if (firstSix === "GIF87a" || firstSix === "GIF89a") return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function mediaTypeFromPath(path: string): ImageAttachment["mediaType"] | undefined {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.webp$/i.test(path)) return "image/webp";
  if (/\.gif$/i.test(path)) return "image/gif";
  return undefined;
}

function isImageMediaType(value: unknown): value is ImageAttachment["mediaType"] {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(value));
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("Image path escapes the workspace: " + path);
  }
}
