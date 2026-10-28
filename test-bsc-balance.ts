import { ethers } from "ethers";
import fs from "fs";

async function main() {
    const config = JSON.parse(fs.readFileSync("./data/config.json", "utf8"));
    const account = config.smartWalletAddress || config.walletAddress;

    const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
    const usdtAddr = "0x55d398326f99059fF775485246999027B3197955";
    const usdtContract = new ethers.Contract(usdtAddr, [
        "function balanceOf(address account) view returns (uint256)",
        "function decimals() view returns (uint8)"
    ], provider);

    try {
        const bal = await usdtContract.balanceOf(account);
        const dec = await usdtContract.decimals();
        console.log("USDT Balance on BSC:", ethers.formatUnits(bal, dec));
    } catch(e: any) {
        console.error("failed", e.message);
    }
}
main();
