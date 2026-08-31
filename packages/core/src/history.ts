import type { EventMeta, HistoryEvent, HistoryEventType } from "./types.js";

export class History {
  readonly #events: HistoryEvent[] = [];
  #sequence = 0;
  readonly #clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.#clock = clock;
  }

  append(event: Omit<HistoryEvent, "sequence" | "time"> & Partial<Pick<HistoryEvent, "time">>): HistoryEvent {
    const complete: HistoryEvent = {
      ...event,
      sequence: this.#sequence++,
      time: event.time ?? this.#clock(),
    };
    this.#events.push(complete);
    return complete;
  }

  invoke(process: string, operation: string, value?: unknown, meta?: EventMeta): HistoryEvent {
    return this.append({ process, operation, type: "invoke", value, meta });
  }

  complete(
    process: string,
    type: Exclude<HistoryEventType, "invoke">,
    value?: unknown,
    meta?: EventMeta,
  ): HistoryEvent {
    return this.append({ process, type, value, meta });
  }

  events(): readonly HistoryEvent[] {
    return this.#events;
  }

  toJSON(): HistoryEvent[] {
    return [...this.#events];
  }

  toText(): string {
    return this.#events
      .map((event) => `${event.sequence.toString().padStart(4, "0")} ${event.process} ${event.type} ${event.operation ?? ""}`.trim())
      .join("\n");
  }
}
