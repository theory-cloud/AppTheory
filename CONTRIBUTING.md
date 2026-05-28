# Contributing to AppTheory

Thank you for your interest in AppTheory. This document explains how to report issues, run tests, and submit changes.

## Reporting Issues

Open a [GitHub issue](https://github.com/theory-cloud/AppTheory/issues) with:

- What you expected to happen
- What actually happened
- Runtime and language (Go, TypeScript, or Python)
- Minimal reproduction steps

## Development Setup

```bash
git clone https://github.com/theory-cloud/AppTheory.git
cd AppTheory

# Go
go mod download

# TypeScript
(cd ts && npm ci)

# Python
(cd py && python -m pip install -e .)

# CDK
(cd cdk && npm ci)
```

Prerequisites: Go 1.26+, Node.js 24+, Python 3.14+, `make`, `git`.

## Running Tests

```bash
# Go unit tests
go test ./runtime/... ./pkg/... ./testkit/...

# TypeScript tests
(cd ts && npm run check)

# Python tests
(cd py && python -m pytest)

# CDK construct tests
(cd cdk && npm test)

# Contract tests (cross-language parity)
make contract-tests
```

**Contract tests are required.** Any change that affects cross-language behavior must pass all three language runners.
The contract test fixtures in `contract-tests/fixtures/` define the expected behavior — the Go, TypeScript, and Python
runtimes are independently verified against these fixtures.

## Pull Requests

1. Fork the repository and create a branch from `main`.
2. Make your changes. Add or update tests as needed.
3. Ensure all tests pass, including contract tests if your change affects runtime behavior.
4. Open a pull request with a clear description of what changed and why.

Keep PRs focused. One logical change per PR is easier to review than a bundle of unrelated changes.

### Authoring documentation

The documentation site under `docs/` is published to <https://theory-cloud.github.io/apptheory/> on every push to `main` by `.github/workflows/pages.yml`. The site is built with Jekyll; the layouts, includes, CSS, and JS are portable across all Theory Cloud frameworks.

When adding or modifying a documentation page:

- **Front matter.** Every markdown page that should render through the docs layout needs `---\ntitle: …\n---` at the top. Without it, Jekyll treats the file as a static asset and skips the layout.
- **Surface tinting.** To put a page on the violet "MCP" surface, add `surface: mcp` to its front matter (or to the matching `defaults` scope in `docs/_config.yml`). Available surfaces: `core`, `mcp`, `auth`, `journal`.
- **Nav placement.** Add the page to `docs/_data/nav.yml` in the right group, then add its id to `order:` (for the prev/next pager) and to `url_to_id:` (for the active-link highlighter).
- **Cross-links.** Use **markdown filesystem paths** in relative links, not Jekyll pretty-URLs. From `docs/features/foo.md`, link to `docs/getting-started.md` as `[x](../getting-started.md)` — not `[x](../../getting-started/)`. The doc-integrity verifier resolves links pre-Jekyll, and the `jekyll-relative-links` plugin handles `.md → URL` conversion at build time.
- **Callouts.** Use `{% include callout.html type="info" title="..." content=body %}` for highlighted notes; `type` can be `info`, `warn`, or `danger`.
- **Code blocks.** Fenced triple-backtick blocks with a language tag are auto-styled by the Rouge highlighter and the Theory Cloud syntax theme; the `Copy` button is added client-side by `docs/assets/js/docs.js`.
- **Anchors.** Keep heading text alphanumeric for any heading that gets anchor-linked from elsewhere — kramdown's slugifier disagrees with GitHub's on special characters (parens, slashes).

Local preview:

```bash
docker run --rm -p 4000:4000 --volume="$PWD/docs:/srv/jekyll" \
  --workdir=/srv/jekyll ruby:3.3-slim \
  sh -c "apt-get update -qq >/dev/null && \
         apt-get install -y -qq --no-install-recommends build-essential >/dev/null && \
         bundle install --quiet && \
         bundle exec jekyll serve \
           --source . --destination ./_site \
           --host 0.0.0.0 --port 4000 --baseurl ''"
```

Then open <http://localhost:4000/>.

## Code of Conduct

Be respectful, constructive, and professional. We're building tools that people rely on in production.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
