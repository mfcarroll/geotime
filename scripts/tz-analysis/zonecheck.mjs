import { readFileSync } from 'node:fs';
const gj = JSON.parse(readFileSync(process.argv[2],'utf8'));
const ids = new Set(gj.features.filter(f=>f.geometry).map(f=>f.properties.tzid));
console.log(`  features: ${gj.features.length}  with geometry: ${gj.features.filter(f=>f.geometry).length}  distinct zones: ${ids.size}`);
const small = ['Europe/Gibraltar','Europe/Andorra','Europe/Monaco','Europe/Vatican','Europe/San_Marino',
               'Pacific/Nauru','Pacific/Funafuti','Pacific/Wallis','Indian/Cocos','Atlantic/Bermuda',
               'America/St_Barthelemy','Asia/Macau','Asia/Singapore'];
const missing = small.filter(z=>!ids.has(z));
console.log(`  small-zone check: ${missing.length ? 'MISSING → '+missing.join(', ') : 'all '+small.length+' present'}`);
