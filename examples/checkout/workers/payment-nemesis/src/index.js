import { WorkerEntrypoint } from "cloudflare:workers";

let plan = [];
let events = [];
let occurrences = new Map();
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function requestKey(request) { const url = new URL(request.url); return `${request.method} ${url.pathname}`; }
function matchingRule(request) {
  const key = requestKey(request);
  const occurrence = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, occurrence);
  const path = new URL(request.url).pathname;
  return { occurrence, rule: plan.find((candidate) =>
    (!candidate.method || candidate.method === request.method) &&
    (!candidate.path || candidate.path === path) &&
    (!candidate.occurrence || candidate.occurrence === occurrence)) };
}

export default class PaymentNemesis extends WorkerEntrypoint {
  async fetch(request) {
    const { rule, occurrence } = matchingRule(request);
    if (!rule) return this.env.UPSTREAM.fetch(request);
    events.push({ at: Date.now(), type: "fault", rule: clone(rule), occurrence, method: request.method, url: request.url });

    if (rule.kind === "latency") await new Promise((resolve) => setTimeout(resolve, Math.max(0, rule.delayMs ?? 0)));
    if (rule.kind === "reject" || rule.kind === "http-error") {
      return new Response(rule.body ?? "CloudFault injected failure", { status: rule.status ?? 503 });
    }
    if (rule.kind === "commit-then-error" || rule.kind === "commit-then-timeout" || rule.kind === "commit-then-disconnect") {
      const response = await this.env.UPSTREAM.fetch(request);
      events.push({ at: Date.now(), type: "upstream-committed", status: response.status, occurrence, method: request.method, url: request.url });
      throw new Error(rule.kind === "commit-then-timeout" ? "CloudFault timeout after commit" : "CloudFault connection lost after commit");
    }
    return this.env.UPSTREAM.fetch(request);
  }

  setPlan(value) { plan = clone(value ?? []); occurrences = new Map(); }
  clearPlan() { plan = []; occurrences = new Map(); }
  events() { return clone(events); }
  reset() { plan = []; events = []; occurrences = new Map(); }
}
