import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloudFaultMiniflare,
  dispatchQueueUntilSettled,
} from "@cloudfault/cloudflare";

const script = `
export default {
  async queue(batch) {
    if (batch.queue === "events") {
      for (const message of batch.messages) {
        // Use message identity rather than body decoding here: this fixture is
        // specifically validating Miniflare's ack/retry result metadata and
        // CloudFault's attempt/DLQ lifecycle, not structured-clone semantics.
        if (message.id === "poison") message.retry();
        else message.ack();
      }
      return;
    }

    if (batch.queue === "events-dlq") {
      for (const message of batch.messages) message.ack();
    }
  }
};
`;

test("real Miniflare Queue consumer retries a poison message to the DLQ", async () => {
  const miniflare = await createCloudFaultMiniflare({
    modules: true,
    script,
  });

  try {
    const result = await dispatchQueueUntilSettled(miniflare, {
      queue: "events",
      deadLetterQueue: "events-dlq",
      maxRetries: 2,
      messages: [
        { id: "good", body: { poison: false } },
        { id: "poison", body: { poison: true } },
      ],
    });

    assert.equal(result.attempts.length, 3);
    assert.deepEqual(result.acknowledged.map((message) => message.id), ["good"]);
    assert.deepEqual(result.deadLettered.map((message) => message.id), ["poison"]);
    assert.equal(result.deadLettered[0].attempts, 3);
    assert.equal(result.remaining.length, 0);
    assert.equal(result.dlqDispatch?.outcome, "ok");

    const poisonAttempts = result.attempts.map((attempt) =>
      attempt.messages.find((message) => message.id === "poison")?.attempts,
    );
    assert.deepEqual(poisonAttempts, [1, 2, 3]);
  } finally {
    await miniflare.dispose();
  }
});
