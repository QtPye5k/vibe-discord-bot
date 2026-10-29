# Private voice transcripts

Create one private **text channel** named `vibe-transcripts`, or set `VOICE_TRANSCRIPT_CHANNEL_ID` to its exact ID. `VOICE_TRANSCRIPT_CHANNEL_NAME` changes the discovery name when an ID is not supplied. There is no automatic creation or fallback to the channel where `/join` was used.

The channel must explicitly deny View Channel to `@everyone`. Add selected readers as individual members. Permit Vibe through its own member overwrite or its verified managed bot role. Broad ordinary-role View Channel grants are rejected even when `@everyone` itself remains denied. Discord server owners and administrators retain their platform-level access.

Each requesting speaker needs View Channel and Read Message History there. Vibe needs View Channel, Read Message History and Send Messages. Discovery must find exactly one matching text channel; announcement, voice, forum and thread destinations are rejected. A configured ID is never silently replaced with another channel.

The resolver refreshes server membership, bot membership, roles and the selected channel before admitting a voice session. Active voice sessions apply the same privacy invariant whenever they refresh the transcript destination. If the channel becomes public, permissions are revoked or an ordinary role gains broad visibility, subsequent private transcript use fails closed. The resolver does not post, modify permissions or create channels.

Only the consented, authorized voice flow can use this destination. Moving transcripts into a private channel does not authorize recording other speakers or publishing their speech to a public chat.

With the default local transcription backend, captured consented speech is recognized on this computer so the name and relevant-follow-up checks run before an addressed request reaches OpenAI. Only accepted conversational turns produce transcript messages. Run `pnpm voice:prepare` once per host; see [LOCAL_TRANSCRIPTION.md](LOCAL_TRANSCRIPTION.md). Explicitly selecting `VOICE_TRANSCRIPTION_BACKEND=openai` uploads captured consented utterances for transcription before those checks. Spoken replies remain audible to everyone in the voice channel, so account credentials and private exports belong in private `/ask`.
