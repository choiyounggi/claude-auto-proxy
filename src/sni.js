// Reads the server name a TLS client asks for, without terminating TLS. The relay
// only needs to know where to tunnel; the bytes it inspects are forwarded untouched.

export const NEED_MORE = Symbol("need-more");

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const MAX_RECORD = 18432;
const MAX_HANDSHAKE = 65536;
// Real clients send the ClientHello in one record, rarely two. Capping the count keeps
// a local process from feeding thousands of tiny records to burn the daemon's CPU.
const MAX_RECORDS = 4;
const HOSTNAME = /^[a-z0-9.-]+$/;

/**
 * Returns the SNI host name (lower-cased), null when the bytes are not a ClientHello
 * carrying one, or NEED_MORE when the ClientHello has not fully arrived yet.
 * A ClientHello may be split across several handshake records; they are joined.
 */
export function extractSni(buf) {
  const fragments = [];
  let collected = 0;
  let offset = 0;
  let handshakeLength = null;

  for (;;) {
    if (buf.length < offset + 5) return NEED_MORE;
    if (buf[offset] !== RECORD_HANDSHAKE) return null;

    const recordLength = buf.readUInt16BE(offset + 3);
    if (recordLength === 0 || recordLength > MAX_RECORD) return null;
    if (buf.length < offset + 5 + recordLength) return NEED_MORE;

    if (fragments.length === MAX_RECORDS) return null;
    fragments.push(buf.subarray(offset + 5, offset + 5 + recordLength));
    collected += recordLength;
    offset += 5 + recordLength;

    if (collected < 4) continue;
    const handshake = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
    if (handshakeLength === null) {
      if (handshake[0] !== HANDSHAKE_CLIENT_HELLO) return null;
      handshakeLength = handshake.readUIntBE(1, 3);
      if (handshakeLength > MAX_HANDSHAKE) return null;
    }
    if (collected >= 4 + handshakeLength) {
      return parseClientHello(handshake.subarray(4, 4 + handshakeLength));
    }
  }
}

function parseClientHello(body) {
  try {
    let p = 0;
    const need = (n) => {
      if (p + n > body.length) throw new RangeError("truncated ClientHello");
    };

    need(2 + 32); // legacy_version + random
    p += 34;
    need(1);
    const sessionIdLength = body[p];
    p += 1;
    need(sessionIdLength);
    p += sessionIdLength;
    need(2);
    const cipherSuitesLength = body.readUInt16BE(p);
    p += 2;
    need(cipherSuitesLength);
    p += cipherSuitesLength;
    need(1);
    const compressionLength = body[p];
    p += 1;
    need(compressionLength);
    p += compressionLength;

    if (p === body.length) return null; // no extensions at all
    need(2);
    const extensionsLength = body.readUInt16BE(p);
    p += 2;
    need(extensionsLength);
    const end = p + extensionsLength;

    while (p + 4 <= end) {
      const type = body.readUInt16BE(p);
      const length = body.readUInt16BE(p + 2);
      p += 4;
      if (p + length > end) return null;
      if (type === EXTENSION_SERVER_NAME) {
        return parseServerNameList(body.subarray(p, p + length));
      }
      p += length;
    }
    return null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function parseServerNameList(ext) {
  if (ext.length < 2) return null;
  const listEnd = Math.min(ext.length, 2 + ext.readUInt16BE(0));
  let p = 2;
  while (p + 3 <= listEnd) {
    const nameType = ext[p];
    const nameLength = ext.readUInt16BE(p + 1);
    p += 3;
    if (p + nameLength > listEnd) return null;
    if (nameType === 0) {
      const name = ext.subarray(p, p + nameLength).toString("latin1").toLowerCase();
      return HOSTNAME.test(name) ? name : null;
    }
    p += nameLength;
  }
  return null;
}
