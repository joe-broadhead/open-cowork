# Output Contracts

## JSON (default)

JSON is the source-of-truth. All tools return structured JSON.

## Structured errors

```json
{
  "error": {
    "error_code": "INVALID_PARAMS",
    "message": "invalid IANA timezone name: Madrid",
    "details": { "parameter": "timezone", "value": "Madrid" }
  }
}
```

## MCP output

MCP tools return JSON text content on success. Failures surface as `isError: true` with JSON error envelope.

## Evidence standard

When reporting results, preserve:
- Tool or command used
- Timezone input and resolved timezone
- Date range
- Whether holidays were included
- Timer data directory when timers were mutated
- Error details when a call failed
