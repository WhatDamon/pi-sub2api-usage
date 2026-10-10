# pi-sub2api-usage

Shows the balance and usage of the current sub2api site, permanently, in Pi's footer. **Read-only**, zero config, zero timers.

```text
Sub2 $1.83 · Today $0.1866
```

The balance is coloured by severity: healthy is green, below $2 turns yellow, below $0.5 turns red. One glance tells you whether to top up.

## How it differs from `pi-sub2api`

Extensions like `pi-sub2api` exist to **register a provider and discover models**: they fetch `/v1/models` on startup, decide on a wire protocol and write `auth.json`. Balance display is only a side effect of that.

This extension does balance and nothing else, so it stays completely out of the traffic path — no provider registration, no model list, no change to any inference request.

## Install

Try it without touching your config:

```bash
pi --extension ./src/index.ts
```

To declare it as a local package, add this directory to Pi's extension list or point `pi install` at it. The package manifest already declares `pi.extensions`.

## What it looks like

The footer follows whichever billing mode the site reports. Each of the four has its own reading:

| Mode | Footer | Meaning |
| --- | --- | --- |
| Wallet | `Sub2 $1.83 · Today $0.1866` | Available balance and today's **actual** spend |
| Quota | `Sub2 62%` | Percentage of the quota used |
| Subscription | `Sub2 1d 20% · 7d 30% · 1m 18%` | Used percentage of each daily / weekly / monthly window |
| Rate limit | `Sub2 5h 82% [⟳ 42m]` | Window used percentage and the **reset countdown** |

Non-wallet modes omit the `Today` segment: their headline is the window cap, and every extension's status shares one footer line, so brevity wins. Today's spend is always available in `/sub2-usage`.

### Colours

The **balance** is judged by absolute thresholds, and only when the site reports USD — for any other unit there is nothing to judge against, so the default colour is used:

| Balance | Colour |
| --- | --- |
| ≥ $2 | green (healthy) |
| < $2 | yellow (time to top up) |
| < $0.5 | red |

The thresholds are deliberately smaller than the $10/$5 used by large-account balance displays: a typical sub2api balance sits at a few dollars, so copying those numbers would keep the footer permanently red and drain it of signal.

**Window percentages** are coloured by used ratio: under 70% green, 70% and above yellow, 90% and above red.

Precision: **balance 2 decimals, spend 4**. A single turn often costs $0.001–$0.01, so 2 decimals give the balance an at-a-glance overview while 4 keep small spend movements visible.

### State markers

| Display | Meaning |
| --- | --- |
| `Sub2 $1.83 · Today $0.1866` | Normal |
| `Sub2 ~$1.83 · Today $0.1866` | Refresh failed; `~` marks the last successful value |
| `Sub2 !` | The API key is invalid or has expired |
| `Sub2 ?` | The request failed and there is no cached value |
| (empty) | The current model is not a sub2api site |

The entire status text is an OSC 8 hyperlink pointing at the site root; it degrades to plain text on terminals that do not support hyperlinks.

### `/sub2-usage`

Prints the full detail (balance, today, total, last 3 days, by model), leading with the actual spend and showing the list price in parentheses. When the current model is not a sub2api site, it lists **every candidate site it probed** together with the outcome, so you can see why nothing is being displayed:

```text
sub2api · site-a
https://sub2.example.com
Wallet balance (shared across keys) $1.83
Today 198 req · 28.4M tok · spend $0.1866 (list $0.7464)
Total 1385 req · 136.2M tok · spend $0.9672 (list $3.8688)
Last 3d 10-09 $0.1994 · 10-10 $0.5812 · 10-11 $0.1866
By model m-1 $0.9672 · 136.2M tok · 1385 req
```

## One important semantic

**Balance is shared per user; usage is per API key.**

On the same sub2api site, several keys that point at one account all return **exactly the same** balance, while their `usage` and `model_stats` are tracked separately. So "another key reports the same balance but zero spend" is not a fault.

That is why the detail line in wallet mode is labelled "shared across keys".

## Requirements

- **A sub2api site already configured in Pi's own config** — a provider in `models.json` with credentials that can be resolved. The extension does not read CC Switch, Claude Code or Codex config files.
- Node ≥ 22.19.
- The site must expose `GET {base}/v1/usage` with Bearer API key auth. An older sub2api without that endpoint is silently classified as "not a sub2api site".
- `baseUrl` may be written as `https://host` or `https://host/v1`; either is normalised.

## When it refreshes

`session_start`, the end of every agent turn (`agent_settled`), on model switch (`model_select`), and when you run `/sub2-usage`.

There are no timers and no background polling — a session issues "1 + number of turns" requests, each with a 5-second timeout, and the second-tier candidate probe is concurrent. Every request is fire-and-forget and never blocks the conversation.

## Security

- Credentials are read only from Pi's own config and sent only to the `baseUrl` that the config entry declares.
- The API key travels in the `Authorization` header only, never in a URL.
- Logs and error messages carry only the provider name and the first 8 hex characters of the key's sha256 fingerprint; **the full key is never printed**.
- Nothing is written to disk and no config file is ever modified.

## Development

```bash
npm test          # vitest, fully offline
npm run typecheck # tsc --noEmit
```

The extension has no runtime dependencies: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are both supplied by Pi at runtime, which is why they are only devDependencies.
