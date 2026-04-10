/**
 * Tests for contract standard detection (OP-20, OP-721).
 */

import { describe, it, expect } from 'vitest';
import {
  isOP20Contract, isOP721Contract, classifyContract,
  OP20_EVENT_NAMES, OP721_EVENT_NAMES,
} from '../src/standards.js';
import type { DecodedEvent } from '../src/types.js';

function makeEvent(
  contractAddress: string,
  eventName: string,
  overrides: Partial<DecodedEvent> = {},
): DecodedEvent {
  return {
    blockNumber: 100,
    txHash: '0xtx',
    contractAddress,
    eventName,
    eventRaw: new Uint8Array(0),
    decoded: null,
    dataLength: 0,
    ...overrides,
  };
}

const ADDR  = '0xtoken1';
const OTHER = '0xtoken2';

describe('OP20_EVENT_NAMES / OP721_EVENT_NAMES', () => {
  it('OP20 names include Transferred and Approval', () => {
    expect(OP20_EVENT_NAMES).toContain('Transferred');
    expect(OP20_EVENT_NAMES).toContain('Approval');
    expect(OP20_EVENT_NAMES).not.toContain('ApprovalForAll');
  });

  it('OP721 names include all three', () => {
    expect(OP721_EVENT_NAMES).toContain('Transferred');
    expect(OP721_EVENT_NAMES).toContain('Approval');
    expect(OP721_EVENT_NAMES).toContain('ApprovalForAll');
  });
});

describe('isOP20Contract', () => {
  it('true when contract emits Transferred', () => {
    const events = [makeEvent(ADDR, 'Transferred')];
    expect(isOP20Contract(ADDR, events)).toBe(true);
  });

  it('true when contract emits Approval', () => {
    const events = [makeEvent(ADDR, 'Approval')];
    expect(isOP20Contract(ADDR, events)).toBe(true);
  });

  it('false when no OP20 events present', () => {
    const events = [makeEvent(ADDR, 'Synced'), makeEvent(ADDR, 'PoolCreated')];
    expect(isOP20Contract(ADDR, events)).toBe(false);
  });

  it('false when OP20 events are from a different contract', () => {
    const events = [makeEvent(OTHER, 'Transferred')];
    expect(isOP20Contract(ADDR, events)).toBe(false);
  });

  it('true when events contain both matching and non-matching contracts', () => {
    const events = [makeEvent(OTHER, 'Synced'), makeEvent(ADDR, 'Transferred')];
    expect(isOP20Contract(ADDR, events)).toBe(true);
  });
});

describe('isOP721Contract', () => {
  it('true when contract emits ApprovalForAll', () => {
    const events = [makeEvent(ADDR, 'ApprovalForAll')];
    expect(isOP721Contract(ADDR, events)).toBe(true);
  });

  it('false when only OP20 events present (Transferred + Approval)', () => {
    const events = [makeEvent(ADDR, 'Transferred'), makeEvent(ADDR, 'Approval')];
    expect(isOP721Contract(ADDR, events)).toBe(false);
  });

  it('false when ApprovalForAll is from a different contract', () => {
    const events = [makeEvent(OTHER, 'ApprovalForAll')];
    expect(isOP721Contract(ADDR, events)).toBe(false);
  });
});

describe('classifyContract', () => {
  it('returns op721 when ApprovalForAll present', () => {
    const events = [
      makeEvent(ADDR, 'Transferred'),
      makeEvent(ADDR, 'ApprovalForAll'),
    ];
    expect(classifyContract(ADDR, events)).toBe('op721');
  });

  it('returns op20 when Transferred present but no ApprovalForAll', () => {
    const events = [makeEvent(ADDR, 'Transferred')];
    expect(classifyContract(ADDR, events)).toBe('op20');
  });

  it('returns unknown when no standard events present', () => {
    const events = [makeEvent(ADDR, 'Synced')];
    expect(classifyContract(ADDR, events)).toBe('unknown');
  });

  it('op721 takes priority over op20 when both signals present', () => {
    const events = [
      makeEvent(ADDR, 'Transferred'),
      makeEvent(ADDR, 'Approval'),
      makeEvent(ADDR, 'ApprovalForAll'),
    ];
    expect(classifyContract(ADDR, events)).toBe('op721');
  });

  it('returns unknown for empty event list', () => {
    expect(classifyContract(ADDR, [])).toBe('unknown');
  });
});
