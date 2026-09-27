"""The one prompt shared by the River proxy (inference) and evals/river (SFT data).

A rule question becomes an OpenAI-style chat with a fixed system message and a
user message carrying the rule and the post. The model answers with a single
word, yes or no; the proxy reads P(yes) from the first token's logprobs and the
fine-tune trains that same first token. Keep this file free of imports beyond
the stdlib so both sides can vendor it unchanged.
"""

from __future__ import annotations

import math

PROMPT_VERSION = "river-prompt-0.1"

SYSTEM_SUFFIX = "Answer with exactly one word: yes or no."

YES_TOKENS = frozenset({"yes", "y", "true"})
NO_TOKENS = frozenset({"no", "n", "false"})


def build_messages(task: str, rule: str, post_text: str, quoted_text: str | None = None, link_text: str | None = None) -> list[dict]:
    """`task` and `rule` are the extension's compiled question
    (`questions[<ruleId>].instructions`); the post fields are `state`."""
    parts = [f"Rule: {rule.strip()}", f"Post: {post_text.strip()}"]
    if quoted_text and quoted_text.strip():
        parts.append(f"Quoted post: {quoted_text.strip()}")
    if link_text and link_text.strip():
        parts.append(f"Linked page: {link_text.strip()}")
    parts.append("Does the rule apply to this post?")
    return [
        {"role": "system", "content": f"{task.strip()} {SYSTEM_SUFFIX}"},
        {"role": "user", "content": "\n".join(parts)},
    ]


def _norm(token: str) -> str:
    return token.strip().strip(".,!").lower()


def probability_from_choice(choice: dict) -> float:
    """P(yes) from one OpenAI chat-completion choice.

    Uses the first content token's `top_logprobs` when present: sums the mass on
    yes-like and no-like tokens and renormalises between them. Falls back to the
    message text (yes -> 0.9, no -> 0.1, else 0.5) when logprobs are absent.
    """
    content = (choice.get("logprobs") or {}).get("content") or []
    if content:
        first = content[0]
        alts = list(first.get("top_logprobs") or [])
        if not any(a.get("token") == first.get("token") for a in alts) and "logprob" in first:
            alts.append({"token": first.get("token", ""), "logprob": first["logprob"]})
        yes = sum(math.exp(a["logprob"]) for a in alts if _norm(a.get("token", "")) in YES_TOKENS)
        no = sum(math.exp(a["logprob"]) for a in alts if _norm(a.get("token", "")) in NO_TOKENS)
        if yes + no > 0:
            return yes / (yes + no)
    words = ((choice.get("message") or {}).get("content") or "").split()
    text = _norm(words[0]) if words else ""
    if text in YES_TOKENS:
        return 0.9
    if text in NO_TOKENS:
        return 0.1
    return 0.5
