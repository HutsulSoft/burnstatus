# Contributing

Thanks for taking the time. Please read this first: this repository works differently from most.

## This repository is a mirror

The plugin is developed in a private source repository and published here on every change.
The sync replaces `main` with a snapshot of the source, so anything committed only here is removed by the next sync.
Pull requests are therefore never merged in this repository.

## How to contribute

1. **Open an issue first** for anything that is not a small fix: a bug, a change in behaviour, a new option.
   Agreeing on the problem before the code saves both of us time.
2. **A pull request is welcome as a proposal.** If it is accepted, the change is ported into the source repository
   with credit (a `Co-authored-by` trailer with the name and email from your commit), and the pull request is closed
   with a link to the release that contains it.
3. Security problems: do not use issues or pull requests. See [SECURITY.md](SECURITY.md).

## Rules

- **Zero dependencies.** The plugin is plain Node (22) `.mjs` with no packages. Pull requests that add a dependency are declined.
- **Tests pass.** Run `node --test test/*.test.mjs` and add a test for the change.
- **No secrets.** Never commit or paste a plugin key, Slack token, device code or the contents of `~/.claude/burnstatus/`.
- Keep the plugin's guarantees: the key is never printed or logged, only the four limit numbers are sent,
  and `settings.json` is changed only at the `statusLine` key, atomically, with a backup.

## Out of scope for now

These are deliberate cuts, so proposals for them will be closed:

- Other providers (only Claude Code limits, only Slack status).
- A team or shared view.
- Custom status formats.

## License

By contributing you agree that your contribution is licensed under the MIT License of this repository.
