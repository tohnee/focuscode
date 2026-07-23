import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MemoryRecordSchema,
  MemoryWriteProposalSchema,
  assertSchema,
  type MemoryRecordV1,
  type MemoryWriteProposalV1,
} from "@focuscode/contracts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export class FileMemoryStore {
  constructor(private readonly rootDirectory: string) {}

  async propose(proposal: MemoryWriteProposalV1): Promise<void> {
    assertSchema(MemoryWriteProposalSchema, proposal, "memory write proposal");
    const directory = join(this.rootDirectory, "memory");
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "proposals.jsonl"), `${JSON.stringify(proposal)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async accept(proposalId: string, acceptedBy: string): Promise<MemoryRecordV1> {
    const proposals = await this.listProposals();
    const proposal = proposals.find((candidate) => candidate.proposalId === proposalId);
    if (!proposal) throw new Error(`Unknown memory proposal: ${proposalId}`);
    if (proposal.record.confidence === "inferred" && !acceptedBy) {
      throw new Error("Inferred memory requires an accountable owner");
    }
    const directory = join(this.rootDirectory, "memory");
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "records.jsonl"), `${JSON.stringify(proposal.record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await appendFile(
      join(directory, "acceptances.jsonl"),
      `${JSON.stringify({ proposalId, memoryId: proposal.record.memoryId, acceptedBy })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return proposal.record;
  }

  async listProposals(): Promise<MemoryWriteProposalV1[]> {
    const path = join(this.rootDirectory, "memory", "proposals.jsonl");
    if (!(await exists(path))) return [];
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        assertSchema(MemoryWriteProposalSchema, value, "stored memory proposal");
        return value;
      });
  }

  async listRecords(): Promise<MemoryRecordV1[]> {
    const path = join(this.rootDirectory, "memory", "records.jsonl");
    if (!(await exists(path))) return [];
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        assertSchema(MemoryRecordSchema, value, "stored memory record");
        return value;
      });
  }
}
