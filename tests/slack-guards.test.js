import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyChannel } from '../src/slack/guards.js'

test('verifyChannel allows actions from a direct message channel', async () => {
  let rejected = false
  const allowed = await verifyChannel({
    config: { slack: { postingChannelId: 'CDEDICATED' } },
    body: { channel: { id: 'D123456' }, user: { id: 'U1' } },
    client: { chat: { async postEphemeral() { rejected = true } } },
  })

  assert.equal(allowed, true)
  assert.equal(rejected, false)
})

test('verifyChannel rejects an unrelated public channel', async () => {
  let rejectionMessage = ''
  const allowed = await verifyChannel({
    config: { slack: { postingChannelId: 'CDEDICATED' } },
    body: { channel: { id: 'COTHER' }, user: { id: 'U1' } },
    client: {
      chat: {
        async postEphemeral({ text }) { rejectionMessage = text },
      },
    },
  })

  assert.equal(allowed, false)
  assert.match(rejectionMessage, /CDEDICATED/)
})
