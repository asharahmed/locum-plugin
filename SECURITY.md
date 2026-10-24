# Security

Locum runs model output as tool calls in your Claude Code session, sends your files and command output to the model's provider, and holds API keys. Reports about any of that are welcome.

Please report a vulnerability privately, through GitHub's [private vulnerability reporting](https://github.com/asharahmed/locum-plugin/security/advisories/new), not in a public issue. Include the Locum and Claude Code versions and the steps to reproduce. You'll get a reply within a week.

What's in scope, and how Locum handles each, is in the README's Safety and Auto mode sections. In short:

- Keys entered in `/plugin configure` are kept in the system keychain by Claude Code. Keys reach `curl` through its environment, never its command line.
- With `autoMode: allow`, actions auto mode would have reviewed run unreviewed, and reports say so. That's a documented tradeoff, not a vulnerability; a way around the label or the refusals is one.
- The path guard is best-effort and documented as such. A bypass is still worth reporting.
