import { WorkerEntrypoint } from "cloudflare:workers";

let mode = "pass";
let messages = [];
let events = [];
function clone(value) { return JSON.parse(JSON.stringify(value)); }

export default class QueueNemesis extends WorkerEntrypoint {
  send(body, options) {
    events.push({ at: Date.now(), type: "send", mode, body: clone(body) });
    if (mode === "fail") throw new Error("CloudFault injected queue producer failure");
    messages.push({ body: clone(body), options: clone(options ?? null) });
    if (mode === "duplicate") messages.push({ body: clone(body), options: clone(options ?? null), duplicate: true });
  }
  sendBatch(batch) { for (const item of batch) this.send(item.body, item); }
  setMode(value) { mode = value; }
  snapshot() { return { mode, messages: clone(messages), events: clone(events) }; }
  reset() { mode = "pass"; messages = []; events = []; }
}
