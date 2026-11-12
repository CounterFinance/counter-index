/**
 * Solana adapter (M20): prove the chain-neutral core on a non-EVM, non-OPNET
 * chain. Anchor-style events (8-byte discriminator + Borsh payload) decode into
 * ChainEvents and index through the SAME createIndexer with zero core changes.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import {
  SolanaDecoder, anchorEventDiscriminator, SolanaLogSource, programDataPayloads,
  BorshReader, BorshWriter, base58Encode, type SolanaTx,
} from '../src/chains/solana/index.js';
import type { SolanaChainMeta } from '../src/chains/solana/types.js';

// A 32-byte pubkey fixture + its canonical base58 (all-zero = System Program).
const ZERO_PUBKEY = new Uint8Array(32);

describe('borsh + base58', () => {
  it('round-trips every supported field type', () => {
    const w = new BorshWriter()
      .write('u8', 7).write('u16', 300).write('u32', 70_000)
      .write('u64', 18_000_000_000_000_000_000n).write('i64', -42n)
      .write('bool', true).write('pubkey', ZERO_PUBKEY).write('string', 'hello');
    const r = new BorshReader(w.toBytes());
    expect(r.read('u8')).toBe(7);
    expect(r.read('u16')).toBe(300);
    expect(r.read('u32')).toBe(70_000);
    expect(r.read('u64')).toBe(18_000_000_000_000_000_000n);   // beyond 2^53 — exact bigint
    expect(r.read('i64')).toBe(-42n);                          // two's complement
    expect(r.read('bool')).toBe(true);
    expect(r.read('pubkey')).toBe('1'.repeat(32));             // System Program address
    expect(r.read('string')).toBe('hello');
  });

  it('base58 encodes the all-zero pubkey as the System Program id', () => {
    expect(base58Encode(ZERO_PUBKEY)).toBe('11111111111111111111111111111111');
  });
});

const decoder = new SolanaDecoder([
  { name: 'TransferEvent', fields: [{ name: 'from', type: 'pubkey' }, { name: 'to', type: 'pubkey' }, { name: 'amount', type: 'u64' }] },
]);

/** Build the raw bytes for a TransferEvent (discriminator + Borsh payload). */
function transferRaw(from: Uint8Array, to: Uint8Array, amount: bigint): Uint8Array {
  const payload = new BorshWriter().write('pubkey', from).write('pubkey', to).write('u64', amount);
  return payload.concat(anchorEventDiscriminator('TransferEvent'));
}

describe('SolanaDecoder', () => {
  it('derives the Anchor discriminator and decodes the payload', () => {
    const disc = anchorEventDiscriminator('TransferEvent');
    expect(disc).toHaveLength(8);
    const r = decoder.decode({ raw: transferRaw(ZERO_PUBKEY, ZERO_PUBKEY, 500n) });
    expect(r).not.toBeNull();
    expect(r!.eventName).toBe('TransferEvent');
    expect(r!.decoded).toEqual({ from: '1'.repeat(32), to: '1'.repeat(32), amount: 500n });
    expect(decoder.decodableEvents()).toEqual(['TransferEvent']);
    expect(decoder.canDecode('TransferEvent')).toBe(true);
  });

  it('returns null for an unknown discriminator, and names-without-decoding a truncated payload', () => {
    expect(decoder.decode({ raw: new Uint8Array(16) })).toBeNull();            // zero disc — not registered
    const disc = anchorEventDiscriminator('TransferEvent');
    expect(decoder.decode({ raw: new Uint8Array([...disc, 1, 2, 3]) })).toEqual({ eventName: 'TransferEvent', decoded: null });
  });
});

describe('SolanaLogSource → ChainEvent', () => {
  it('extracts Program data payloads from tx logs', () => {
    const raw = transferRaw(ZERO_PUBKEY, ZERO_PUBKEY, 1n);
    const b64 = Buffer.from(raw).toString('base64');
    const payloads = programDataPayloads([
      'Program 11111111111111111111111111111111 invoke [1]',
      `Program data: ${b64}`,
      'Program 11111111111111111111111111111111 success',
    ]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual(raw);
  });

  it('indexes Solana events through the SAME core indexer', async () => {
    const schema = defineSchema({ Holder: { balance: { type: 'bigint' } } }) as Schema<SchemaDefinition>;
    const PROGRAM = 'Tok3nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const alice = new Uint8Array(32).fill(1), bob = new Uint8Array(32).fill(2);

    const txs: SolanaTx[] = [
      { slot: 100, signature: 'sig1', blockTime: 1_700_000_000, logs: [`Program data: ${Buffer.from(transferRaw(alice, bob, 300n)).toString('base64')}`] },
      { slot: 101, signature: 'sig2', blockTime: 1_700_000_012, logs: [`Program data: ${Buffer.from(transferRaw(bob, alice, 100n)).toString('base64')}`] },
    ];
    const source = new SolanaLogSource({
      chainId: 900, network: 'solana-mainnet', programId: PROGRAM, decoder,
      fetchSlots: async function* (from, to) { for (const t of txs) if (t.slot >= from && t.slot <= to) yield t; },
    });

    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source });
    let sawSolanaMeta = false;
    indexer.on('TransferEvent', async (e, ctx) => {
      const d = e.decoded!;
      if ((e.chainMeta as SolanaChainMeta | undefined)?.kind === 'solana') sawSolanaMeta = true;
      const amount = d['amount'] as bigint;
      for (const [who, delta] of [[d['to'], amount], [d['from'], -amount]] as const) {
        const cur = await ctx.store.get('Holder', who as string);
        await ctx.store.set('Holder', who as string, { balance: (cur ? (cur.balance as bigint) : 0n) + delta });
      }
    });

    await indexer.sync(100, 101, undefined, 101);

    expect(sawSolanaMeta).toBe(true);
    const aliceBal = await indexer.store.get('Holder', base58Encode(alice));
    const bobBal = await indexer.store.get('Holder', base58Encode(bob));
    expect(aliceBal!.balance).toBe(-200n);   // -300 + 100
    expect(bobBal!.balance).toBe(200n);      // +300 - 100
    expect(indexer.health().chains[0]).toMatchObject({ chainId: 900, lastBlock: 101 });
  });
});
