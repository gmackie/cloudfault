import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CoverageGuidance, type GuidanceSnapshot } from "./guided.js";

interface GuidanceDocument {
  schema: "cloudfault.coverage-guidance-store";
  version: 1;
  updatedAt: string;
  guidance: GuidanceSnapshot;
}

export class FileCoverageGuidanceStore {
  readonly #file: string;

  constructor(file = path.join(".cloudfault", "coverage-guidance.json")) {
    this.#file = file;
  }

  async load(): Promise<CoverageGuidance> {
    try {
      const document = JSON.parse(await readFile(this.#file, "utf8")) as GuidanceDocument;
      if (document.schema !== "cloudfault.coverage-guidance-store" || document.version !== 1) return new CoverageGuidance();
      return new CoverageGuidance(document.guidance);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new CoverageGuidance();
      throw error;
    }
  }

  async save(guidance: CoverageGuidance | GuidanceSnapshot): Promise<void> {
    const snapshot = guidance instanceof CoverageGuidance ? guidance.snapshot() : guidance;
    await mkdir(path.dirname(this.#file), { recursive: true });
    const document: GuidanceDocument = {
      schema: "cloudfault.coverage-guidance-store",
      version: 1,
      updatedAt: new Date().toISOString(),
      guidance: snapshot,
    };
    await writeFile(this.#file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }

  async merge(snapshot: GuidanceSnapshot): Promise<CoverageGuidance> {
    const guidance = await this.load();
    guidance.merge(snapshot);
    await this.save(guidance);
    return guidance;
  }
}
