import { ethers } from "ethers";
import fs from "fs";

async function main() {
    const config = JSON.parse(fs.readFileSync("./data/config.json", "utf8"));
    const account = config.smartWalletAddress || config.walletAddress;

    const provider = new ethers.JsonRpcProvider("https://rpc.blast.io");
    const usdbAddr = "0x4300000000000000000000000000000000000003";
    const usdbContract = new ethers.Contract(usdbAddr, [
        "function balanceOf(address account) view returns (uint256)",
        "function decimals() view returns (uint8)"
    ], provider);

    try {
        const bal = await usdbContract.balanceOf(account);
        const dec = await usdbContract.decimals();
        console.log("USDB Balance:", ethers.formatUnits(bal, dec));
    } catch(e: any) {
        console.error("failed", e.message);
    }
}
main();
