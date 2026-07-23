import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface SessionShareBundle {
  schemaVersion: "focuscode-share.v1";
  shareId: string;
  createdAt: string;
  workspaceHint: string;
  session: Record<string, unknown>;
  attachments?: Array<{ name: string; mediaType: string; data: string }>;
  redactions: number;
  signer: { algorithm: "Ed25519"; publicKey: string };
  signature: string;
}

export interface SessionShareOptions {
  identityDirectory: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

export class SessionShareService {
  private readonly directory: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;

  constructor(options: SessionShareOptions) {
    this.directory = resolve(options.identityDirectory);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async create(
    session: Record<string, unknown>,
    options: {
      workspace?: string;
      attachments?: Array<{ name: string; mediaType: string; data: string }>;
      includeToolOutput?: boolean;
      includeImages?: boolean;
    } = {},
  ): Promise<SessionShareBundle> {
    const redacted = redactSession(
      session,
      options.includeToolOutput ?? false,
      options.includeImages ?? false,
    );
    const key = await this.identity();
    const unsigned = {
      schemaVersion: "focuscode-share.v1" as const,
      shareId: "share_" + randomUUID(),
      createdAt: this.now().toISOString(),
      workspaceHint: basename(
        options.workspace ?? String(readPath(session, ["header", "cwd"]) ?? "workspace"),
      ),
      session: redacted.value,
      ...(options.attachments?.length
        ? { attachments: validateAttachments(options.attachments) }
        : {}),
      redactions: redacted.redactions,
      signer: { algorithm: "Ed25519" as const, publicKey: key.publicKey },
    };
    if (Buffer.byteLength(JSON.stringify(unsigned), "utf8") > 20_000_000) {
      throw new Error("Session share exceeds 20 MB; omit images or tool output");
    }
    const signature = sign(
      null,
      Buffer.from(canonical(unsigned)),
      createPrivateKey(key.privateKey),
    ).toString("base64");
    return { ...unsigned, signature };
  }

  verify(bundle: SessionShareBundle): boolean {
    return verifySessionShareBundle(bundle);
  }

  import(bundle: SessionShareBundle, workspace: string): Record<string, unknown> {
    if (!this.verify(bundle)) throw new Error("Session share signature is invalid");
    const session = structuredClone(bundle.session);
    const header = session.header;
    if (header && typeof header === "object" && !Array.isArray(header)) {
      (header as Record<string, unknown>).cwd = resolve(workspace);
      delete (header as Record<string, unknown>).sessionId;
      delete (header as Record<string, unknown>).forkedFrom;
    }
    return session;
  }

  async write(bundle: SessionShareBundle, path: string): Promise<void> {
    const destination = resolve(path);
    const temporary = destination + "." + process.pid + ".tmp";
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, JSON.stringify(bundle, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  async read(path: string): Promise<SessionShareBundle> {
    const value = JSON.parse(await readFile(resolve(path), "utf8")) as SessionShareBundle;
    if (!this.verify(value)) throw new Error("Session share signature is invalid");
    return value;
  }

  async publish(
    bundle: SessionShareBundle,
    endpoint: string,
    token?: string,
  ): Promise<{ id: string; url?: string }> {
    if (!this.verify(bundle)) throw new Error("Refusing to publish an invalid session share");
    const response = await this.fetchImplementation(new URL("/v1/shares", endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(bundle),
    });
    if (!response.ok) throw new Error("Share service returned HTTP " + response.status);
    const value = (await response.json()) as { id?: string; url?: string };
    if (!value.id) throw new Error("Share service omitted id");
    return { id: value.id, ...(value.url ? { url: value.url } : {}) };
  }

  async download(id: string, endpoint: string, token?: string): Promise<SessionShareBundle> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid share id");
    const response = await this.fetchImplementation(new URL("/v1/shares/" + id, endpoint), {
      headers: token ? { authorization: "Bearer " + token } : {},
    });
    if (!response.ok) throw new Error("Share service returned HTTP " + response.status);
    const bundle = (await response.json()) as SessionShareBundle;
    if (!this.verify(bundle)) throw new Error("Downloaded session share signature is invalid");
    return bundle;
  }

  private async identity(): Promise<{ privateKey: string; publicKey: string }> {
    const privatePath = join(this.directory, "share-ed25519-private.pem");
    const publicPath = join(this.directory, "share-ed25519-public.pem");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await exists(privatePath)) {
      return {
        privateKey: await readFile(privatePath, "utf8"),
        publicKey: await readFile(publicPath, "utf8"),
      };
    }
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    await writeFile(privatePath, privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await writeFile(publicPath, publicKey, { encoding: "utf8", mode: 0o644 });
    await chmod(privatePath, 0o600);
    return { privateKey, publicKey };
  }
}

export function verifySessionShareBundle(value: unknown): value is SessionShareBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  const signer = bundle.signer;
  if (
    bundle.schemaVersion !== "focuscode-share.v1" ||
    typeof bundle.shareId !== "string" ||
    typeof bundle.createdAt !== "string" ||
    typeof bundle.workspaceHint !== "string" ||
    typeof bundle.redactions !== "number" ||
    !bundle.session ||
    typeof bundle.session !== "object" ||
    Array.isArray(bundle.session) ||
    typeof bundle.signature !== "string" ||
    !signer ||
    typeof signer !== "object" ||
    Array.isArray(signer) ||
    (signer as Record<string, unknown>).algorithm !== "Ed25519" ||
    typeof (signer as Record<string, unknown>).publicKey !== "string"
  ) {
    return false;
  }
  const typed = value as SessionShareBundle;
  const { signature, ...unsigned } = typed;
  try {
    return verify(
      null,
      Buffer.from(canonical(unsigned)),
      createPublicKey(typed.signer.publicKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function redactSession(
  session: Record<string, unknown>,
  includeToolOutput: boolean,
  includeImages: boolean,
): { value: Record<string, unknown>; redactions: number } {
  let redactions = 0;
  const visit = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/token|secret|password|authorization|api.?key/i.test(key)) {
        redactions += 1;
        return "[REDACTED]";
      }
      const replaced = value.replace(
        /(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{12,}|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/gi,
        () => {
          redactions += 1;
          return "[REDACTED]";
        },
      );
      return replaced;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        if (childKey === "providerState") {
          redactions += 1;
          continue;
        }
        if (!includeImages && childKey === "attachments" && Array.isArray(child)) {
          redactions += child.length;
          continue;
        }
        if (childKey === "cwd") {
          output[childKey] = "$WORKSPACE";
          continue;
        }
        if (!includeToolOutput && childKey === "message" && isToolMessage(child)) {
          output[childKey] = {
            ...(child as Record<string, unknown>),
            content: "[TOOL OUTPUT OMITTED]",
          };
          redactions += 1;
          continue;
        }
        output[childKey] = visit(child, childKey);
      }
      return output;
    }
    return value;
  };
  return { value: visit(structuredClone(session)) as Record<string, unknown>, redactions };
}

function isToolMessage(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).role === "tool",
  );
}

function validateAttachments(
  attachments: Array<{ name: string; mediaType: string; data: string }>,
): Array<{ name: string; mediaType: string; data: string }> {
  let bytes = 0;
  return attachments.map((attachment) => {
    if (!/^[\w .-]{1,160}$/.test(attachment.name))
      throw new Error("Invalid shared attachment name");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(attachment.mediaType))
      throw new Error("Unsupported shared media type");
    bytes += Buffer.byteLength(attachment.data, "base64");
    if (bytes > 20_000_000) throw new Error("Shared attachments exceed 20 MB");
    return { ...attachment };
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function readPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
