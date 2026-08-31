import type { Fault, SemanticVariation } from "@cloudfault/core";

function d1Fault(target: string, kind: string, description: string, metadata?: Record<string, unknown>): Fault {
  return {
    id: `${target}:${kind}`,
    target,
    kind,
    phase: "before-commit",
    category: "cloudflare",
    description,
    actualOutcome: "unknown",
    observedOutcome: "definite-failure",
    selector: { target },
    metadata,
  };
}

export function d1TransientNetworkError(target = "D1"): Fault {
  return d1Fault(target, "transient-network-error", `${target} encounters a transient network failure`);
}
export function d1StorageReset(target = "D1"): Fault {
  return d1Fault(target, "storage-reset", `${target} storage path resets during an operation`);
}
export function d1ReplicaUnavailable(target = "D1"): Fault {
  return d1Fault(target, "replica-unavailable", `${target} read replica becomes temporarily unavailable`);
}
export function d1OperationTimeout(target = "D1"): Fault {
  return d1Fault(target, "operation-timeout", `${target} operation exceeds its storage/network deadline`);
}

/** Sequential-consistency/session model for D1 read-replica tests. */
export class D1SessionModel {
  #primaryVersion = 0;
  readonly #replicas = new Map<string, number>();
  readonly #sessions = new Map<string, number>();

  commit(): number { return ++this.#primaryVersion; }
  primaryVersion(): number { return this.#primaryVersion; }
  setReplicaVersion(replica: string, version: number): void {
    if (version < 0 || version > this.#primaryVersion) throw new Error(`Invalid replica version ${version}`);
    this.#replicas.set(replica, version);
  }
  observe(replica: string, session?: string): number {
    const replicaVersion = this.#replicas.get(replica) ?? this.#primaryVersion;
    if (!session) return replicaVersion;
    const minimum = this.#sessions.get(session) ?? 0;
    const observed = Math.max(replicaVersion, minimum);
    this.#sessions.set(session, observed);
    return observed;
  }
  recordWrite(session: string, version = this.#primaryVersion): void {
    this.#sessions.set(session, Math.max(this.#sessions.get(session) ?? 0, version));
  }
}

export function d1ReplicaLag(target: string, replica: string, versionsBehind = 1): SemanticVariation {
  return {
    id: `${target}:replica-lag:${replica}:${versionsBehind}`,
    target,
    kind: "replica-lag",
    description: `${target} replica ${replica} observes ${versionsBehind} committed version(s) behind primary`,
    selector: { target },
    metadata: { replica, versionsBehind },
  };
}
