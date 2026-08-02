export function encodeChannelDeliveryIdentity(
  orgId: string,
  channelBindingId: string,
  deliveryId: string,
): string {
  return JSON.stringify([orgId, channelBindingId, deliveryId])
}
