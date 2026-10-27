# S4 UI Evidence

Screenshots are generated into the ignored `test-results/s4-ui/` directory by:

```bash
pnpm test:e2e
```

Expected files:

```text
test-results/s4-ui/import-360.png
test-results/s4-ui/import-768.png
test-results/s4-ui/import-1200.png
test-results/s4-ui/connectors-360.png
test-results/s4-ui/connectors-768.png
test-results/s4-ui/connectors-1200.png
```

The automated gate checks horizontal overflow, serious/critical axe findings and
console errors for each viewport. Screenshots are not committed.

S4 interaction coverage now also verifies:

- `ACC-UI-01`: loading/empty layout and three viewport accessibility.
- `ACC-UI-02`: text submit and queued parent Job status.
- `ACC-UI-03`: URL SSRF Problem code and trace metadata.
- `ACC-UI-04`: template parser `rowNumber` diagnostics.
- `ACC-UI-05`: API catalog request capture, document selection and import submit.
- `ACC-UI-06`: connector catalog selection, connector import, provider URL
  initialization and connect/update/sync/delete.
- `ACC-UI-07`: conflict preserves input and exposes retry.

The full E2E command result is 4 files / 31 tests. This UI evidence does not
constitute real external provider verification.
