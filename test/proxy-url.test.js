import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeProxyInput, parseProxyUrl, redactProxyUrl } from "../src/proxy-url.js";

describe("parseProxyUrl", () => {
  it("parses an http proxy with credentials", () => {
    assert.deepEqual(parseProxyUrl("http://alice:p%40ss@proxy.corp:3128"), {
      protocol: "http",
      host: "proxy.corp",
      port: 3128,
      username: "alice",
      password: "p@ss"
    });
  });

  it("parses socks5 and treats socks5h as the same", () => {
    assert.equal(parseProxyUrl("socks5://127.0.0.1:1055").protocol, "socks5");
    assert.equal(parseProxyUrl("socks5h://127.0.0.1:1055").protocol, "socks5");
  });

  it("fills in default ports", () => {
    assert.equal(parseProxyUrl("http://proxy").port, 80);
    assert.equal(parseProxyUrl("https://proxy").port, 443);
    assert.equal(parseProxyUrl("socks5://proxy").port, 1080);
  });

  it("strips IPv6 brackets", () => {
    assert.equal(parseProxyUrl("http://[::1]:8080").host, "::1");
  });

  it("rejects unsupported schemes", () => {
    assert.throws(() => parseProxyUrl("socks4://proxy:1080"), /unsupported proxy scheme "socks4"/);
    assert.throws(() => parseProxyUrl("ftp://proxy"), /unsupported/);
  });

  it("rejects garbage without echoing credentials", () => {
    assert.throws(() => parseProxyUrl("http://user:secret@"), (error) => !error.message.includes("secret"));
    assert.throws(() => parseProxyUrl(""), /invalid proxy url/);
  });
});

describe("redactProxyUrl", () => {
  it("hides credentials", () => {
    assert.equal(redactProxyUrl("http://alice:secret@proxy:3128"), "http://***@proxy:3128");
  });

  it("hides credentials even when the user name contains @", () => {
    const shown = redactProxyUrl("http://us@er:secret@proxy:3128");
    assert.equal(shown, "http://***@proxy:3128");
    assert.ok(!shown.includes("secret"));
  });

  it("shows credential-free urls with an explicit port", () => {
    assert.equal(redactProxyUrl("socks5://127.0.0.1:1055"), "socks5://127.0.0.1:1055");
    assert.equal(redactProxyUrl("http://[::1]:8080"), "http://[::1]:8080");
  });

  it("never echoes an unparseable url", () => {
    assert.equal(redactProxyUrl("http://user:pa/ss@"), "<invalid proxy url>");
    assert.equal(redactProxyUrl(undefined), "<invalid proxy url>");
  });
});

describe("normalizeProxyInput", () => {
  it("treats a bare host:port as an HTTP proxy", () => {
    assert.equal(normalizeProxyInput(" 100.64.0.10:3128 "), "http://100.64.0.10:3128");
  });

  it("keeps an explicit scheme", () => {
    assert.equal(normalizeProxyInput("socks5://127.0.0.1:1055"), "socks5://127.0.0.1:1055");
  });

  it("rejects empty input", () => {
    assert.throws(() => normalizeProxyInput("   "), /no proxy address/);
  });
});
