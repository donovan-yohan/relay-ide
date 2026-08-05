# Playwright Screenshots

Scratch output for `page.screenshot({ path: ... })` calls. Files here are
**not** baselines, are not compared against anything, and are gitignored.

Real visual baselines live beside their spec, in the directory Playwright owns:

```
test/e2e/
├── basic.spec.ts-snapshots/
│   ├── homepage-chromium-linux.png
│   ├── mobile-homepage-chromium-linux.png
│   ├── tablet-homepage-chromium-linux.png
│   └── desktop-homepage-chromium-linux.png
└── sidebar-mechanics.spec.ts-snapshots/
    └── sidebar-default-no-mechanics-chromium-linux.png
```

Those are committed, and `expect(page).toHaveScreenshot()` fails when a run
diverges from them. A spec whose baseline was never committed is not visual
coverage — Playwright writes the missing file and the assertion has nothing to
compare against, which is the same "reads like coverage, checks nothing" trap
the #1299 audit swept (see `docs/QUALITY.md`).

## Updating baselines

When a UI change is intentional:

```bash
npx playwright test --update-snapshots
```

Baselines are platform-specific (`-chromium-linux`). Regenerate them on the same
platform CI and other developers run, or the diff is noise.
