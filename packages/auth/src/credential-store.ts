import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StoredCredential } from "./types.js";

interface EncryptedEnvelope {
  schemaVersion: "focuscode-credentials.v1";
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

interface CredentialDatabase {
  schemaVersion: "focuscode-credential-db.v1";
  credentials: Record<string, StoredCredential>;
}

export interface CredentialStoreOptions {
  directory: string;
  passphrase?: string;
  now?: () => Date;
}

export class EncryptedCredentialStore {
  private readonly directory: string;
  private readonly databasePath: string;
  private readonly keyPath: string;
  private readonly now: () => Date;

  constructor(private readonly options: CredentialStoreOptions) {
    this.directory = resolve(options.directory);
    this.databasePath = join(this.directory, "credentials.enc.json");
    this.keyPath = join(this.directory, "credentials.key");
    this.now = options.now ?? (() => new Date());
  }

  async set(
    provider: string,
    account: string,
    value: Omit<StoredCredential, "provider" | "account" | "createdAt" | "updatedAt">,
  ): Promise<StoredCredential> {
    validateIdentifier(provider, "provider");
    validateIdentifier(account, "account");
    const database = await this.load();
    const key = credentialKey(provider, account);
    const previous = database.credentials[key];
    const timestamp = this.now().toISOString();
    const credential: StoredCredential = {
      provider,
      account,
      ...structuredClone(value),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    database.credentials[key] = credential;
    await this.save(database);
    return structuredClone(credential);
  }

  async get(provider: string, account = "default"): Promise<StoredCredential | undefined> {
    const value = (await this.load()).credentials[credentialKey(provider, account)];
    return value ? structuredClone(value) : undefined;
  }

  async delete(provider: string, account = "default"): Promise<boolean> {
    const database = await this.load();
    const key = credentialKey(provider, account);
    if (!database.credentials[key]) return false;
    delete database.credentials[key];
    await this.save(database);
    return true;
  }

  async list(): Promise<Array<Omit<StoredCredential, "token"> & { expiresAt?: number }>> {
    return Object.values((await this.load()).credentials)
      .map(({ token, ...credential }) => ({
        ...structuredClone(credential),
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  private async load(): Promise<CredentialDatabase> {
    if (!(await exists(this.databasePath))) {
      return { schemaVersion: "focuscode-credential-db.v1", credentials: {} };
    }
    const envelope = JSON.parse(await readFile(this.databasePath, "utf8")) as EncryptedEnvelope;
    if (
      envelope.schemaVersion !== "focuscode-credentials.v1" ||
      envelope.algorithm !== "aes-256-gcm"
    ) {
      throw new Error("Unsupported FocusCode credential store format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await this.key(),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch {
      throw new Error("Unable to decrypt FocusCode credentials; the key is missing or incorrect");
    }
    const database = JSON.parse(plaintext.toString("utf8")) as CredentialDatabase;
    if (database.schemaVersion !== "focuscode-credential-db.v1" || !database.credentials) {
      throw new Error("Invalid FocusCode credential database");
    }
    return database;
  }

  private async save(database: CredentialDatabase): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(database), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedEnvelope = {
      schemaVersion: "focuscode-credentials.v1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporary = `${this.databasePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await rename(temporary, this.databasePath);
    await chmod(this.databasePath, 0o600);
  }

  private async key(): Promise<Buffer> {
    if (this.options.passphrase) {
      return scryptSync(this.options.passphrase, "focuscode-credentials-v1", 32);
    }
    if (await exists(this.keyPath)) {
      const info = await stat(this.keyPath);
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new Error(`Credential key permissions are too broad: ${this.keyPath}`);
      }
      const key = Buffer.from((await readFile(this.keyPath, "utf8")).trim(), "base64");
      if (key.length !== 32) throw new Error("Invalid FocusCode credential key");
      return key;
    }
    await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    await writeFile(this.keyPath, `${key.toString("base64")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const persisted = Buffer.from((await readFile(this.keyPath, "utf8")).trim(), "base64");
    if (persisted.length !== 32) throw new Error("Invalid FocusCode credential key");
    return persisted;
  }
}

function credentialKey(provider: string, account: string): string {
  validateIdentifier(provider, "provider");
  validateIdentifier(account, "account");
  return `${provider}:${account}`;
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(`Invalid credential ${label}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
