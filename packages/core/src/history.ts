import type {
  CompletionType,
  HistoryEvent,
  OperationRef,
  OutcomeMetadata,
  Perturbation,
} from "./types.js";

export type Clock = () => number;
export type EventTags = Record<string, string | number | boolean>;

export class History {
  readonly #events: HistoryEvent[] = [];
  readonly #clock: Clock;
  #seq = 0;

  constructor(clock: Clock = () => performance.now()) {
    this.#clock = clock;
  }

  static from(events: readonly HistoryEvent[], clock: Clock = () => performance.now()): History {
    const history = new History(clock);
    for (const event of events) history.append({ ...event, at: event.at });
    return history;
  }

  append(event: Omit<HistoryEvent, "seq" | "at"> & { at?: number }): HistoryEvent {
    const full: HistoryEvent = {
      ...event,
      seq: this.#seq++,
      at: event.at ?? this.#clock(),
    };
    this.#events.push(full);
    return full;
  }

  invoke(operation: OperationRef, value?: unknown, tags?: EventTags): HistoryEvent {
    return this.append({
      type: "invoke",
      process: operation.process,
      operation,
      value,
      tags,
    });
  }

  complete(
    operation: OperationRef,
    type: CompletionType,
    value?: unknown,
    outcome?: OutcomeMetadata,
    tags?: EventTags,
  ): HistoryEvent {
    return this.append({
      type,
      process: operation.process,
      operation,
      value,
      outcome,
      tags,
    });
  }

  perturb(
    perturbation: Perturbation,
    operation?: OperationRef,
    process: string | number = "nemesis",
  ): HistoryEvent {
    const isFault = "phase" in perturbation;
    return this.append({
      type: isFault ? "fault" : "semantic",
      process,
      operation,
      value: perturbation,
      tags: {
        perturbationId: perturbation.id,
        target: perturbation.target,
        kind: perturbation.kind,
      },
    });
  }

  checkpoint(name: string, value?: unknown, process: string | number = "cloudfault", tags?: EventTags): HistoryEvent {
    return this.append({
      type: "checkpoint",
      process,
      value,
      tags: { name, ...tags },
    });
  }

  eventsForOperation(operationId: string): readonly HistoryEvent[] {
    return this.#events.filter((event) => event.operation?.id === operationId);
  }

  snapshot(): readonly HistoryEvent[] {
    return this.#events.map((event) => ({
      ...event,
      operation: event.operation ? { ...event.operation } : undefined,
      outcome: event.outcome ? { ...event.outcome } : undefined,
      tags: event.tags ? { ...event.tags } : undefined,
    }));
  }

  toJSON(): readonly HistoryEvent[] {
    return this.snapshot();
  }

  get length(): number {
    return this.#events.length;
  }
}
