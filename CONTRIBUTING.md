# Contributing to Flock

Thanks for helping. Flock is small on purpose, so a short PR with a test is
easiest to review.

## Get going

```bash
npm run demo   # sample data, no n8n needed: http://127.0.0.1:4174
npm test       # 239 tests, no network
```

There is no build step and there are no npm dependencies. Server code is in
`scripts/serve.mjs`, shared logic in `web/lib/*.js` (used by both the server and
the browser), pages in `web/*.html`.

## Ground rules

- **Keep it dependency-free** unless there's no reasonable alternative. Say why
  in the PR if you add one.
- **Logic goes in `web/lib/` as pure functions, with a test in `tests/`.** The
  pages should only render.
- **Don't widen what Flock can write to n8n** without discussing it in an issue
  first. The allowlist in `web/lib/n8n-client.js` is a safety feature.
- **Never render server data as HTML.** Build elements with `el()` from
  `web/lib/ui.js`, which uses `textContent`.
- **No real data in fixtures or screenshots.** Use the demo instance
  (`web/lib/demo.js`) and `example.com` addresses.
- Conventional Commit messages are welcome (`fix:`, `feat:`, `docs:`).

## Screenshots

README images in `docs/media/` come from demo mode at 1440×900, 2× scale.
Retake them when a screen's look changes.
