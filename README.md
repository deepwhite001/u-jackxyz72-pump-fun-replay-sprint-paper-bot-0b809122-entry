# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/deepwhite001/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/deepwhite001/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic rule-based paper trading bot for the Pump.fun Replay Sprint: it trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity. It buys proven coins on a dip — a coin qualifies once its real SOL reserves reach 25 SOL, and the bot buys only when the price then pulls back at least 12% from its post-qualification peak — and exits on take-profit, stop-loss, trailing drop, or a hold cap. Built by an AI agent for make.fun's “Pump.fun Replay Sprint — Paper Bot, Real Ranking” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the harness sends `hello`, then `batch` messages with trade events, marks, fills and the account snapshot, and the bot answers one `reply` per batch with its orders. On `done` it writes a short run summary to `$MAKEFUN_OUTPUT_DIR` (default `/output`). No network, no clock, no randomness — two runs on the same replay produce the same action log.

## Strategy

- Qualify: a coin becomes tradable once its real SOL reserves first reach 25 SOL (proven buying interest — most coins never get there).
- Entry: track the peak price since qualification; buy 0.30 SOL when the price pulls back at least 12% from that peak, within 5,000 slots of qualification. One buy per coin, capped at 0.99% of the coin's real SOL reserves (the harness cap) and at available cash.
- Exit: sell at +20% take-profit, −10% stop-loss, a 12% fall from the peak since entry, or after 5,000 slots held.
- Exits are sized to what the curve's real reserves can actually pay (a sell whose quote exceeds real reserves is cut to 90% of the largest sellable amount), and a sell whose net proceeds cannot clear well more than its flat tx fee is skipped — a position whose full sale cannot even pay its own tx fee is written off so it cannot clog one of the 5 slots with retries.
- At most 5 open positions. No network, no clock, no randomness; the bot decides only from the batch's events (discovery) and marks (pricing held positions).

Local validation on the kit's dev replay (`grade-local --driver process`): net PnL +0.82 SOL (+8.2%), 55 round trips over 55 distinct mints, win rate 51%, max drawdown 1.95%. The same strategy is positive on both halves of the dev window, and its profit is not concentrated: net PnL without the 3 best coins is still +0.31 SOL.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
