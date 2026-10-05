import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SID_SIGNATURES, classifyRegion, classifySid, describeProbe } from '../src/probe.js';
import { MSG, MSG_LEN, MessageParser } from '../src/protocol.js';

test('the frame length says the video standard', () => {
  assert.equal(classifyRegion(19657).name, 'PAL');
  assert.equal(classifyRegion(20278).name, 'PAL-N');
  assert.equal(classifyRegion(17101).name, 'NTSC');
  assert.equal(classifyRegion(16777).name, 'NTSC (old)');
  assert.equal(classifyRegion(19666).lineCycles, 63);
  assert.equal(classifyRegion(17092).lineCycles, 65);
});

test('the readings say the SID model, and not clearly when they are further from both', () => {
  assert.equal(classifySid(SID_SIGNATURES['6581']).model, '6581');
  assert.equal(classifySid(SID_SIGNATURES['8580']).model, '8580');
  assert.equal(classifySid(SID_SIGNATURES['6581'].map(v => v + 3)).model, '6581'); // a little off still is
  assert.equal(classifySid([0x00, 0x00, 0x80, 0x80, 0x80, 0x80]).model, null);
});

test('a PROBE message is parsed whole, whatever it is split by', () => {
  const got = [];
  const parser = new MessageParser((t, a) => got.push([t, a]));
  const body = [MSG.PROBE, 0xC9, 0x4C, ...Array.from({ length: 21 }, (_, i) => i)];
  assert.equal(body.length, MSG_LEN[MSG.PROBE]);
  parser.feed(body.slice(0, 5));
  parser.feed(body.slice(5));
  assert.equal(got.length, 1);
  assert.equal(got[0][1].length, 23);
  assert.match(describeProbe(got[0][1]), /19657 cycles: PAL/);
});
