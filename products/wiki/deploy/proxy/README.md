# OpenWiki Reverse Proxy Examples

These examples show the hosted auth boundary OpenWiki expects for teams and
enterprises: humans sign in at the proxy or IdP layer, and OpenWiki receives
trusted identity headers plus a shared proxy secret.

The examples are starting points. Replace placeholder domains, TLS settings, and
oauth2-proxy endpoints before applying them. Mount proxy shared secrets from your
secret manager; do not paste production secrets into the example config.

## Nginx + oauth2-proxy

`nginx-oauth2-proxy.conf` protects the browser and HTTP API with oauth2-proxy,
strips spoofable inbound identity headers, and injects the trusted OpenWiki
headers only after oauth2-proxy authorizes the request.

OpenWiki runtime settings for this example:

```sh
OPENWIKI_TRUST_AUTH_HEADERS=1
OPENWIKI_TRUST_AUTH_HEADERS_SECRET=<same value as nginx X-OpenWiki-Proxy-Secret>
OPENWIKI_PUBLIC_ORIGIN=https://wiki.example.com
```

Mount or generate `/etc/nginx/openwiki/openwiki-proxy-secret.conf` from your
secret manager with a single Nginx variable assignment:

```nginx
set $openwiki_proxy_secret "<same value as OPENWIKI_TRUST_AUTH_HEADERS_SECRET>";
```

Pair this with an ingress, load balancer, or API gateway rate limiter for
multi-replica deployments. The application also keeps its local in-process rate
limits as a single-node safety net.
