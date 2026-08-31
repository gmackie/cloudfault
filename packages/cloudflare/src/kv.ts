import type { Fault } from "@cloudfault/core";

export interface VersionedValue<T> {
  version: number;
  value: T | null;
}

export interface ObserverState {
  name: string;
  visibleVersion: number;
}

/**
 * A deliberately small observer-view model for eventually consistent stores.
 * It does not claim to emulate Cloudflare's network. It allows tests to state
 * that different observers have received different prefixes of a write history.
 */
export class EventuallyConsistentKV<T> {
  readonly #versions: VersionedValue<T>[] = [{ version: 0, value: null }];
  readonly #observers = new Map<string, number>();

  write(value: T | null): number {
    const version = this.#versions.length;
    this.#versions.push({ version, value });
    return version;
  }

  latestVersion(): number {
    return this.#versions.at(-1)!.version;
  }

  setObserverVersion(observer: string, version: number): void {
    if (version < 0 || version > this.latestVersion()) {
      throw new RangeError(`observer version ${version} outside 0..${this.latestVersion()}`);
    }
    this.#observers.set(observer, version);
  }

  converge(observer: string): void {
    this.#observers.set(observer, this.latestVersion());
  }

  read(observer: string): VersionedValue<T> {
    const version = this.#observers.get(observer) ?? this.latestVersion();
    return this.#versions[version]!;
  }

  observerStates(): ObserverState[] {
    return [...this.#observers.entries()].map(([name, visibleVersion]) => ({ name, visibleVersion }));
  }
}

export function kvStaleReadFault(binding: string, observer: string, versionsBehind = 1): Fault {
  return {
    id: `kv:${binding}:stale:${observer}:${versionsBehind}`,
    label: `${binding} observer ${observer} sees ${versionsBehind} version(s) behind`,
    target: `kv:${binding}`,
    category: "semantic",
    metadata: { observer, versionsBehind },
  };
}

export function kvCachedNegativeFault(binding: string, observer: string): Fault {
  return {
    id: `kv:${binding}:cached-negative:${observer}`,
    label: `${binding} observer ${observer} retains cached negative lookup`,
    target: `kv:${binding}`,
    category: "semantic",
    metadata: { observer },
  };
}
