# TypeScript Development Guidelines

## Project layout

- Source: `ts/src/`
- Build output (committed): `ts/dist/`

✅ CORRECT: if you edit `ts/src/**`, regenerate and commit `ts/dist/**`.

## Commands

```bash
cd ts
npm ci
npm run lint
npm run build
npm run check
```

## API snapshots

If you change exports, update snapshots and commit the results:

```bash
./scripts/update-api-snapshots.sh
```

