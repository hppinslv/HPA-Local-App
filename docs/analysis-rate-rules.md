# Analysis Rate Rules

This file documents the source-of-truth rules for Analysis comparison metrics and the Primary Report Navigator.

## Goal

Analysis rate values must load consistently on first render and after refreshes.
They must not drift based on whichever fallback path happened to run last.

## Source Of Truth

Use these sources in this order:

1. Exact scoped SCF metrics from the saved analysis report when the saved row is complete.
2. Exact scoped SCF metrics from a live scoped Salesforce refetch when the saved row is sparse or incomplete.
3. Saved aggregated report rows only when they already contain the correct premium totals/rates.

## Sparse Row Rule

A saved SCF row is considered sparse and must not be trusted as the final answer when:

- `Sum of Opp Count > 0`
- `Sum of Total Monthly Premium = 0`
- `Sum of In Force Monthly Premium = 0`
- `Sum of Total Converted Monthly Premiums = 0`

When that happens, the app must refetch scoped SCF metrics instead of displaying the sparse saved row as final.

## Rate Formulas

When premium totals are available, rates must be derived from premium totals and mailed count using the shared premium base.

- `Sold Rate = (Total Monthly Premium * 100) / (Mailed * 14.86)`
- `In Force Rate = (In Force Monthly Premium * 100) / (Mailed * 14.86)`
- `Converted Rate = (Total Converted Monthly Premiums * 100) / (Mailed * 14.86)`

## Important Constraints

- Do not trust Salesforce stored rate fields by themselves when premium totals disagree.
- Do not let the browser invent a different rate rule than the server.
- Do not introduce a new fallback path for navigator rows unless it follows the same formulas above.
- If a change touches Analysis rates, comparison metrics, or Primary Report Navigator rows, verify the values for a known SCF before shipping.

## Known Expectation

The comparison cards and the Primary Report Navigator should agree for the same SCF once exact metrics are loaded.
