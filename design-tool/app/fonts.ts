import localFont from "next/font/local";

/**
 * UX pass 1, slice 1 (docs/ux-pass-1-proposal.md §1.2), re-based on
 * vendored files for the ECS deploy (docs/ecs-deploy-plan.md, decision
 * 1.4): the latin-subset variable woff2 files Google serves for
 * Inter:wght@100..900 and Josefin+Sans:wght@100..700 live in app/fonts/
 * — the same bytes next/font/google used to download at build time, so
 * the Docker image build needs no network egress and a teacher's
 * browser still never contacts Google. Provenance + refresh recipe:
 * app/fonts/README.md. The CSS variables are consumed by the
 * `--font-sans` / `--font-heading` theme tokens in app/globals.css.
 */
export const inter = localFont({
  src: "./fonts/inter-latin-var.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-inter",
});

export const josefinSans = localFont({
  src: "./fonts/josefin-sans-latin-var.woff2",
  weight: "100 700",
  style: "normal",
  display: "swap",
  variable: "--font-josefin-sans",
});
