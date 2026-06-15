# Conformance

The main test and fixture lanes are deterministic and do not use the network.
External conformance inputs are opt-in under `fixtures/external/`.

Fetch Apache parquet-testing files with:

```sh
pnpm fixtures:external
```

Iceberg conformance inputs are discovered under
`fixtures/external/iceberg-reference/`. Put reference warehouse directories there;
the conformance lane looks for `metadata.json` and `*.metadata.json` files and loads
their sibling JSON/Avro manifest metadata through `@laql/iceberg`.

Then run the conformance lane:

```sh
pnpm test:conformance
```

Pass `--force` to replace an existing external checkout:

```sh
pnpm fixtures:external -- --force
```
