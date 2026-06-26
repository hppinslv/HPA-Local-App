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

## Primary Report Rate Rules

Primary Report Navigator rates must be calculated from SCF-level counts, not from premium dollars.

- `Mailed = sum of mailed pieces for the SCF`
- `Sold Count = sum of sold/opportunity count rows for the SCF`
- `In Force Count = sum of in force rows for the SCF`
- `Converted Count = count of detail rows where Total Converted Monthly Premiums > 0`
- `Sold Rate = Sold Count / Mailed * 100`
- `In Force Rate = In Force Count / Mailed * 100`
- `Converted Rate = Converted Count / Mailed * 100`

### Converted Count Trust Rule

- Salesforce converted rate/count fields are not trusted as the source of truth when they disagree with row-level converted premium data.
- The app-derived converted count must come from row-level `Total Converted Monthly Premiums > 0`.
- A detail row counts as converted only when converted premium is a positive numeric dollar amount.
- Zero, blank, null, missing, or non-numeric converted premium does not count as converted.
- Future changes must not calculate converted rate from the converted premium dollar total.

### Example Logic

- If an SCF has `166` mailed and exactly `1` detail row with `Total Converted Monthly Premiums > 0`, then converted rate must be `1 / 166 * 100 = 0.6024096386`.
- If converted premium dollars are present on a row or SCF summary, that only proves whether a converted row should be counted. It must never be used directly as the converted rate numerator.

## Important Constraints

- Do not trust Salesforce stored converted rate/count fields by themselves.
- Do not trust converted premium dollar totals as a rate numerator.
- Do not let the browser invent a different rate rule than the server.
- Do not introduce a new fallback path for navigator rows unless it follows the same formulas above.
- If a change touches Analysis rates, comparison metrics, or Primary Report Navigator rows, verify the values for a known SCF before shipping.

## Troubleshooting Wrong Rates

- If most rates are zero, check SCF key normalization first, especially leading-zero matches like `010`, `011`, and `012`.
- Keep SCF values as strings, trim whitespace, and left-pad numeric values shorter than three digits.
- Do not change the formula unless the counts are already correct and only the final math is wrong.
- Debug counts before rates: confirm mailed, sold/opportunity count, in-force count, converted count, and converted premium totals for the SCF.
- Detail row aggregation is the source of truth whenever detail/export rows exist for that SCF.
- Saved summary rows are only a fallback when detail rows are unavailable.
- Zero fallback data must never overwrite nonzero detail-derived values.
- Future changes must not calculate converted rate from converted premium dollars. Converted premium only decides whether a row counts as converted.

## Known Expectation

The comparison cards and the Primary Report Navigator should agree for the same SCF once exact metrics are loaded.
