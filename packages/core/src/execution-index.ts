import type { OperationRef } from "./types.js";

function safe(value: string): string {
  return value.replace(/[\\/#]/g, "_");
}

function identityKey(operation: Pick<OperationRef, "target" | "adapter" | "name" | "resource" | "callsite" | "parentId">): string {
  return [
    operation.parentId ?? "root",
    operation.target ?? operation.adapter ?? "app",
    operation.name,
    operation.resource ?? "*",
    operation.callsite ?? "*",
  ].join("\u0000");
}

/**
 * Lightweight Distributed-Execution-Index-inspired identity. It deliberately
 * avoids process-global ordinal numbers: occurrences are counted within a
 * logical parent/target/operation/resource/callsite context.
 */
export class ExecutionIndexer {
  readonly #counts = new Map<string, number>();
  readonly #indexByOperationId = new Map<string, string>();

  assign<T extends OperationRef>(operation: T): T & { executionIndex: string; occurrence: number } {
    if (operation.executionIndex && operation.occurrence) {
      this.#indexByOperationId.set(operation.id, operation.executionIndex);
      return operation as T & { executionIndex: string; occurrence: number };
    }

    const key = identityKey(operation);
    const occurrence = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, occurrence);

    const parent = operation.parentId
      ? this.#indexByOperationId.get(operation.parentId) ?? `op:${safe(operation.parentId)}`
      : "root";
    const target = safe(operation.target ?? operation.adapter ?? "app");
    const resource = operation.resource ? `:${safe(operation.resource)}` : "";
    const callsite = operation.callsite ? `@${safe(operation.callsite)}` : "";
    const executionIndex = `${parent}/${target}.${safe(operation.name)}${resource}${callsite}#${occurrence}`;

    const assigned = { ...operation, executionIndex, occurrence };
    this.#indexByOperationId.set(operation.id, executionIndex);
    return assigned;
  }

  get(operationId: string): string | undefined {
    return this.#indexByOperationId.get(operationId);
  }

  reset(): void {
    this.#counts.clear();
    this.#indexByOperationId.clear();
  }
}
