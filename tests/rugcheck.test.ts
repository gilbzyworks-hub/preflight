import { describe, expect, it, vi } from "vitest";
import { fetchRugCheck } from "@shared/rugcheck.ts";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW = () => new Date("2026-10-07T14:05:00.000Z");
const res = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const call = (fetchImpl: unknown) => fetchRugCheck(MINT, { fetchImpl: fetchImpl as typeof fetch, now: NOW, base: "https://rc.test" });

describe("RugCheck result cases", () => {
  it("success with an empty list is the only way to get 'none'", async () => {
    const r = await call(res(200, { risks: [], score: 1 }));
    expect(r).toEqual({ status: "none", fetchedAt: "2026-10-07T14:05:00.000Z" });
  });

  it("success with items keeps RugCheck's own name and level", async () => {
    const r = await call(res(200, { risks: [{ name: "Mutable metadata", level: "warn", description: "Token metadata can be changed", value: "", score: 100 }, { level: "danger" }] }));
    expect(r.status).toBe("items");
    if (r.status === "items") {
      expect(r.risks[0]).toEqual({ name: "Mutable metadata", level: "warn", description: "Token metadata can be changed", value: null });
      expect(r.risks[1]).toMatchObject({ name: "Unnamed item", level: "danger" });
    }
  });

  it.each([
    ["no risks field", {}],
    ["risks null", { risks: null }],
    ["risks is a string", { risks: "none" }],
    ["risks is an object", { risks: {} }],
    ["not an object", "ok"],
  ])("a malformed success (%s) is unavailable, never 'none'", async (_n, body) => {
    const r = await call(res(200, body));
    expect(r.status).toBe("unavailable");
  });

  it("unreadable JSON is unavailable", async () => {
    const f = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad"); }, text: async () => "" });
    expect(await call(f)).toMatchObject({ status: "unavailable", reason: "response could not be read" });
  });

  it("the real 'unable to generate report' 400 means the token is not indexed", async () => {
    expect(await call(res(400, { error: "unable to generate report" }))).toMatchObject({ status: "unavailable", reason: expect.stringContaining("not indexed") });
    expect(await call(res(404, { error: "x" }))).toMatchObject({ status: "unavailable", reason: expect.stringContaining("not indexed") });
  });

  it("other failures say what happened", async () => {
    expect(await call(res(429, {}))).toMatchObject({ status: "unavailable", reason: "rate limited by RugCheck" });
    expect(await call(res(503, {}))).toMatchObject({ status: "unavailable", reason: "RugCheck service error, HTTP 503" });
    expect(await call(res(400, { error: "bad input" }))).toMatchObject({ status: "unavailable", reason: "request rejected, HTTP 400" });
    expect(await call(res(403, {}))).toMatchObject({ status: "unavailable", reason: "unexpected response, HTTP 403" });
    expect(await call(vi.fn().mockRejectedValue(new TypeError("fetch failed")))).toMatchObject({ status: "unavailable", reason: "network error" });
  });

  it("a request that never answers times out and is reported as such", async () => {
    const hang = (_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));
    const r = await fetchRugCheck(MINT, { fetchImpl: hang as unknown as typeof fetch, timeoutMs: 30, now: NOW });
    expect(r).toMatchObject({ status: "unavailable", reason: "request timed out" });
  });

  it("records the fetch time on every outcome, and builds the URL from the mint only", async () => {
    const f = res(200, { risks: [] });
    const r = await call(f);
    expect(r.fetchedAt).toBe("2026-10-07T14:05:00.000Z");
    expect(f.mock.calls[0][0]).toBe(`https://rc.test/v1/tokens/${MINT}/report/summary`);
  });

  it("an invalid address never reaches the network", async () => {
    const f = res(200, { risks: [] });
    const r = await fetchRugCheck("BONK/../x", { fetchImpl: f as unknown as typeof fetch, now: NOW });
    expect(r.status).toBe("unavailable");
    expect(f).not.toHaveBeenCalled();
  });
});
