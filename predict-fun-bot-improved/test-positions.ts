import axios from 'axios';
import { getOrderBuilder, getJwtToken } from './server/predictClient';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    const config = JSON.parse(fs.readFileSync('./data/config.json', 'utf8'));
    const pk = config.walletPrivateKey;
    const account = config.smartWalletAddress;
    const apiKey = process.env.PREDICT_API_KEY;
    
    const pb = await getOrderBuilder(pk, account);
    const jwt = await getJwtToken(pb, account, apiKey!);
    
    try {
        const res = await axios.get(`https://api.predict.fun/v1/positions/${account}`, {
            headers: { "x-api-key": apiKey, "Authorization": "Bearer " + jwt }
        });
        console.log("Positions1:", JSON.stringify(res.data, null, 2));
    } catch (e: any) {
        console.log("Error /v1/users/positions:", e.response?.data || e.message);
    }

    try {
        const res = await axios.get(`https://api.predict.fun/v1/positions`, {
            headers: { "x-api-key": apiKey, "Authorization": "Bearer " + jwt }
        });
        console.log("Positions2:", JSON.stringify(res.data, null, 2));
    } catch (e: any) {
        console.log("Error /v1/positions:", e.response?.data || e.message);
    }
}
run();
