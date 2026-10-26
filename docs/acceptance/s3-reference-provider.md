# S3 Reference Provider Status

| Provider                      | Status              | Evidence                                                                       |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| Local Mongo Reference Binding | REAL_VERIFIED       | Integration tests exercise upsert, stale, remove, revision and delete blocking |
| App/Workflow Registry mock    | EXTERNAL_UNVERIFIED | Contract-only mock adapter; no external credentials or real service call       |

The mock status must not be reported as real Registry integration.
