// ZIP import limits. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { readZip, writeZip } from '../src/zip.ts';

const f = (name: string, n: number) => ({ name, data: Buffer.alloc(n, 'a') });

test('total unpacked size is capped across entries; names filtered before unpacking', () => {
  const z = writeZip([f('a.json', 1000), f('b.json', 1000), f('c.json', 1000), f('big.bin', 5000)]);
  assert.throws(() => readZip(z, 10, 2000, 2500), /too large/);
  assert.equal(readZip(z, 10, 2000, 2500, (n) => n !== 'c.json' && n.endsWith('.json')).length, 2);
  assert.throws(() => readZip(z, 3), /too many/);
});

test('a deflated entry whose header understates its size still hits the cap', () => {
  const data = Buffer.alloc(4000, 'a'), comp = deflateRawSync(data), name = Buffer.from('x.json');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(10, 22); h.writeUInt16LE(name.length, 26);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(10, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(0, 42);
  const cd = Buffer.concat([c, name]), off = 30 + name.length + comp.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const z = Buffer.concat([h, name, comp, cd, end]);
  assert.equal(readZip(z, 10, 8000, 8000)[0].data.length, 4000);
  assert.throws(() => readZip(z, 10, 8000, 1000), /too large/);
});
