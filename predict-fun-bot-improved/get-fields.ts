import fs from 'fs';
const content = fs.readFileSync('server/predictClient.ts', 'utf8');
const regex = /fetchedOrderData\.([a-zA-Z0-9_]+)/g;
let match;
while ((match = regex.exec(content)) !== null) {
  console.log(match[1]);
}
