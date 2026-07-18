# Rate Limiting

OpenWiki includes in-process request limits to protect a single server. Use an
external limiter for any multi-replica, internet-facing, or enterprise
deployment because local process memory is not shared across replicas.

## Recommended Layers

1. Put OpenWiki behind an ingress, API gateway, service mesh, or reverse proxy.
2. Enforce global per-user and per-IP limits at that edge.
3. Keep OpenWiki's local limiter enabled as a defense-in-depth fallback.
4. Use service-account tokens with narrow scopes for agents and automation.

## Suggested Starting Limits

| Surface | Edge limit |
| --- | --- |
| Browser pages | 20 requests/second per user or IP |
| Search and ask endpoints | 5 requests/second per user |
| Source fetch | 1 request/second per user, plus allowlisted hosts |
| MCP over HTTP | 10 requests/second per service account |
| Mutation endpoints | 2 requests/second per user |

Tune limits around your wiki size, source connector latency, and user base.

## Deployment Options

- Nginx: use `limit_req_zone` and `limit_req`; see
  `deploy/proxy/nginx-oauth2-proxy.conf`.
- Kubernetes ingress: use the ingress controller's rate-limit annotations or an
  API gateway in front of the service.
- Cloud Run: put OpenWiki behind Cloud Load Balancing or API Gateway when shared
  global limits are required.
- AWS: use ALB/WAF rate-based rules, API Gateway usage plans, or an Envoy/Nginx
  proxy layer.

The OpenWiki app-level limiter should be treated as a node-local safety rail,
not as the source of truth for distributed quota enforcement.
