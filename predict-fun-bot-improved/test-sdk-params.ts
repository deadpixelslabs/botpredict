import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// I can't easily get typescript param names but I can try to instantiate it
async function test() {
  const signer = new Wallet("0x" + "1".repeat(64));
  const pb = await OrderBuilder.make(ChainId.BnbMainnet, signer);
  console.log(pb.getMarketOrderAmounts.toString());
}
test();
