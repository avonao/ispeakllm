// New for iSpeakLLM. The "signal calendar": when each vendor has said it will
// honour the `__usage_ai-training` robots token. Data as stated in the research
// notes (02-research.md, 3.3), 10 Nov 2026. It records what vendors announced,
// not what any crawler is observed to do.

export type SignalCalendarEntry = {
  readonly vendor: string;
  readonly signal: "__usage_ai-training";
  /** `announced` = stated intent without a date; `scheduled` = a date was named; `rolling-out` = vendor says it has started. */
  readonly status: "announced" | "scheduled" | "rolling-out";
  /** ISO date when the vendor named one, else null. */
  readonly effectiveDate: string | null;
  /** The vendor's own timing, as stated. */
  readonly timing: string;
  readonly scope?: string;
  readonly note: string;
  readonly source: string;
};

export const SIGNAL_CALENDAR_AS_OF = "2026-11-10";

export const SIGNAL_CALENDAR: readonly SignalCalendarEntry[] = [
  {
    vendor: "Google",
    signal: "__usage_ai-training",
    status: "announced",
    effectiveDate: null,
    timing: "early 2027",
    note: "An opt-out through the token without a Google-Extended rule counts as a Google-Extended disallow.",
    source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers",
  },
  {
    vendor: "Microsoft",
    signal: "__usage_ai-training",
    status: "scheduled",
    effectiveDate: "2027-02-01",
    timing: "1 February 2027",
    note: "Adds page-level training and grounding settings.",
    source: "https://ppc.land/google-microsoft-openai-and-anthropic-back-one-ai-training-opt-out/",
  },
  {
    vendor: "OpenAI",
    signal: "__usage_ai-training",
    status: "announced",
    effectiveDate: null,
    timing: "the coming months",
    scope: "foundational training",
    note: "Scoped by the vendor to foundational training.",
    source: "https://ppc.land/google-microsoft-openai-and-anthropic-back-one-ai-training-opt-out/",
  },
  {
    vendor: "Anthropic",
    signal: "__usage_ai-training",
    status: "rolling-out",
    effectiveDate: null,
    timing: "recognised as of 30 October 2026, rollout ongoing; no date given",
    note: "ClaudeBot-specific robots rules take precedence over the token.",
    source: "https://support.claude.com/en/articles/8896518",
  },
];

export type SignalStatus = "announced" | "scheduled" | "rolling-out" | "effective";

/** Status of one entry at `nowIso`: a scheduled date that has passed is `effective` (as stated by the vendor). */
export function signalStatus(entry: SignalCalendarEntry, nowIso: string): SignalStatus {
  if (entry.effectiveDate !== null && Date.parse(nowIso) >= Date.parse(entry.effectiveDate)) return "effective";
  return entry.status;
}

export function signalCalendar(nowIso: string): Array<SignalCalendarEntry & { readonly currentStatus: SignalStatus }> {
  return SIGNAL_CALENDAR.map((e) => ({ ...e, currentStatus: signalStatus(e, nowIso) }));
}
