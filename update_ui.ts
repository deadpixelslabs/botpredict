import fs from 'fs';

function replaceInFile(file, regex, replacement) {
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace(regex, replacement);
  fs.writeFileSync(file, code);
}

replaceInFile('src/components/TradingConsole.tsx', /\* 900/g, '* 300');
replaceInFile('src/components/TradingConsole.tsx', /= 900;/g, '= 300;');
replaceInFile('src/components/TradingConsole.tsx', /15 minutes/g, '5 minutes');

replaceInFile('src/components/PerformanceChart.tsx', /\* 900/g, '* 300');
replaceInFile('src/components/LogFeed.tsx', /\* 900/g, '* 300');
replaceInFile('src/App.tsx', /15m/g, '5m');
