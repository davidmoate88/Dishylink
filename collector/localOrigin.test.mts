import { afterEach, describe, expect, it } from "vitest";
import { isLocalOrigin } from "./localOrigin.mts";

describe("isLocalOrigin", () => {
  afterEach(() => {
    delete process.env.DISHYLINK_TRUSTED_ORIGINS;
  });

  it("accepts LAN and loopback origins and refuses a public one", () => {
    expect(isLocalOrigin("http://192.168.1.20:8080")).toBe(true);
    expect(isLocalOrigin("http://localhost:5173")).toBe(true);
    expect(isLocalOrigin("https://dishy.example.com")).toBe(false);
  });

  it("accepts an origin listed in DISHYLINK_TRUSTED_ORIGINS, exactly", () => {
    process.env.DISHYLINK_TRUSTED_ORIGINS =
      " https://Dishy.example.com/ , https://other.example.org";
    expect(isLocalOrigin("https://dishy.example.com")).toBe(true);
    expect(isLocalOrigin("https://other.example.org")).toBe(true);
    // Scheme, port and subdomain all have to match — no prefix or suffix games.
    expect(isLocalOrigin("http://dishy.example.com")).toBe(false);
    expect(isLocalOrigin("https://dishy.example.com:8443")).toBe(false);
    expect(isLocalOrigin("https://evil.dishy.example.com")).toBe(false);
    expect(isLocalOrigin("https://dishy.example.com.evil.net")).toBe(false);
  });
});
