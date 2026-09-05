import { readFileSync } from 'node:fs';
const t = JSON.parse(readFileSync(process.argv[2],'utf8'));
if (!t.transform) { console.log('  NO quantization (raw floats)'); process.exit(0); }
const [sx,sy] = t.transform.scale;
console.log(`  quantization step: ${sx.toExponential(3)} lon, ${sy.toExponential(3)} lat`
  + `  =>  ~${(sy*111320).toFixed(1)} m lat, ~${(sx*111320).toFixed(1)} m lon at equator`);
