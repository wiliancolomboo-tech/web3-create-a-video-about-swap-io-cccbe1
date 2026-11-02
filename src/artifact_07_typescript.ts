import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwapIoRouter } from "../target/types/swap_io_router";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwapIoRouter as Program<SwapIoRouter>;

  console.log("-----------------------------------------------");
  console.log("Swap.io Production Routing Execution Engine");
  console.log("Connected Wallet:", provider.wallet.publicKey.toBase58());
  console.log("Program ID:      ", program.programId.toBase58());
  console.log("-----------------------------------------------");

  // Invocations can be directly performed using configured keys and target pool addresses
  console.log("Execute live swap routes via `anchor run execute-live`");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);