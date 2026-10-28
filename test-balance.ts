import axios from "axios";
import { getJwtToken, getOrderBuilder } from "./server/predictClient";
import fs from "fs";

async function main() {
    const config = JSON.parse(fs.readFileSync("./data/config.json", "utf8"));
    const apiKey = "";
    const privateKey = config.walletPrivateKey;
    const account = config.smartWalletAddress || config.walletAddress;

    const pb = await getOrderBuilder(privateKey, account);
    const jwt = await getJwtToken(pb, account, apiKey);

    try {
        const res = await axios.get(`https://api.predict.fun/v1/balances/${account}`, {
            headers: { "x-api-key": apiKey, "Authorization": "Bearer " + jwt }
        });
        console.log(JSON.stringify(res.data));
    } catch(e) {
        console.error("balances failed");
    }

    try {
        const res = await axios.get(`https://api.predict.fun/v1/users/${account}`, {
            headers: { "x-api-key": apiKey, "Authorization": "Bearer " + jwt }
        });
        console.log(JSON.stringify(res.data));
    } catch(e) {
        console.error("users failed");
    }

    try {
        const res = await axios.get(`https://api.predict.fun/v1/exchange/balances/${account}`, {
            headers: { "x-api-key": apiKey, "Authorization": "Bearer " + jwt }
        });
        console.log(JSON.stringify(res.data));
    } catch(e) {
        console.error("exchange balances failed");
    }
}
main();
