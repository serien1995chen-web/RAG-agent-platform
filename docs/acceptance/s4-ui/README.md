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
