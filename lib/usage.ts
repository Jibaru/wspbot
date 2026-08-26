import "server-only";
import { query } from "./db";

/**
 * What the bot has spent.
 *
 * OpenAI does publish this — `/v1/organization/usage/completions` and `/v1/organization/costs`
 * — but both require the `api.usage.read` scope, which means an Admin key. This app holds a
 * project key and has no business holding an org-wide admin credential just to count its own
 * tokens. So it counts them itself, which is also the more useful number: what *this bot* cost,
 * not what the whole organisation did.
 *
 * Token counts are exact, straight from the API response. Money is an estimate, and only shown
 * for models whose published rates are known — a confidently wrong spend figure is worse than
 * none, because it is the kind of number people budget against.
 */

export type Kind = "reply" | "vision" | "speech" | "image";

/**
 * Structural rather than the SDK type, because image generation reports a narrower usage shape
 * than language models do — no token details — and both need to be recordable here.
 */
type AnyUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
};

/** USD per million tokens. Published rates as of 2026-07-30; override with env if they move. */
const RATES: Record<string, { input: number; output: number }> = {
  "gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
};

/**
 * A model id not in the table is left unpriced rather than guessed at. `gpt-5.6` on its own is
 * an alias whose tier is not published, which is exactly the case where a guess would mislead:
 * set OPENAI_PRICE_INPUT and OPENAI_PRICE_OUTPUT (USD per million tokens) to price it.
 */
const rateFor = (model: string): { input: number; output: number } | null => {
  const envIn = Number(process.env["OPENAI_PRICE_INPUT"]);
  const envOut = Number(process.env["OPENAI_PRICE_OUTPUT"]);
  if (envIn > 0 && envOut > 0) return { input: envIn, output: envOut };
  return RATES[model] ?? null;
};

/**
 * Never let accounting break a reply. A failed insert costs a row in a report; a thrown error
 * costs the answer someone was waiting for.
 */
export const record = async (entry: {
  kind: Kind;
  model: string;
  chat?: string;
  usage?: AnyUsage;
  characters?: number;
}): Promise<void> => {
  try {
    await query(
      `insert into model_usage (kind, model, input_tokens, output_tokens, cached_tokens, characters, chat)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.kind,
        entry.model,
        entry.usage?.inputTokens ?? 0,
        entry.usage?.outputTokens ?? 0,
        entry.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        entry.characters ?? 0,
        entry.chat ?? null,
      ],
    );
  } catch (err) {
    console.warn("[usage] could not record:", err instanceof Error ? err.message : err);
  }
};

export type Totals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  characters: number;
  /** null when no rate is known for the models involved. */
  estimatedUsd: number | null;
};

type Row = {
  model: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  characters: string;
};

/** Grouped by model, because that is what makes a cost estimate possible at all. */
const totalsSince = async (interval: string): Promise<Totals> => {
  const rows = await query<Row>(
    `select model,
            count(*)                  as calls,
            sum(input_tokens)::text   as input_tokens,
            sum(output_tokens)::text  as output_tokens,
            sum(cached_tokens)::text  as cached_tokens,
            sum(characters)::text     as characters
       from model_usage
      where at > now() - $1::interval
      group by model`,
    [interval],
  );

  const totals: Totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    characters: 0,
    estimatedUsd: 0,
  };
  let priced = true;

  for (const row of rows) {
    const input = Number(row.input_tokens ?? 0);
    const output = Number(row.output_tokens ?? 0);
    totals.calls += Number(row.calls);
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cachedTokens += Number(row.cached_tokens ?? 0);
    totals.characters += Number(row.characters ?? 0);

    const rate = rateFor(row.model);
    // Speech rows carry no tokens, so an unpriced speech model costs the estimate nothing.
    if (!rate && input + output > 0) priced = false;
    if (rate && totals.estimatedUsd !== null) {
      totals.estimatedUsd += (input / 1e6) * rate.input + (output / 1e6) * rate.output;
    }
  }

  if (!priced) totals.estimatedUsd = null;
  return totals;
};

export const summary = async (): Promise<{
  today: Totals;
  week: Totals;
  allTime: Totals;
}> => {
  const [today, week, allTime] = await Promise.all([
    totalsSince("1 day"),
    totalsSince("7 days"),
    totalsSince("100 years"),
  ]);
  return { today, week, allTime };
};

const money = (usd: number | null): string =>
  usd === null
    ? "cost unknown for this model — set OPENAI_PRICE_INPUT and OPENAI_PRICE_OUTPUT to price it"
    : usd < 0.01
      ? "under $0.01"
      : `about $${usd.toFixed(2)}`;

const thousands = (n: number): string => n.toLocaleString("en-US");

const line = (label: string, t: Totals): string =>
  `${label}: ${thousands(t.inputTokens + t.outputTokens)} tokens over ${t.calls} calls ` +
  `(${thousands(t.inputTokens)} in, ${thousands(t.outputTokens)} out` +
  `${t.cachedTokens > 0 ? `, ${thousands(t.cachedTokens)} cached` : ""}) — ${money(t.estimatedUsd)}`;

/** Plain prose, because it is read out loud into a chat rather than rendered as a table. */
export const report = async (): Promise<string> => {
  const { today, week, allTime } = await summary();
  if (allTime.calls === 0) return "Nothing recorded yet.";
  return [
    line("Today", today),
    line("Last 7 days", week),
    line("All time", allTime),
    allTime.characters > 0
      ? `Voice notes: ${thousands(allTime.characters)} characters spoken (billed separately, not counted above).`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
};
