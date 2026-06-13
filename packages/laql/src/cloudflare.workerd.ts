import { describe, expect, it } from "vitest";

describe("laql/cloudflare", () => {
  it("imports the Cloudflare entrypoint in the Workers runtime", async () => {
    const cloudflare = await import("./cloudflare.js");

    expect(cloudflare.createLake).toBeTypeOf("function");
    expect(cloudflare.r2Store).toBeTypeOf("function");
    expect(cloudflare.memoryStore).toBeTypeOf("function");
  });
});
