// DM-as-channel derivation (#1166, epic #1163) — now owned by `shared/` so the
// server's channel binder can route an unmentioned DM message to that channel's
// one agent from the SAME pure derivation the UI renders from. The routing half
// of the DM contract was originally client-only, which is why a DM message with
// no literal @mention used to route to nobody, silently.
//
// This module stays put as the frontend's import site so every existing
// `lib/dm-channels.js` import keeps working unchanged.
export {
  dmChannelCreateInput,
  dmChannelTopicId,
  isDmChannel,
} from '../../../shared/dm-channels.js';
