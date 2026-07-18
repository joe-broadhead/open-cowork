# Helm

The chart lives in `deploy/helm/openwiki`.

```sh
helm upgrade --install openwiki deploy/helm/openwiki \
  --namespace openwiki \
  --create-namespace
```

The chart includes a persistent wiki volume, service, probes, non-root security
context, read-only root filesystem, opt-in ingress, self-ingress NetworkPolicy,
and default-deny egress until allowed destinations are declared.

When ingress is enabled, set `networkPolicy.ingress.from` to the namespace and
pod labels for your ingress controller. Empty ingress sources are intentionally
self-only and will block external controller traffic.

Use digest-pinned images for production. Release images are signed, scanned, and
attested by the image workflow. Chart defaults pin the first public preview tag,
`0.0.0`; `latest` is only a convenience tag.
