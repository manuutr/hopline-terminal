import { Check, Play } from "lucide-react";
import type { AgentSuggestion } from "@shared/types";
import { Badge, Button, cn, Tooltip } from "../../design";
import { useAi, type Entry } from "./store";

const LABEL: Record<
  AgentSuggestion["kind"],
  { tone: "neutral" | "warn" | "danger"; text: string } | null
> = {
  read: null,
  config: { tone: "warn", text: "config" },
  disruptive: { tone: "danger", text: "disruptive" },
  blocked: { tone: "danger", text: "blocked" },
};

/**
 * Suggest mode: the commands a model without tool calling proposed. Nothing runs until the user
 * clicks Run; main runs it by id through the guard and the audit log, with the user as approver.
 * Configuration lines and disruptive commands open the usual approval card instead.
 */
export function SuggestionList({
  e,
  tabId,
  busy,
  readOnly,
}: {
  e: Extract<Entry, { kind: "suggestions" }>;
  tabId: string;
  busy: boolean;
  readOnly: boolean;
}): React.JSX.Element {
  const run = useAi((s) => s.runSuggestion);
  const ask = useAi((s) => s.ask);
  const ranAny = e.ran.length > 0;
  return (
    <div
      data-testid="ai-suggestions"
      className="border-l-2 border-warn/50 pl-2.5 animate-fade-in"
    >
      <div className="mb-1 text-2xs text-fg-subtle">
        Suggested commands. Each runs only when you click it.
      </div>
      <ul className="space-y-0.5">
        {e.items.map((s) => {
          const ran = e.ran.includes(s.id);
          const label = s.disruptive ? LABEL.disruptive : LABEL[s.kind];
          const blocked = s.kind === "blocked";
          const roRefused =
            readOnly && (s.kind === "config" || s.kind === "disruptive");
          const verb =
            s.kind === "read"
              ? "Run"
              : s.kind === "blocked"
                ? "Blocked"
                : "Review";
          return (
            <li
              key={s.id}
              data-testid="ai-suggestion"
              data-kind={s.kind}
              className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded px-1 py-0.5 hover:bg-hover"
            >
              {/* One line per command, as on the device (review P2: interface names were split). In a narrow
                  panel the label and button move under the lines instead of squeezing them; only a line
                  wider than the whole panel scrolls. */}
              <code
                className={cn(
                  "min-w-0 max-w-full flex-auto overflow-x-auto whitespace-pre pt-0.5 font-mono text-xs",
                  blocked ? "text-fg-subtle line-through" : "text-fg",
                )}
              >
                {s.commands.join("\n")}
              </code>
              <span className="ml-auto flex shrink-0 items-start gap-2">
                {label && (
                  <Tooltip label={s.reason}>
                    <span>
                      <Badge tone={label.tone}>{label.text}</Badge>
                    </span>
                  </Tooltip>
                )}
                {ran ? (
                  <span className="flex h-6 items-center gap-1 text-2xs text-fg-subtle">
                    <Check className="size-3" /> sent
                  </span>
                ) : (
                  <Tooltip
                    label={
                      blocked
                        ? s.reason
                        : roRefused
                          ? "Read-only mode is on: this would be refused."
                          : s.kind === "read"
                            ? "Run it on the device (checked by the guard, logged with your name)"
                            : "Open an approval card for these lines"
                    }
                  >
                    <span>
                      <Button
                        size="sm"
                        variant={s.kind === "read" ? "secondary" : "ghost"}
                        disabled={blocked || busy || roRefused}
                        onClick={() => void run(tabId, e.id, s.id)}
                        aria-label={`${verb} ${s.commands[0]}`}
                      >
                        <Play /> {verb}
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {ranAny && (
        <div className="mt-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void ask(tabId, "Continue with the output above.")}
          >
            Continue with the output
          </Button>
        </div>
      )}
    </div>
  );
}
