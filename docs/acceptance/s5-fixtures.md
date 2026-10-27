# S5 Deterministic Fixtures

Generator: `test/fixtures/s5/generate-fixtures.ts`

Manifest: `test/fixtures/s5/fixture-manifest.json`

The generator uses fixed content and zero-based ZIP metadata. Tests recompute
SHA-256 values and compare them with the manifest.

| Fixture     | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| text        | `920bbecf3e7fc78fcb184474fdb8f804be31ae486a5bef1b4c24f6f3185e92c3` |
| markdown    | `1fec9af5e1ebd618532954bef59a205f9c18952cac403098915341027b7a22f7` |
| html        | `fc64f014cf757d9bea724ffa24a6427169956f8541e2b72a88873066c5989f45` |
| csv         | `77d064f2fb34c79b756b6f7f419fc4052fa074b63394fdd4c20bbd134145b798` |
| pdf         | `b58e1ccc1778d496eb94a6f59c021a17b537966329c074197fe48c7f998766ca` |
| docx        | `08b0d1e14e2ac6124f78570158a8e6581c39aefb05f97249492b52f748a6d97e` |
| pptx        | `20a23e11d3ac9769673e10a9a840878fcef22175872a1007d655bf53ad76384a` |
| xlsx        | `5925605d8eaff1be27605ad95f8f3a4c5624fcb879acb603717ffdc2c15d68d6` |
| epub        | `b633128e14abc7059064790490c19ff5f5456c32e24fcb47eb0a7d273e15b699` |
| ofd         | `025bcbbb2de721493ff00d126eb7878a9cff4b513aa784a6a1aff6b3eca6f8e0` |
| hostile zip | `8d73d7dd85523a0d69f705fd85aae69ce70d36f9940f3e507864d6b3183dcf82` |

Hostile and failure fixtures are synthetic. No customer data or network-downloaded
fixture is used.
