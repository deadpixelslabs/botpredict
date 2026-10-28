import fs from 'fs';
fs.writeFileSync('data/logs.json', '[]');
fs.writeFileSync('data/trades.json', '[]');
fs.writeFileSync('data/prob_model.json', '{}');
fs.writeFileSync('data/round_log.csv', 'epoch,predicted,actual,status,betAmountUSDT,payout,confidence,reasoning\n');
console.log('Truncated all files.');
