// A Worker with two classic assumptions a smoke run can break from outside:
// it reads back a KV write and trusts it to be there (KV is eventually
// consistent, so it may not be), and it treats a failed queue send as fatal.
// `?tolerant=1` handles both, so the same Worker yields a PASS and a FAIL.
export default {
  async fetch(request, env) {
    const tolerant = new URL(request.url).searchParams.has("tolerant");
    const id = crypto.randomUUID();
    await env.SESSIONS.put(`session:${id}`, "active");
    const session = await env.SESSIONS.get(`session:${id}`);
    if (session !== "active" && !tolerant) throw new Error(`session ${id} vanished after write`);
    try {
      await env.EVENTS.send({ type: "session.created", id });
    } catch (error) {
      if (!tolerant) throw error;
    }
    return Response.json({ id, session: session ?? "pending" });
  },
};
