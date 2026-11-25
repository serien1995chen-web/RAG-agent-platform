# Legacy Office parser fixtures

These gzip-compressed fixtures are test-only copies of Apache POI test data:

- `apache-poi-page-break-before.doc.gz.b64`
  - Source: `apache/poi`, `test-data/document/page-break-before.doc`
  - Original SHA-256: `19ae2de07e16fce156316abcc30210415482e4ac20a21525ee6e53e3432ce1f5`
- `apache-poi-legacy.ppt.gz.b64`
  - Source: `apache/poi`, `test-data/slideshow/clusterfuzz-testcase-minimized-POIHSLFFuzzer-6192650357112832.ppt`
  - Original SHA-256: `9df7b026b8e2f015e5c43c851df153451a54ff638e880df3bcf1de381aea5644`

Apache POI is licensed under the Apache License 2.0. The files are stored
base64-encoded after gzip compression to keep the repository fixture small.
