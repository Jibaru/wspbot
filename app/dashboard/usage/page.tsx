import { query } from "@/lib/db";
import * as usage from "@/lib/usage";
import { settle, money, tokens } from "../shared";

/**
 * What it has cost.
 *
 * Split by model and by kind because the three kinds are billed in three different units —
 * language per token, speech per character, images per image. Adding them together produced a
 * single figure that went to "cost unknown" the moment one unpriced image model appeared.
 */

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const [spend, byModel] = await Promise.all([
    settle(usage.summary()),
    settle(
      query<{
        model: string;
        kind: string;
        calls: string;
        input_tokens: string;
        output_tokens: string;
        characters: string;
        last_at: Date;
      }>(
        `select model, kind,
                count(*)::text                  as calls,
                sum(input_tokens)::text         as input_tokens,
                sum(output_tokens)::text        as output_tokens,
                sum(characters)::text           as characters,
                max(at)                         as last_at
           from model_usage
          group by model, kind
          order by max(at) desc`,
      ),
    ),
  ]);

  return (
    <>
      <p className="lede">
        Recorded here rather than read back from OpenAI: their usage and cost endpoints need an
        Admin key, which this app does not have and should not need.
      </p>

      <h2>Totals</h2>
      <div className="panel">
        {spend === null ? (
          <p className="empty">Could not read usage.</p>
        ) : spend.allTime.calls === 0 ? (
          <p className="empty">Nothing recorded yet.</p>
        ) : (
          <dl>
            {(
              [
                ["Today", spend.today],
                ["Last 7 days", spend.week],
                ["All time", spend.allTime],
              ] as const
            ).map(([label, t]) => (
              <div className="row" key={label}>
                <dt>{label}</dt>
                <dd>
                  {tokens(t.inputTokens + t.outputTokens)} tokens · {t.calls} calls ·{" "}
                  {money(t.estimatedUsd)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {spend && spend.allTime.calls > 0 && (
          <p className="meta" style={{ marginTop: "0.7rem" }}>
            {spend.allTime.characters > 0 &&
              `${tokens(spend.allTime.characters)} characters spoken. `}
            {spend.allTime.images > 0 && `${spend.allTime.images} stickers drawn. `}
            Both are billed in their own units and are not part of the token figures.
            {spend.allTime.estimatedUsd === null && (
              <>
                {" "}
                No published rate for the models involved — set{" "}
                <code>OPENAI_PRICE_INPUT</code> and <code>OPENAI_PRICE_OUTPUT</code> (USD per
                million tokens) to show cost.
              </>
            )}
          </p>
        )}
      </div>

      <h2>By model</h2>
      <div className="panel">
        {byModel === null ? (
          <p className="empty">Could not read the usage table.</p>
        ) : byModel.length === 0 ? (
          <p className="empty">Nothing recorded yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Kind</th>
                  <th className="num">Calls</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Chars</th>
                </tr>
              </thead>
              <tbody>
                {byModel.map((r) => (
                  <tr key={`${r.model}:${r.kind}`}>
                    <td>
                      <code>{r.model}</code>
                    </td>
                    <td>{r.kind}</td>
                    <td className="num">{tokens(Number(r.calls))}</td>
                    <td className="num">{tokens(Number(r.input_tokens))}</td>
                    <td className="num">{tokens(Number(r.output_tokens))}</td>
                    <td className="num">
                      {Number(r.characters) ? tokens(Number(r.characters)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
