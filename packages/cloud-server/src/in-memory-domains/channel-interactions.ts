import type {
  ChannelInteractionRecord,
  FindChannelInteractionInput,
} from '../control-plane-store.ts'
import {
  plaintextMatchesChannelInteractionId,
  verifyChannelInteractionTokenHash,
} from '../control-plane-tokens.ts'

export async function findMutableChannelInteraction(
  input: FindChannelInteractionInput,
  interactions: Iterable<ChannelInteractionRecord>,
): Promise<ChannelInteractionRecord | null> {
  if (input.channelBindingIds?.length === 0) return null
  let interaction: ChannelInteractionRecord | null = null
  if (input.token) {
    for (const candidate of interactions) {
      if (candidate.orgId !== input.orgId) continue
      if (!plaintextMatchesChannelInteractionId(input.token, candidate.interactionId)) continue
      if (await verifyChannelInteractionTokenHash(input.token, candidate.tokenHash)) {
        interaction = candidate
        break
      }
    }
  } else if (input.externalInteractionId && input.provider) {
    for (const candidate of interactions) {
      if (
        candidate.orgId !== input.orgId
        || candidate.provider !== input.provider
        || candidate.externalInteractionId !== input.externalInteractionId
        || (input.channelBindingIds && (
          candidate.channelBindingId === null
          || !input.channelBindingIds.includes(candidate.channelBindingId)
        ))
      ) continue
      if (interaction) return null
      interaction = candidate
    }
  }
  if (!interaction || interaction.orgId !== input.orgId) return null
  if (
    input.channelBindingIds
    && (interaction.channelBindingId === null || !input.channelBindingIds.includes(interaction.channelBindingId))
  ) return null
  const now = input.now || new Date()
  if (interaction.status !== 'pending') return null
  if (new Date(interaction.expiresAt).getTime() <= now.getTime()) {
    interaction.status = 'expired'
    interaction.updatedAt = now.toISOString()
    return null
  }
  return interaction
}
