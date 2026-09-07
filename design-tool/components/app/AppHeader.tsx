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
    isActive: (pathname: string) => !pathname.startsWith("/dashboard/accommodations"),
  },
  {
    // Route unchanged (slice 8 owns the rename inside); the nav noun is the
    // one teachers recognise — accommodations are an attribute of a student.
    label: "Students",
    href: "/dashboard/accommodations",
    isActive: (pathname: string) => pathname.startsWith("/dashboard/accommodations"),
  },
] as const;

export function AppHeader({ identity }: { identity: string }) {
  const pathname = usePathname();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <header className="bg-band text-band-foreground">
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
            {NAV.map((item) => {
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
