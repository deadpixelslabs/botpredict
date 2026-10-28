import { placePredictOrder } from './server/predictClient';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    try {
        const config = JSON.parse(fs.readFileSync('./data/config.json', 'utf8'));
        const pk = config.walletPrivateKey;
        const account = config.smartWalletAddress;
        const apiKey = '';
        console.log("Placing BUY BULL 0.1 USDT limit 0.40...");
        const res = await placePredictOrder('BULL', 0.1, pk, account, apiKey, 0.40, Math.floor(Date.now() / 1000 / 300) * 300, 'BUY');
        console.log("Response:", res);
    } catch (e: any) {
        console.error("Error:", e.response?.data || e.message);
    }
}
run();
