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
  { href: "/", label: "Overview" },
  { href: "/features", label: "Features" },
  { href: "/limits", label: "Rate limits" },
  { href: "/stickers", label: "Stickers" },
  { href: "/memory", label: "Memory" },
  { href: "/reminders", label: "Reminders" },
  { href: "/summaries", label: "Summaries" },
  { href: "/usage", label: "Usage" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sections">
      {SECTIONS.map((s) => {
        // Exact for the overview, prefix for the rest, so a nested page keeps its tab lit.
        const active = s.href === "/" ? pathname === "/" : pathname.startsWith(s.href);
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
