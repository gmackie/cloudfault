import type { Fault } from "@cloudfault/core";

export function queueDuplicateFault(binding: string, copies = 2): Fault {
  return {
    id: `queue:${binding}:duplicate:${copies}`,
    label: `${binding} delivers a message ${copies} times`,
    target: `queue:${binding}`,
    category: "semantic",
    metadata: { copies },
  };
}

export function queueRebatchFault(binding: string, batchSizes: number[]): Fault {
  return {
    id: `queue:${binding}:rebatch:${batchSizes.join("-")}`,
    label: `${binding} changes delivery batch boundaries`,
    target: `queue:${binding}`,
    category: "semantic",
    metadata: { batchSizes },
  };
}

export function duplicateMessages<T>(messages: readonly T[], index: number, copies = 2): T[] {
  return messages.flatMap((message, current) => {
    if (current !== index) return [message];
    return Array.from({ length: copies }, () => message);
  });
}
