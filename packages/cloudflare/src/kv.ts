import type { SemanticVariation } from "@cloudfault/core";

export interface KvVersion<T> {
  version: number;
  value: T | null;
  writtenAt: number;
}

export interface KvObserver<T> {
  region: string;
  visibleVersion: number;
  visibleValue: T | null;
}

/**
 * Single-key compatibility model retained for V0 users. For multi-key tests,
 * use EventuallyConsistentKvStore.
 */
export class EventuallyConsistentKv<T> {
  #versions: KvVersion<T>[] = [];
  #observers = new Map<string, number>();

  write(value: T | null, writtenAt = Date.now()): KvVersion<T> {
    const version: KvVersion<T> = { version: this.#versions.length + 1, value, writtenAt };
    this.#versions.push(version);
    return version;
  }

  latest(): KvVersion<T> | undefined { return this.#versions.at(-1); }

  setObserverVersion(region: string, version: number): void {
    if (version < 0 || version > this.#versions.length) throw new Error(`Invalid visible version ${version} for ${region}`);
    this.#observers.set(region, version);
  }

  converge(region: string): void { this.#observers.set(region, this.#versions.length); }

  read(region: string): KvObserver<T> {
    const visibleVersion = this.#observers.get(region) ?? this.#versions.length;
    if (visibleVersion === 0) return { region, visibleVersion: 0, visibleValue: null };
    const entry = this.#versions[visibleVersion - 1];
    return { region, visibleVersion, visibleValue: entry?.value ?? null };
  }
}

export interface KvRead<T> extends KvObserver<T> { key: string; authoritativeVersion: number; }

/** Multi-key observer-view model with explicit stale positive/negative reads. */
export class EventuallyConsistentKvStore<T> {
  readonly #versions = new Map<string, KvVersion<T>[]>();
  readonly #observers = new Map<string, Map<string, number>>();

  put(key: string, value: T, writtenAt = Date.now()): KvVersion<T> { return this.#write(key, value, writtenAt); }
  delete(key: string, writtenAt = Date.now()): KvVersion<T> { return this.#write(key, null, writtenAt); }

  #write(key: string, value: T | null, writtenAt: number): KvVersion<T> {
    const versions = this.#versions.get(key) ?? [];
    const entry = { version: versions.length + 1, value, writtenAt };
    versions.push(entry);
    this.#versions.set(key, versions);
    return entry;
  }

  latest(key: string): KvVersion<T> | undefined { return this.#versions.get(key)?.at(-1); }

  setObserverVersion(region: string, key: string, version: number): void {
    const max = this.#versions.get(key)?.length ?? 0;
    if (version < 0 || version > max) throw new Error(`Invalid visible version ${version} for ${region}/${key}; max=${max}`);
    const views = this.#observers.get(region) ?? new Map<string, number>();
    views.set(key, version);
    this.#observers.set(region, views);
  }

  setObserverLag(region: string, key: string, versionsBehind: number): void {
    const max = this.#versions.get(key)?.length ?? 0;
    this.setObserverVersion(region, key, Math.max(0, max - Math.max(0, versionsBehind)));
  }

  converge(region: string, key?: string): void {
    const views = this.#observers.get(region) ?? new Map<string, number>();
    if (key) views.set(key, this.#versions.get(key)?.length ?? 0);
    else for (const [candidate, versions] of this.#versions) views.set(candidate, versions.length);
    this.#observers.set(region, views);
  }

  read(region: string, key: string): KvRead<T> {
    const versions = this.#versions.get(key) ?? [];
    const authoritativeVersion = versions.length;
    const visibleVersion = this.#observers.get(region)?.get(key) ?? authoritativeVersion;
    const value = visibleVersion === 0 ? null : versions[visibleVersion - 1]?.value ?? null;
    return { key, region, visibleVersion, visibleValue: value, authoritativeVersion };
  }
}

export function staleKvRead(target: string, options: { region: string; versionsBehind?: number; key?: string }): SemanticVariation {
  const versionsBehind = options.versionsBehind ?? 1;
  return {
    id: `${target}:stale:${options.region}:${options.key ?? "*"}:${versionsBehind}`,
    target,
    kind: "stale-read",
    description: `${target} observer ${options.region} sees ${versionsBehind} version(s) behind`,
    selector: { target },
    metadata: { ...options, versionsBehind },
  };
}

export function staleNegativeKvRead(target: string, region: string, key?: string): SemanticVariation {
  return {
    id: `${target}:stale-negative:${region}:${key ?? "*"}`,
    target,
    kind: "stale-negative-read",
    description: `${target} observer ${region} retains a cached negative lookup`,
    selector: { target },
    metadata: { region, key },
  };
}
