# Parity fixtures

`layout-*.json` are produced by the TypeScript implementation in
`packages/domain/src/calendar` so `ParityTests.swift` can prove the Swift port
matches it on randomised input (seeded, reproducible). Regenerate after any
change to the TS layout, all-day, or paging code:

```bash
cd packages/domain
for tz in America/Los_Angeles Asia/Kolkata; do
  TZ=$tz bun ../../apps/ios/Packages/QaliDomain/Tests/QaliDomainTests/Fixtures/gen-fixture.ts \
    > ../../apps/ios/Packages/QaliDomain/Tests/QaliDomainTests/Fixtures/layout-${tz//\//-}.json
done
```

The colour expectations in `ParityTests.swift` were captured the same way
from `colors.ts`.
