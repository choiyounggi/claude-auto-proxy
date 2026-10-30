const DEFAULT_PORTS = { http: 80, https: 443, socks5: 1080 };

// socks5h is accepted as an alias: the relay always sends the host name to the
// proxy, so there is no local-resolution variant to distinguish.
const SCHEMES = { "http:": "http", "https:": "https", "socks5:": "socks5", "socks5h:": "socks5" };

/**
 * Parses a proxy URL into its parts. Throws with a credential-free message when the
 * URL is malformed or uses an unsupported scheme.
 * @returns {{protocol: "http"|"https"|"socks5", host: string, port: number, username: string|null, password: string|null}}
 */
export function parseProxyUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    // The raw string is not echoed: an unparseable URL may still hold a password.
    throw new Error("invalid proxy url (expected scheme://[user:pass@]host:port)");
  }

  const protocol = SCHEMES[url.protocol];
  if (!protocol) {
    throw new Error(`unsupported proxy scheme "${url.protocol.replace(/:$/, "")}" (use http, https or socks5)`);
  }

  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) {
    throw new Error("proxy url has no host");
  }

  return {
    protocol,
    host,
    port: url.port ? Number(url.port) : DEFAULT_PORTS[protocol],
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null
  };
}

// Status output and logs get pasted into chats and issues, so the display form is
// rebuilt from parsed parts and never contains the user or password. A regex over
// the raw string is not enough: user names may contain "@".
export function redactProxyUrl(raw) {
  let proxy;
  try {
    proxy = parseProxyUrl(raw);
  } catch {
    return "<invalid proxy url>";
  }
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  return `${proxy.protocol}://${proxy.username !== null ? "***@" : ""}${host}:${proxy.port}`;
}

/**
 * Accepts what people type during onboarding: a full URL, or a bare `host:port`,
 * which is taken as an HTTP proxy.
 */
export function normalizeProxyInput(input) {
  const value = String(input ?? "").trim();
  if (value === "") throw new Error("no proxy address given");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}
