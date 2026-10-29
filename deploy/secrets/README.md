# Local Secrets

Create `api-key-hmac.secret` in this directory before starting Compose.
The file must contain at least 32 bytes and must not be committed.

The E2E suite uses its own deterministic fixture at
`test/fixtures/s10/api-key-hmac.secret`.
