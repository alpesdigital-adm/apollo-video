import assert from 'node:assert/strict'
import test from 'node:test'

import { Address4, Address6 } from 'ip-address'

test('ip-address classifies the full IPv6 link-local fe80::/10 range', () => {
  assert.equal(new Address6('fe80::1').isLinkLocal(), true)
  assert.equal(new Address6('fe80:0:0:1::1').isLinkLocal(), true)
  assert.equal(new Address6('febf::1').isLinkLocal(), true)
  assert.equal(new Address6('fec0::1').isLinkLocal(), false)
  assert.equal(new Address6('2606:4700::1111').isLinkLocal(), false)
})

test('ip-address treats the NAT64 local-use /48 as private without widening it', () => {
  assert.equal(new Address6('64:ff9b:1:a9fe:a9:fe00::').isPrivate(), true)
  assert.equal(new Address6('64:ff9b:1:ffff::1').isPrivate(), true)
  assert.equal(new Address6('64:ff9b:2:a9fe:a9:fe00::').isPrivate(), false)
  assert.equal(new Address6('fd00::1').isPrivate(), true)
  assert.equal(new Address6('2606:4700::1111').isPrivate(), false)
})

test('ip-address rejects IPv6 addresses against IPv4 subnets', () => {
  assert.equal(new Address6('a00::1').isInSubnet(new Address4('10.0.0.0/8')), false)
})

test('ip-address rejects IPv4 addresses against IPv6 subnets', () => {
  assert.equal(new Address4('32.1.13.184').isInSubnet(new Address6('2001:db8::/32')), false)
})

test('ip-address preserves same-family subnet membership', () => {
  assert.equal(new Address4('10.1.2.3').isInSubnet(new Address4('10.0.0.0/8')), true)
  assert.equal(new Address6('2001:db8::1').isInSubnet(new Address6('2001:db8::/32')), true)
})
