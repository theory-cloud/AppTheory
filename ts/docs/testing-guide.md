# TypeScript Testing Guide

Run the TypeScript package checks here when you want package-focused feedback. For the canonical cross-language
verification flow, use `docs/testing-guide.md`.

## Package checks

```bash
cd ts
npm ci
npm run check
```

## Contract parity (cross-language)

Run from repo root:

```bash
./scripts/verify-contract-tests.sh
```

## Full repo gates

```bash
make rubric
```
