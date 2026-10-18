import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GateState } from './gate-state.js';

await test('startup and changes require two matching readings', () => {
    const state = new GateState(30_000, 5_000);
    assert.equal(state.current(0), null);
    state.read('closed', 0, 0);
    assert.equal(state.current(0), null);
    state.read('closed', 1_000, 1_000);
    assert.equal(state.current(1_000), 'closed');
    state.read('open', 2_000, 2_000);
    assert.equal(state.current(2_000), 'closed');
    state.read('open', 3_000, 3_000);
    assert.equal(state.current(3_000), 'open');
});

await test('errors or uncertain frames break a pending confirmation', () => {
    const state = new GateState(30_000, 5_000);
    state.read('open', 0, 0);
    state.fail();
    state.read('open', 1_000, 1_000);
    assert.equal(state.current(1_000), null);
    state.read('open', 2_000, 2_000);
    assert.equal(state.current(2_000), 'open');
});

await test('long gaps break confirmation even without an explicit error', () => {
    const state = new GateState(30_000, 5_000);
    state.read('closed', 0, 0);
    state.read('closed', 5_001, 5_001);
    assert.equal(state.current(5_001), null);
    state.read('closed', 6_000, 6_000);
    assert.equal(state.current(6_000), 'closed');
});

await test('stale state expires without new frames and recovery requires two readings', () => {
    const state = new GateState(30_000, 5_000);
    state.read('closed', 0, 0);
    state.read('closed', 1_000, 1_000);
    state.fail();
    assert.equal(state.current(30_999), 'closed');
    assert.equal(state.current(31_000), null);
    state.read('closed', 32_000, 32_000);
    assert.equal(state.current(32_000), null);
    state.read('closed', 33_000, 33_000);
    assert.equal(state.current(33_000), 'closed');
});

await test('alternating predictions cannot keep a previously confirmed state fresh', () => {
    const state = new GateState(3_000, 2_000);
    state.read('closed', 0, 0);
    state.read('closed', 1_000, 1_000);
    state.read('open', 2_000, 2_000);
    state.read('closed', 3_000, 3_000);
    state.read('open', 4_000, 4_000);
    assert.equal(state.current(4_000), null);
});

await test('old in-flight results are rejected and stable readings refresh freshness', () => {
    const state = new GateState(3_000, 2_000);
    state.read('open', 0, 3_000);
    state.read('open', 3_001, 3_001);
    assert.equal(state.current(3_001), null);
    state.read('open', 4_000, 4_000);
    state.read('open', 5_000, 5_000);
    assert.equal(state.current(7_999), 'open');
    assert.equal(state.current(8_000), null);
});
