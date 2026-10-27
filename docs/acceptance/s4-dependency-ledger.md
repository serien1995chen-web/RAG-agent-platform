# S4 Dependency Ledger

Status: `INSTALLED_AND_LOCKED`

## Installation

| Field                 | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Branch                | `feat/kb-s04-ingestion-connectors`                                 |
| Before lock SHA-256   | `13eb46427cfc97099fa677637209acc881aaba0b080469902dd3559fa788bf7a` |
| User command          | `pnpm install`                                                     |
| After lock SHA-256    | `38505cc285e6359534a75b418e9621d5c10ce405b02d15449c7a1fd784bd2982` |
| Declared dependencies | 24                                                                 |
| Catalog entries       | 131                                                                |
| Resolution            | 24/24 exact, `MISSING=0`                                           |

## Packages

```text
@apidevtools/json-schema-ref-parser@11.7.2
@apidevtools/swagger-parser@10.1.1
openapi-types@12.1.3
jsonpath-plus@10.3.0
ajv@8.17.1
form-data@4.0.4
proxy-agent@6.5.0
http-proxy-agent@7.0.2
https-proxy-agent@7.0.6
proxy-from-env@1.1.0
proxy-addr@2.0.7
ipaddr.js@2.4.0
encoding@0.1.13
iconv-lite@0.6.3
jschardet@3.1.1
domino-ext@2.1.4
@xmldom/xmldom@0.8.15
multer@2.4.0
@types/async-retry@1.4.9
@types/js-yaml@4.0.9
@types/papaparse@5.3.7
@types/proxy-from-env@1.0.4
@types/tunnel@0.0.4
@types/multer@1.4.12
```

## License Gate

`pnpm license:check` exits 0 with five release blockers:

```text
argparse@2.0.1 | Python-2.0
caniuse-lite@1.0.30001814 | CC-BY-4.0
jschardet@3.1.1 | LGPL-2.1+
pako@1.0.11 | MIT AND Zlib
sax@1.6.1 | BlueOak-1.0.0
```

All five are `pending-legal-review` and `releaseBlocking=true`; none is legally
approved. They block release, not CI.
