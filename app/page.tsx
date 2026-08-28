import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { FEATURES, ALWAYS } from "@/lib/features";
import "./landing.css";

/**
 * The public landing page — the one page in this app that is not behind the sign-in.
 *
 * Built to Crafter Station's brand system: forged gold as the only accent, obsidian and titanium
 * as the resting state, Geist throughout, and their motion rule, which is a real constraint
 * rather than a slogan — *motion reveals state, never decorates*. So the hero stages a
 * conversation the way one actually happens rather than animating for its own sake, and the only
 * thing that keeps moving is the status dot, because that reports something true.
 *
 * The capability list is read from `lib/features.ts` rather than written out again here. That
 * registry already exists to stop this exact list rotting in three places at once; a landing page
 * quietly advertising an ability that was removed is the same bug wearing a nicer typeface.
 */

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "wspbot — tag it, it answers",
  description:
    "A WhatsApp bot for group chats. It searches, remembers, makes stickers, keeps the checklist, and posts a digest of what you missed. Built by Crafter Station.",
  openGraph: {
    title: "wspbot — tag it, it answers",
    description:
      "A WhatsApp bot for group chats. It searches, remembers, makes stickers, keeps the checklist, and posts a digest of what you missed.",
    url: "https://wspbot.crafter.run",
    siteName: "wspbot",
    type: "website",
  },
};

const SOURCE = "https://github.com/Jibaru/wspbot";

/** The conversation in the hero. Every line is something the bot genuinely does. */
const THREAD: { who?: string; bot?: boolean; digest?: boolean; body: React.ReactNode }[] = [
  {
    who: "Ana",
    body: (
      <>
        <span className="tag">@wspbot</span> ¿va a llover el viernes en Lima?
      </>
    ),
  },
  { bot: true, body: "Nublado, 18–22°C. Sin lluvia prevista." },
  {
    who: "Beto",
    body: (
      <>
        <span className="tag">@wspbot</span> recuérdame a las 9 mandar la factura
      </>
    ),
  },
  { bot: true, body: "Listo — mañana 09:00." },
  {
    bot: true,
    digest: true,
    body: (
      <>
        <b>Ayer en Deploy</b>
        {"\n"}· Ana arregla el bug del login hoy
        {"\n"}· Deploy confirmado: viernes 15:00
        {"\n"}· Abierto: ¿migramos la base antes?
      </>
    ),
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Add it to a group",
    body: "It sits there quietly. No tag, no reply — a bot that answers everything is a bot people mute.",
  },
  {
    title: "Tag it",
    body: "Ask in plain language, in your language. Reply to a message and tag it, and it reads what you pointed at — the picture included.",
  },
  {
    title: "It gets on with it",
    body: "Searching, remembering, drawing a sticker, setting a reminder, writing the digest. You configure what it may do from the dashboard.",
  },
];

export default function Landing() {
  return (
    <div className={`lp ${geist.variable} ${geistMono.variable}`}>
      <div className="lp-wrap">
        <header className="lp-nav">
          <span className="lp-mark">
            wspbot<span className="lp-dot">.</span>
          </span>
          <nav>
            <a href={SOURCE} target="_blank" rel="noreferrer">
              Source
            </a>
            <Link href="/dashboard" className="lp-signin">
              Sign in
            </Link>
          </nav>
        </header>

        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow" style={{ "--i": 0 } as React.CSSProperties}>
              Crafter Station · WhatsApp
            </p>
            <h1 className="lp-display" style={{ "--i": 1 } as React.CSSProperties}>
              Tag it.
              <br />
              It answers<span className="lp-dot">.</span>
            </h1>
            <p className="lp-sub" style={{ "--i": 2 } as React.CSSProperties}>
              A bot that earns its place in the group chat. It searches when being wrong would
              matter, remembers what you tell it to, makes the sticker, keeps the list — and
              posts a digest of everything you missed.
            </p>
            <div className="lp-actions" style={{ "--i": 3 } as React.CSSProperties}>
              <Link href="/dashboard" className="lp-btn">
                Open the dashboard
              </Link>
              <a href={SOURCE} className="lp-btn ghost" target="_blank" rel="noreferrer">
                Read the source
              </a>
            </div>
            <p className="lp-status" style={{ "--i": 4 } as React.CSSProperties}>
              <span className="lp-pulse" aria-hidden="true" />
              running at wspbot.crafter.run
            </p>
          </div>

          <div className="lp-thread" aria-label="An example conversation">
            <div className="lp-thread-head">
              <span className="lp-avatar" aria-hidden="true">
                CS
              </span>
              Deploy · 6 members
            </div>
            {THREAD.map((m, i) => (
              <div
                key={i}
                className={`lp-msg${m.bot ? " bot" : ""}${m.digest ? " digest" : ""}`}
                style={{ "--i": i } as React.CSSProperties}
              >
                {m.who && <span className="who">{m.who}</span>}
                {m.body}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="lp-wrap">
        <section className="lp-section lp-reveal">
          <p className="lp-kicker">What it does</p>
          <h2 className="lp-h2">Everything, switchable, one at a time.</h2>
          <p className="lp-lead">
            Each of these is a switch on the dashboard. Turning one off takes its tools away from
            the model and the instructions with them, so the bot says the thing is off rather
            than offering to do it.
          </p>
          <ul className="lp-grid">
            {ALWAYS.map((f) => (
              <li key={f.title} className="core">
                <h3>{f.title}</h3>
                <p>{f.detail}</p>
              </li>
            ))}
            {FEATURES.map((f) => (
              <li key={f.key}>
                <h3>{f.title}</h3>
                <p>{f.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-section lp-reveal">
          <p className="lp-kicker">How it works</p>
          <h2 className="lp-h2">Three steps, then it is somebody else&apos;s problem.</h2>
          <ol className="lp-steps">
            {STEPS.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
          <div className="lp-pipeline">
            {"WhatsApp  ──▶  "}
            <b>wapi</b>
            {"  ──▶  webhook  ──▶  "}
            <b>the model</b>
            {"  ──▶  back to the chat\n"}
            {"                            └─▶  Postgres · ffmpeg · web search"}
          </div>
        </section>

        <footer className="lp-footer">
          <span>
            Built by{" "}
            <a href="https://jibaru.dev" target="_blank" rel="noreferrer">
              Jibaru
            </a>{" "}
            of{" "}
            <a href="https://crafter.run" target="_blank" rel="noreferrer">
              Crafter Station
            </a>
            , in Lima.
          </span>
          <span>
            <a href={SOURCE} target="_blank" rel="noreferrer">
              github.com/Jibaru/wspbot
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
