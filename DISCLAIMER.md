# Before you use Locum

## Not affiliated with Anthropic

Locum is an independent project. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks, and Locum uses them only to say what it works with.

## Unsupported by Anthropic

Anthropic doesn't support running Claude Code on models other than Claude. Locum makes that possible through Claude Code's plugin hooks, and how its agents behave is Locum's responsibility, not Anthropic's.

If something goes wrong in a Locum agent or in a session switched to another model, report it on [Locum's issue tracker](https://github.com/asharahmed/locum-plugin/issues). Don't file it with Anthropic. If you're not sure whether Locum is involved, turn it off with `claude plugin disable locum@asharahmed` and check whether the problem persists.

## What is sent to other providers

Locum sends your work to companies other than Anthropic: OpenRouter and the providers it routes to, and DeepSeek, Z.ai, Alibaba or MiniMax when you give Locum their keys.

- **A Locum subagent** sends its task, Claude Code's context for it (the environment, the date and, when the agent receives it, your `CLAUDE.md`), and everything the agent reads or runs: file contents, command output and search results.
- **Switching the main session** with `/model <id>` sends Claude Code's own system prompt and the whole conversation so far to that provider, including the replies Claude wrote earlier in the session. The same goes for compacting a switched session.

The `privacy` setting controls which OpenRouter providers may receive this. It doesn't cover calls made directly to a lab with that lab's key: those fall under the lab's own data terms. Each provider's terms and privacy policy apply to what it receives, and you agree to them when you create a key there.

## Auto mode

Auto mode's safety check runs on Anthropic's servers and can't review other models' actions. With `autoMode: allow`, actions that the check would have reviewed run without that review. Your deny rules and permission prompts still apply. Locum labels the agent's report as unreviewed. The option is off by default; turn it on only if you accept that tradeoff.
