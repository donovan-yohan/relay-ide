# Legacy web chat

> **Status: retired redirect.** The session-centric web-chat design recorded by
> earlier revisions of this file was superseded by the shipped channel
> architecture. The historical content remains available in git history; it is
> not a current implementation contract.

Start with [`CHANNEL_CHAT.md`](./CHANNEL_CHAT.md): a channel is the durable
conversation, a DM is a channel, and agents are participants backed by
replaceable provider sessions.

`ChatView`/`Turn` still exists only as compatibility for restored or API-created
legacy `mode: 'web'` sessions. New channel and DM work must target
`ChannelView`/`ChannelTimeline` and the channel router/store/hub. An isolated
legacy component fixture does not prove behavior in the live channel.
