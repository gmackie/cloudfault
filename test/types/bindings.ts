/**
 * Consumer-shaped type test.
 *
 * `@cloudflare/workers-types` is not a dependency of this repo, so the two
 * declarations below are copied from it verbatim. They exist to pin the exact
 * friction this test is about: `D1Database` is *structurally similar* to
 * `D1DatabaseLike` but not assignable to it, because its generic methods
 * resolve to concrete return types (`Promise<D1Result<T>[]>`, not
 * `Promise<T[]>`). Before the `D1DatabaseCompatible` overload existed, every
 * consumer had to write `createD1FaultProxy(env.DB as unknown as D1DatabaseLike, ...)`
 * and got a `D1DatabaseLike` back instead of their own `D1Database`.
 *
 * Checked by `test/binding-types.test.mjs`, which runs `tsc --noEmit` here.
 */
import {
  createD1FaultProxy,
  createR2FaultProxy,
  type D1DatabaseLike,
  type R2BucketLike,
} from "@cloudfault/cloudflare";
import { ScenarioController } from "@cloudfault/core";

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: Record<string, unknown>;
  error?: never;
}
interface D1ExecResult { count: number; duration: number }

declare abstract class D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

declare abstract class D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

declare abstract class R2Bucket {
  head(key: string): Promise<{ key: string } | null>;
  get(key: string): Promise<{ key: string } | null>;
  put(key: string, value: string | ArrayBuffer | null): Promise<{ key: string } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
}

declare const env: { DB: D1Database; BUCKET: R2Bucket };
declare const controller: ScenarioController;

// The friction, asserted rather than described. If `@ts-expect-error` ever
// reports "unused", D1Database became assignable and the overload can go.
// @ts-expect-error D1Database is structurally similar to D1DatabaseLike but not assignable to it.
const _friction: D1DatabaseLike = env.DB;
void _friction;

// No assertion at the call site, and the caller's own type comes back.
const db: D1Database = createD1FaultProxy(env.DB, { controller, target: "DB" });
const bucket: R2Bucket = createR2FaultProxy(env.BUCKET, { controller, target: "BUCKET" });

// The proxy is transparent: the real methods still type-check through it.
export async function useBindings(): Promise<void> {
  const rows: D1Result<{ id: number }>[] = await db.batch<{ id: number }>([
    db.prepare("UPDATE t SET v = 1 WHERE id = ?").bind(1),
    db.prepare("INSERT INTO t (v) VALUES (?)").bind(2),
  ]);
  void rows;
  await db.prepare("SELECT 1").first<{ n: number }>();
  await bucket.put("k", "v");
}

// The structural overload still resolves for a plain `D1DatabaseLike`.
declare const plain: D1DatabaseLike;
declare const plainBucket: R2BucketLike;
const _plain: D1DatabaseLike = createD1FaultProxy(plain, { controller });
const _plainBucket: R2BucketLike = createR2FaultProxy(plainBucket, { controller });
void _plain;
void _plainBucket;
