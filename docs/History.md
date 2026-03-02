# History

_Written by the project creator._ 

> TL;DR: Footnote started as a hobby genAI project which grew into an assistant you can inspect, review, and steer.

## How it started

When I began playing with chatbots, I made a Discord bot named RolyBot, after my little roly-poly avatar. It served as a playground to try new ideas, break things, learn, and have fun.

One such idea was replicating my writing style through a fine-tuned large language model (LLM) trained on my Discord chat logs. After a bit of tuning, it started to write in a very similar style to my own (or maybe a younger version of myself).

It was funny for a minute, but it got uncomfortable. It didn’t just copy the style—it could sound like it shared my opinions. It created a perception that whatever it says must be somehow correlated with what I actually believe; and when it says something off, you can’t just take it back. It's also not easy to correct the system—Fine-tuned models, and LLMs in general, feel more _grown_ than _built_. It sometimes felt like wrangling an alien that happens to speak like you.

That discomfort stuck with me. Besides affecting me personally, it also highlighted a wider issue: modern AI assistants can earn trust through familiarity, despite being easy to misunderstand and hard to control or audit. I wanted to address some of these pitfalls with generative AI.

I drew inspiration from one of my favorite sci-fi characters, Daneel Olivaw, by Isaac Asimov. Daneel is written as a capable assistant who’s defined as much by his constraints as by his competence. I especially appreciate how he’s _careful_, and how the story treats that as a feature and not a bug. His helpfulness doesn’t come from sounding confident or having a strong personality. He doesn’t treat conversation as something to win. He's caring, and predictable in ways that matter. When the right move is unclear, he’s willing to slow down, ask questions, and consider the wider impact. When he does act, you can reason about what he did, why, and where the boundaries were. That mattered to me more once I’d seen how easily a bot could charismatically borrow my voice and create a false sense of alignment with me. I took almost the opposite lesson from Daneel: That trust should be earned through transparency, consistency, and restraint.

For a while, I approached this as a character reference: “Make the assistant feel more like _that_.” Over time, I realized the character itself wasn’t the point, but rather the shape of the behavior. I thought perhaps I could get closer to that shape by building a system with explicit constraints, predictable results, and an easy way to verify answers by tracing from trigger to result.

## Changing direction

After RolyBot, I stopped chasing “a bot that feels fun to talk to” and started caring more about whether the system could be understood and corrected. That experiment made a few things hard to ignore. Tone quickly becomes a shortcut for trust. And when a model says something off, it’s surprisingly hard to point to what happened and fix it in a way that sticks. I didn’t want the project to depend on the hope that the model would behave itself, but rather utilize a system with real handles.

So I started asking different questions:

- When it answers, can I tell what sources it used?
- When it’s wrong, can I tell how it happened?
- Is behavior predictable when I change the rules?
- Could someone else review an interaction without much context?

That’s the through-line to Footnote: make assistant behavior something you can inspect, discuss, and tighten over time. The details live in [Philosophy.md](Philosophy.md).

### Why "Footnote"?  

I wanted a name that describes a behavior. “Footnote” points to the idea that an answer shouldn’t be a dead end. If you care, you should be able to click through and see what it relied on—sources, assumptions, active rules, tool use, and so on.

## The Future

Long term, more than a single bot, I want Footnote to be a _reusable approach_—patterns and tools for assistants that are easier to audit and steer.

Currently, Footnote is focused on provenance and reviewability, with Ari as the baseline configuration. Later, Footnote may support multiple profiles, with different rulesets and defaults.

## Where to go next

- Philosophy: [Philosophy.md](./Philosophy.md)
- Architecture: [docs/architecture](./architecture/)
- Key decisions: [docs/decisions](./decisions/)
- Roadmap: [GitHub issues](https://github.com/footnote-ai/footnote/issues), [GitHub discussions](https://github.com/footnote-ai/footnote/discussions)
- Licensing: [LICENSE_STRATEGY.md](./LICENSE_STRATEGY.md) (MIT + HL3)
