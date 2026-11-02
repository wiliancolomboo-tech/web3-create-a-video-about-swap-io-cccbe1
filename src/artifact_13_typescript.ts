import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwapIo } from "../target/types/swap_io";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import { BN } from "bn.js";

describe("Swap.io Protocol Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwapIo as Program<SwapIo>;

  const maker = anchor.web3.Keypair.generate();
  const taker = anchor.web3.Keypair.generate();

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let makerAtaA: anchor.web3.PublicKey;
  let makerAtaB: anchor.web3.PublicKey;
  let takerAtaA: anchor.web3.PublicKey;
  let takerAtaB: anchor.web3.PublicKey;

  const offerId1 = new BN(1001);
  const offerId2 = new BN(1002);
  const tokenAAmount = new BN(500_000_000); // 500 tokens (decimals = 6)
  const tokenBAmount = new BN(1_000_000_000); // 1000 tokens (decimals = 6)

  before(async () => {
    // 1. Airdrop SOL to Maker and Taker
    const airdropMaker = await provider.connection.requestAirdrop(
      maker.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    const airdropTaker = await provider.connection.requestAirdrop(
      taker.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropMaker);
    await provider.connection.confirmTransaction(airdropTaker);

    // 2. Create Mints A & B
    mintA = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      6
    );
    mintB = await createMint(
      provider.connection,
      taker,
      taker.publicKey,
      null,
      6
    );

    // 3. Create ATAs
    makerAtaA = await createAssociatedTokenAccount(
      provider.connection,
      maker,
      mintA,
      maker.publicKey
    );
    makerAtaB = await createAssociatedTokenAccount(
      provider.connection,
      maker,
      mintB,
      maker.publicKey
    );

    takerAtaA = await createAssociatedTokenAccount(
      provider.connection,
      taker,
      mintA,
      taker.publicKey
    );
    takerAtaB = await createAssociatedTokenAccount(
      provider.connection,
      taker,
      mintB,
      taker.publicKey
    );

    // 4. Fund Maker with Mint A and Taker with Mint B
    await mintTo(
      provider.connection,
      maker,
      mintA,
      makerAtaA,
      maker,
      2_000_000_000
    );
    await mintTo(
      provider.connection,
      taker,
      mintB,
      takerAtaB,
      taker,
      2_000_000_000
    );
  });

  it("1. Successfully creates an atomic escrow offer (make_offer)", async () => {
    const [offerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        maker.publicKey.toBuffer(),
        offerId1.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(
      mintA,
      offerPda,
      true,
      TOKEN_PROGRAM_ID
    );

    await program.methods
      .makeOffer(offerId1, tokenAAmount, tokenBAmount)
      .accountsPartial({
        maker: maker.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        makerTokenAccountA: makerAtaA,
        offer: offerPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    // Verify Offer PDA data
    const offerAccount = await program.account.offer.fetch(offerPda);
    assert.ok(offerAccount.maker.equals(maker.publicKey));
    assert.ok(offerAccount.tokenMintA.equals(mintA));
    assert.ok(offerAccount.tokenMintB.equals(mintB));
    assert.equal(
      offerAccount.tokenBWantedAmount.toString(),
      tokenBAmount.toString()
    );

    // Verify vault balance
    const vaultAta = await getAccount(provider.connection, vault);
    assert.equal(vaultAta.amount.toString(), tokenAAmount.toString());
  });

  it("2. Atomically fills the offer and closes vault/PDA (take_offer)", async () => {
    const [offerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        maker.publicKey.toBuffer(),
        offerId1.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(
      mintA,
      offerPda,
      true,
      TOKEN_PROGRAM_ID
    );

    const makerInitialLamports = await provider.connection.getBalance(
      maker.publicKey
    );

    await program.methods
      .takeOffer()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        takerTokenAccountA: takerAtaA,
        takerTokenAccountB: takerAtaB,
        makerTokenAccountB: makerAtaB,
        offer: offerPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();

    // Verify balances after swap
    const takerTokenA = await getAccount(provider.connection, takerAtaA);
    const makerTokenB = await getAccount(provider.connection, makerAtaB);

    assert.equal(takerTokenA.amount.toString(), tokenAAmount.toString());
    assert.equal(makerTokenB.amount.toString(), tokenBAmount.toString());

    // Verify Offer PDA has been closed
    const closedOffer = await provider.connection.getAccountInfo(offerPda);
    assert.isNull(closedOffer, "Offer account must be purged from state");

    // Verify Vault ATA has been closed
    const closedVault = await provider.connection.getAccountInfo(vault);
    assert.isNull(closedVault, "Vault account must be closed and rent reclaimed");

    // Verify rent refunded to maker
    const makerFinalLamports = await provider.connection.getBalance(
      maker.publicKey
    );
    assert.isAbove(
      makerFinalLamports,
      makerInitialLamports,
      "Rent must be returned to maker"
    );
  });

  it("3. Successfully cancels an offer and refunds Maker escrow (cancel_offer)", async () => {
    const [offerPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        maker.publicKey.toBuffer(),
        offerId2.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(
      mintA,
      offerPda,
      true,
      TOKEN_PROGRAM_ID
    );

    // Create second offer
    await program.methods
      .makeOffer(offerId2, tokenAAmount, tokenBAmount)
      .accountsPartial({
        maker: maker.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        makerTokenAccountA: makerAtaA,
        offer: offerPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const makerBalBeforeCancel = (
      await getAccount(provider.connection, makerAtaA)
    ).amount;

    // Cancel offer
    await program.methods
      .cancelOffer()
      .accountsPartial({
        maker: maker.publicKey,
        tokenMintA: mintA,
        makerTokenAccountA: makerAtaA,
        offer: offerPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const makerBalAfterCancel = (
      await getAccount(provider.connection, makerAtaA)
    ).amount;
    assert.equal(
      (BigInt(makerBalAfterCancel) - BigInt(makerBalBeforeCancel)).toString(),
      tokenAAmount.toString()
    );

    // Ensure account closure
    const closedOffer = await provider.connection.getAccountInfo(offerPda);
    assert.isNull(closedOffer);
  });
});