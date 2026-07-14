import { BlockList, isIP } from 'node:net'

import { assertDomain } from './errors.ts'

export interface WebhookResolvedAddress {
  address: string
  family: 4 | 6
}

const MAX_DNS_ANSWERS = 16
const ipv4Blocks = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  ipv4Blocks.addSubnet(network, prefix, 'ipv4')
}

const ipv6Blocks = new BlockList()
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  ipv6Blocks.addSubnet(network, prefix, 'ipv6')
}

export function isPublicWebhookAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false
  if (family === 4) return !ipv4Blocks.check(address, 'ipv4')

  const firstHextet = Number.parseInt(address.split(':', 1)[0], 16)
  return (
    Number.isInteger(firstHextet) &&
    firstHextet >= 0x2000 &&
    firstHextet <= 0x3fff &&
    !ipv6Blocks.check(address, 'ipv6')
  )
}

export function validateWebhookResolution(
  records: readonly WebhookResolvedAddress[],
): readonly Readonly<WebhookResolvedAddress>[] {
  assertDomain(
    records.length >= 1 && records.length <= MAX_DNS_ANSWERS,
    'WEBHOOK_NETWORK_REJECTED',
    'Webhook DNS resolution returned an unsafe number of addresses',
  )
  const normalized = records.map((record) => {
    const address = record.address.trim().toLowerCase()
    assertDomain(
      isPublicWebhookAddress(address, record.family),
      'WEBHOOK_NETWORK_REJECTED',
      'Webhook DNS resolution contains a non-public address',
    )
    return Object.freeze({ address, family: record.family })
  })
  assertDomain(
    new Set(normalized.map(({ address, family }) => `${family}:${address}`)).size ===
      normalized.length,
    'WEBHOOK_NETWORK_REJECTED',
    'Webhook DNS resolution contains duplicate addresses',
  )
  return Object.freeze(normalized)
}
