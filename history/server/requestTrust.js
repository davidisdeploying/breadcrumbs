import net from 'node:net';

const TAILSCALE_V4_NETWORK = ipv4ToInt('100.64.0.0');
const TAILSCALE_V4_MASK = ipv4ToInt('255.192.0.0');
const TAILSCALE_V6_PREFIX = 'fd7a:115c:a1e0:';

function ipv4ToInt(address) {
  const octets = String(address).split('.').map(Number);
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return (
    ((octets[0] << 24) >>> 0)
    + (octets[1] << 16)
    + (octets[2] << 8)
    + octets[3]
  ) >>> 0;
}

export function normalizePeerAddress(address) {
  let normalized = String(address || '').trim().toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7);
  return normalized;
}

export function isLoopbackPeer(address) {
  const normalized = normalizePeerAddress(address);
  if (normalized === '::1') return true;
  const ipv4 = ipv4ToInt(normalized);
  return ipv4 !== null && (ipv4 >>> 24) === 127;
}

export function isTailnetPeer(address) {
  const normalized = normalizePeerAddress(address);
  if (net.isIP(normalized) === 6) return normalized.startsWith(TAILSCALE_V6_PREFIX);
  const ipv4 = ipv4ToInt(normalized);
  return ipv4 !== null && (ipv4 & TAILSCALE_V4_MASK) === TAILSCALE_V4_NETWORK;
}

export function parseTrustedAccessProxyPeers(value = process.env.BREADCRUMBS_ACCESS_PROXY_PEERS) {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizePeerAddress)
      .filter(Boolean),
  );
}

function hasAccessAssertion(headers = {}) {
  const value = headers['cf-access-jwt-assertion'];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim());
  return Boolean(String(value || '').trim());
}

export function classifyApiTrust({
  remoteAddress,
  headers = {},
  accessProxyPeers = parseTrustedAccessProxyPeers(),
}) {
  const peer = normalizePeerAddress(remoteAddress);

  if (hasAccessAssertion(headers) && accessProxyPeers.has(peer)) {
    return { trusted: true, channel: 'cloudflare-access', peer };
  }
  if (isLoopbackPeer(peer)) {
    return { trusted: true, channel: 'loopback', peer };
  }
  if (isTailnetPeer(peer)) {
    return { trusted: true, channel: 'tailnet', peer };
  }
  return { trusted: false, channel: 'untrusted', peer };
}

export function createApiTrustMiddleware({
  accessProxyPeers = parseTrustedAccessProxyPeers(),
  onDenied = ({ method, originalUrl, peer }) => {
    console.warn(`breadcrumbs-api denied untrusted peer=${peer || 'unknown'} method=${method} path=${originalUrl}`);
  },
} = {}) {
  return function requireTrustedApiPeer(req, res, next) {
    const trust = classifyApiTrust({
      remoteAddress: req.socket?.remoteAddress,
      headers: req.headers,
      accessProxyPeers,
    });
    if (trust.trusted) {
      next();
      return;
    }

    onDenied?.({
      method: req.method,
      originalUrl: req.originalUrl,
      peer: trust.peer,
    });
    res.status(403).json({ error: 'trusted network or Cloudflare Access required' });
  };
}
