# Migration Guide

AppTheory is designed for “easy migration” from existing patterns, especially Lift in Go. It is not a drop-in replacement.

## Lift → AppTheory (Go)

Start here:
- `docs/migration/from-lift.md`
- `docs/migration/lift-deprecation.md`
- `docs/migration/g4-representative-migration.md`

✅ CORRECT: treat migration as a parity exercise:
- keep behavior equivalent where contract defines it
- document and test any intentional differences

## From raw AWS Lambda handlers

✅ CORRECT: migrate in this order:
1. Wrap your handler logic into an AppTheory handler (Context → Response).
2. Add routes and middleware.
3. Switch the AWS entrypoint to the matching adapter.
4. Add contract tests/examples for the behavior you rely on.

