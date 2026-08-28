"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The section switcher.
 *
 * The only client component in the dashboard, and only because marking the current section
 * needs the pathname. Everything else is a server component reading the database directly.
 */

const SECTIONS: { href: string; label: string }[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/features", label: "Features" },
  { href: "/dashboard/limits", label: "Rate limits" },
  { href: "/dashboard/stickers", label: "Stickers" },
  { href: "/dashboard/memory", label: "Memory" },
  { href: "/dashboard/reminders", label: "Reminders" },
  { href: "/dashboard/summaries", label: "Summaries" },
  { href: "/dashboard/usage", label: "Usage" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sections">
      {SECTIONS.map((s) => {
        // Exact for the overview, prefix for the rest, so a nested page keeps its tab lit.
        const active =
          s.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            className={active ? "active" : ""}
            aria-current={active ? "page" : undefined}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
