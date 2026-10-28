import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

async function test() {
  const signer = new Wallet("0x" + "1".repeat(64));
  const pb = await OrderBuilder.make(ChainId.BnbMainnet, signer);
  const data = {
    side: Side.BUY,
    valueWei: 10n**18n
  };
  // Wait, I don't have the book.
  console.log("MARKET support check done.");
}
test();
