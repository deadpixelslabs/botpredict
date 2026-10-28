const fs = require('fs');
let code = fs.readFileSync('server/engine.ts', 'utf8');
code = code.replace(/900000/g, '300000');
code = code.replace(/900/g, '300');
// MIGRATED to 15m! might be replaced to MIGRATED to 5m! if it says 15m but it's not numbers
code = code.replace(/15m/g, '5m');
code = code.replace(/15 minute/g, '5 minute');
code = code.replace(/15-minute/g, '5-minute');
code = code.replace(/klines15m/g, 'klines5m');
code = code.replace(/m15Klines/g, 'm5Klines');
code = code.replace(/c15m/g, 'c5m');

fs.writeFileSync('server/engine.ts', code);

let predictClient = fs.readFileSync('server/predictClient.ts', 'utf8');
predictClient = predictClient.replace(/btc-updown-15m/g, 'btc-updown-5m');
fs.writeFileSync('server/predictClient.ts', predictClient);

let config = fs.readFileSync('server/brain/genius.ts', 'utf8');
config = config.replace(/flatStake:\s*1\.0/g, 'flatStake: 0.5');
fs.writeFileSync('server/brain/genius.ts', config);
