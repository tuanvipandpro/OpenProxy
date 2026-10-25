import { deflateSync } from 'node:zlib';
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), header = Buffer.alloc(4), crc = Buffer.alloc(4);
  header.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, crc]);
}
export function appIcon() {
  const size = 64, raw = Buffer.alloc(size * (size * 4 + 1));
  const segment = (x,y,ax,ay,bx,by) => {
    const t = Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)));
    return Math.hypot(x-ax-t*(bx-ax), y-ay-t*(by-ay)) < 3;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0,g = 0,b = 0,a = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + sx/4, py = y + sy/4;
      const dx = Math.max(Math.abs(px-31.5)-18,0), dy = Math.max(Math.abs(py-31.5)-18,0);
      if (Math.hypot(dx,dy) > 12) continue;
      const stroke = segment(px,py,16,33,29,20) || segment(px,py,16,33,29,46) || segment(px,py,35,20,48,33) || segment(px,py,35,46,48,33);
      const color = stroke ? [109,232,199] : [24,46,48];
      r += color[0]; g += color[1]; b += color[2]; a++;
    }
    const index = y * (size*4+1) + 1 + x*4;
    if (a) { raw[index] = r/a; raw[index+1] = g/a; raw[index+2] = b/a; raw[index+3] = a/16*255; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size,4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]);
  const directory = Buffer.alloc(22); directory.writeUInt16LE(1,2); directory.writeUInt16LE(1,4);
  directory[6] = size; directory[7] = size; directory.writeUInt16LE(1,10); directory.writeUInt16LE(32,12); directory.writeUInt32LE(png.length,14); directory.writeUInt32LE(22,18);
  return Buffer.concat([directory,png]);
}
