import { DurableObject } from "cloudflare:workers";

export class AlarmCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hits = 0;
  }

  async incrementStored() {
    const current = (await this.ctx.storage.get("stored")) ?? 0;
    await this.ctx.storage.put("stored", current + 1);
    return current + 1;
  }

  async getStored() {
    return (await this.ctx.storage.get("stored")) ?? 0;
  }

  recordHit() {
    return ++this.hits;
  }

  getHits() {
    return this.hits;
  }

  async scheduleAlarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async getAlarmFires() {
    return (await this.ctx.storage.get("alarmFires")) ?? 0;
  }

  async alarm() {
    const current = (await this.ctx.storage.get("alarmFires")) ?? 0;
    await this.ctx.storage.put("alarmFires", current + 1);
    // Keep the fixture recurring so CloudFault can deliberately exercise a
    // second legal delivery with runDurableObjectAlarmScenario().
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}

export default {
  fetch() {
    return new Response("cloudfault durable-object fixture");
  },
};
