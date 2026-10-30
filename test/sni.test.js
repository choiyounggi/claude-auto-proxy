import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSni, NEED_MORE } from "../src/sni.js";
import { captureClientHello } from "./helpers.js";

describe("extractSni", () => {
  it("reads the server name from a real ClientHello", async () => {
    const hello = await captureClientHello({ servername: "api.anthropic.com" });
    assert.equal(extractSni(hello), "api.anthropic.com");
  });

  it("lower-cases the name", async () => {
    const hello = await captureClientHello({ servername: "API.Anthropic.COM" });
    assert.equal(extractSni(hello), "api.anthropic.com");
  });

  it("asks for more bytes while the ClientHello is incomplete", async () => {
    const hello = await captureClientHello({ servername: "api.anthropic.com" });
    assert.equal(extractSni(hello.subarray(0, 3)), NEED_MORE);
    assert.equal(extractSni(hello.subarray(0, hello.length - 1)), NEED_MORE);
    assert.equal(extractSni(Buffer.alloc(0)), NEED_MORE);
  });

  it("joins a ClientHello split across two handshake records", async () => {
    const hello = await captureClientHello({ servername: "claude.ai" });
    const body = hello.subarray(5);
    const cut = 40;
    const record = (payload) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01, payload.length >> 8, payload.length & 0xff]), payload]);
    const split = Buffer.concat([record(body.subarray(0, cut)), record(body.subarray(cut))]);
    assert.equal(extractSni(split), "claude.ai");
    assert.equal(extractSni(split.subarray(0, 5 + cut)), NEED_MORE);
  });

  it("returns null when the client sends no server name", async () => {
    // Node omits SNI when connecting to an IP address without a servername.
    const hello = await captureClientHello({});
    assert.equal(extractSni(hello), null);
  });

  it("returns null for bytes that are not a TLS handshake", () => {
    assert.equal(extractSni(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n")), null);
  });

  it("returns null for a handshake record that is not a ClientHello", () => {
    const serverHello = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);
    assert.equal(extractSni(serverHello), null);
  });

  it("returns null instead of throwing on a corrupted ClientHello", async () => {
    const hello = Buffer.from(await captureClientHello({ servername: "api.anthropic.com" }));
    hello[5 + 4 + 34] = 0xff; // session id length now runs past the end
    assert.equal(extractSni(hello), null);
  });

  it("gives up after a handful of records instead of collecting tiny ones forever", () => {
    const tiny = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x01, 0x01]);
    assert.equal(extractSni(Buffer.concat([tiny, tiny, tiny, tiny, tiny])), null);
  });

  it("rejects an oversized record length", () => {
    assert.equal(extractSni(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff])), null);
  });
});
