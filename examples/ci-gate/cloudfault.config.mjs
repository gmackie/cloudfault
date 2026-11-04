// The suite this repository's own CI gates on with `cloudfault ci`. It is the
// starter config `cloudfault init` generates for examples/generated-smoke/worker,
// pointed at that Worker and sending its tolerant request, so it passes every
// applicable scenario. Drop `?tolerant=1` to watch the gate fail (exit 1).
import { defineCloudFault } from "@gmacko/cloudfault";
import { duplicateQueueDelivery, queueConsumerFailure, queueProducerFailure, rebatchQueueDelivery, staleKvRead, staleNegativeKvRead } from "@gmacko/cloudfault/cloudflare";
import { createSmokeExecute } from "@gmacko/cloudfault/cloudflare/smoke";

const smoke = createSmokeExecute({
  config: new URL("../generated-smoke/worker/wrangler.jsonc", import.meta.url),
  name: "cloudfault-generated-smoke",
  bindings: [
    { type: "kv", binding: "SESSIONS" },
    { type: "queue-producer", binding: "EVENTS" },
  ],
  crons: [],
  requests: [{ path: "/?tolerant=1" }],
});

export const cloudfault = defineCloudFault({
  name: "ci-gate/generated-smoke-tolerant",
  strategy: "hybrid",
  maxDepth: 2,
  maxScenarios: 100,
  faultPoints: smoke.applicableFaultPoints([
    { id: "SESSIONS", target: "SESSIONS", choices: [staleKvRead("SESSIONS", { region: "remote", versionsBehind: 1 }), staleNegativeKvRead("SESSIONS", "remote")] },
    { id: "EVENTS", target: "EVENTS", choices: [duplicateQueueDelivery("EVENTS"), rebatchQueueDelivery("EVENTS"), queueConsumerFailure("EVENTS"), queueProducerFailure("EVENTS")] },
  ]),
  execute: smoke,
});
