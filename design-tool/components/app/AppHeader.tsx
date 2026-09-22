"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FeedbackDialog } from "@/components/app/FeedbackDialog";
import { cn } from "@/lib/utils";

/**
 * UX pass 1, slice 2 (docs/ux-pass-1-proposal.md §1.3, §2.1): the one
 * persistent header for every /dashboard route. Pacific band, PSD emblem +
 * wordmark, two nav nouns, the signed-in address and Sign out. Before this
 * every page hand-rolled its own "← Back to …" link and only the dashboard
 * showed who was signed in (as the Google `sub`).
 */
const NAV = [
  {
    label: "Assessments",
    href: "/dashboard",
    // Slice 5 added a second top-level route (/admin), so "everything that is
    // not Students" is no longer the same thing as "the assessments area".
    isActive: (pathname: string) =>
      pathname.startsWith("/dashboard") &&
      !pathname.startsWith("/dashboard/accommodations"),
  },
  {
    // Route unchanged (slice 8 owns the rename inside); the nav noun is the
    // one teachers recognise — accommodations are an attribute of a student.
    label: "Students",
    href: "/dashboard/accommodations",
    isActive: (pathname: string) => pathname.startsWith("/dashboard/accommodations"),
  },
] as const;

/**
 * Access slice 5 (docs/access-model-design.md, D-8): the act-as banner and the
 * admin-only nav noun.
 *
 * `actorEmail` is set only while the session carries `actor_*` — the admin who
 * is really at the keyboard. The strip is deliberately unmissable and on EVERY
 * dashboard page rather than only the home: the whole hazard of act-as is
 * forgetting you are in it and reading a colleague's screen as your own.
 *
 * `admin` is `isAdmin(session)`, which is FALSE while impersonating, so the
 * Admin link disappears for the duration — the two never show together.
 */
export function AppHeader({
  identity,
  actorEmail = null,
  admin = false,
}: {
  identity: string;
  actorEmail?: string | null;
  admin?: boolean;
}) {
  const pathname = usePathname();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <header className="bg-band text-band-foreground">
      {actorEmail ? (
        <div className="bg-warning text-warning-foreground">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-1.5 text-sm">
            <span>
              Acting as <strong className="font-semibold">{identity}</strong> ·
              signed in as {actorEmail}
            </span>
            {/* A plain form POST, not a fetch: this is the way out of a
                session that is not yours, so it must work on a page whose
                JavaScript has failed. */}
            <form action="/api/admin/impersonate/stop" method="post" className="ml-auto">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="border-warning-foreground/40 bg-transparent text-warning-foreground hover:bg-warning-foreground/10"
              >
                Stop
              </Button>
            </form>
          </div>
        </div>
      ) : null}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 py-3 font-heading text-lg font-bold tracking-wide"
        >
          <Image
            src="/brand/psd-emblem-white.png"
            alt="Peninsula School District"
            width={28}
            height={28}
            priority
          />
          Secure-Test
        </Link>
        <nav aria-label="Primary">
          <ul className="flex gap-6">
            {[
              ...NAV,
              // Slice 5: admin-only, and appended rather than woven in so a
              // non-admin's header is byte-for-byte what it was.
              ...(admin
                ? [
                    {
                      label: "Admin",
                      href: "/admin",
                      isActive: (p: string) => p.startsWith("/admin"),
                    },
                  ]
                : []),
            ].map((item) => {
              const active = item.isActive(pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-block border-b-2 py-3.5 text-sm font-medium transition-colors",
                      active
                        ? "border-brand text-band-foreground"
                        : "border-transparent text-band-foreground/75 hover:text-band-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFeedbackOpen(true)}
            className="text-band-foreground hover:bg-band-foreground/10 hover:text-band-foreground"
          >
            Send feedback
          </Button>
          <span className="text-band-foreground/80">{identity}</span>
          <form action="/api/auth/logout" method="post">
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-band-foreground hover:bg-band-foreground/10 hover:text-band-foreground"
            >
              Sign out
            </Button>
          </form>
        </div>
      </div>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
}
