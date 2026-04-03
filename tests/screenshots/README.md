# Playwright Screenshots

This directory stores baseline screenshots for visual regression testing.

## Structure

```
tests/screenshots/
├── basic.spec.ts/
│   ├── homepage.png
│   ├── mobile-homepage.png
│   ├── tablet-homepage.png
│   └── desktop-homepage.png
```

## Usage

Baseline screenshots are automatically created on first test run with `--update-snapshots`:

```bash
npx playwright test --update-snapshots
```

Subsequent runs will compare against these baselines and fail if visual differences exceed thresholds.

## Updating Baselines

When UI changes are intentional, update baselines:

```bash
npx playwright test --update-snapshots
```