# Vendored fonts

Latin-subset variable woff2 files, vendored 2026-08-31 for the first
Fargate deploy (docs/ecs-deploy-plan.md decision 1.4) so `next build`
needs no egress to fonts.googleapis.com. These are the exact files
`next/font/google` self-hosted before the switch (latin subset, normal
style only — italics were never shipped; browsers synthesize oblique).

| File | Face | Axis | Source |
| --- | --- | --- | --- |
| `inter-latin-var.woff2` | Inter | wght 100–900 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 |
| `josefin-sans-latin-var.woff2` | Josefin Sans | wght 100–700 | fonts.gstatic.com/s/josefinsans/v34/Qw3aZQNVED7rKGKxtqIqX5EUDXx4Vn8sig.woff2 |

Licenses: SIL OFL 1.1 — `OFL-inter.txt`, `OFL-josefin-sans.txt`
(from github.com/google/fonts `ofl/inter` and `ofl/josefinsans`).

## Refresh (rarely needed — only for a glyph/axis fix upstream)

Request the CSS API with a browser UA and pull the `/* latin */` block's
URL for each family, then re-download:

```
curl -A "Mozilla/5.0 ... Chrome/126.0 ..." \
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
curl -A "Mozilla/5.0 ... Chrome/126.0 ..." \
  "https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@100..700&display=swap"
```

Keep `app/fonts.ts` weight ranges in sync with the requested axes.
