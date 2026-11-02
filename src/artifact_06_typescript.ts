import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwapIo } from "../target/types/swap_io";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("swap-io core unit & integration test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwapIo as Program<SwapIo>;

  const maker = Keypair.generate();
  const taker = Keypair.generate();
  const attacker = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;

  let makerTokenAccountA: PublicKey;
  let makerTokenAccountB: PublicKey;
  let takerTokenAccountA: PublicKey;
  let takerTokenAccountB: PublicKey;

  const offerId = new anchor.BN(42);
  const makerAmount = new anchor.BN(1_000_000); // 1.00 Token A
  const takerAmount = new anchor.BN(2_500_000); // 2.50 Token B

  before(async () => {
    // 1. Fund Wallets with SOL
    const airdropMaker = await provider.connection.requestAirdrop(maker.publicKey, 10 * LAMPORTS_PER_SOL);
    const airdropTaker = await provider.connection.requestAirdrop(taker.publicKey, 10 * LAMPORTS_PER_SOL);
    const airdropAttacker = await provider.connection.requestAirdrop(attacker.publicKey, 2 * LAMPORTS_PER_SOL);
    
    await provider.connection.confirmTransaction(airdropMaker);
    await provider.connection.confirmTransaction(airdropTaker);
    await provider.connection.confirmTransaction(airdropAttacker);

    // 2. Initialize Mints (6 Decimals)
    mintA = await createMint(provider.connection, maker, maker.publicKey, null, 6);
    mintB = await createMint(provider.connection, taker, taker.publicKey, null, 6);

    // 3. Initialize Token Accounts
    makerTokenAccountA = await createAccount(provider.connection, maker, mintA, maker.publicKey);
    makerTokenAccountB = await createAccount(provider.connection, maker, mintB, maker.publicKey);

    takerTokenAccountA = await createAccount(provider.connection, taker, mintA, taker.publicKey);
    takerTokenAccountB = await createAccount(provider.connection, taker, mintB, taker.publicKey);

    // 4. Mint tokens to participants
    await mintTo(provider.connection, maker, mintA, makerTokenAccountA, maker, 10_000_000);
    await mintTo(provider.connection, taker, mintB, takerTokenAccountB, taker, 10_000_000);
  });

  it("1. Successfully initializes an atomic swap offer into PDA escrow", async () => {
    const [swapOfferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), maker.publicKey.toBuffer(), offerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), swapOfferPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .initializeSwap(offerId, makerAmount, takerAmount, new anchor.BN(0))
      .accountsPartial({
        maker: maker.publicKey,
        taker: taker.publicKey,
        makerMint: mintA,
        takerMint: mintB,
        makerTokenAccount: makerTokenAccountA,
        swapOffer: swapOfferPda,
        vaultAccount: vaultAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    expect(tx).to.be.a("string");

    // Verify vault balance
    const vaultAta = await getAccount(provider.connection, vaultAccountPda);
    expect(Number(vaultAta.amount)).to.equal(makerAmount.toNumber());

    // Verify offer state
    const offerState = await program.account.swapOffer.fetch(swapOfferPda);
    expect(offerState.maker.toBase58()).to.equal(maker.publicKey.toBase58());
    expect(offerState.taker.toBase58()).to.equal(taker.publicKey.toBase58());
    expect(offerState.makerAmount.toString()).to.equal(makerAmount.toString());
    expect(offerState.takerAmount.toString()).to.equal(takerAmount.toString());
  });

  it("2. Blocks unauthorized attacker from accepting targeted swap", async () => {
    const [swapOfferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), maker.publicKey.toBuffer(), offerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), swapOfferPda.toBuffer()],
      program.programId
    );

    const attackerTokenAccountB = await createAccount(provider.connection, attacker, mintB, attacker.publicKey);
    const attackerTokenAccountA = await createAccount(provider.connection, attacker, mintA, attacker.publicKey);

    try {
      await program.methods
        .acceptSwap()
        .accountsPartial({
          taker: attacker.publicKey,
          maker: maker.publicKey,
          swapOffer: swapOfferPda,
          makerMint: mintA,
          takerMint: mintB,
          vaultAccount: vaultAccountPda,
          takerTokenAccount: attackerTokenAccountB,
          makerTakerMintAccount: makerTokenAccountB,
          takerMakerMintAccount: attackerTokenAccountA,
          makerTokenProgram: TOKEN_PROGRAM_ID,
          takerTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();

      expect.fail("Attacker should not be able to execute targeted swap");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedTaker");
    }
  });

  it("3. Successfully executes atomic settlement and closes escrow PDAs", async () => {
    const [swapOfferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), maker.publicKey.toBuffer(), offerId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), swapOfferPda.toBuffer()],
      program.programId
    );

    const initialMakerSol = await provider.connection.getBalance(maker.publicKey);

    await program.methods
      .acceptSwap()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        swapOffer: swapOfferPda,
        makerMint: mintA,
        takerMint: mintB,
        vaultAccount: vaultAccountPda,
        takerTokenAccount: takerTokenAccountB,
        makerTakerMintAccount: makerTokenAccountB,
        takerMakerMintAccount: takerTokenAccountA,
        makerTokenProgram: TOKEN_PROGRAM_ID,
        takerTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Verify final balances
    const makerMintBBalance = await getAccount(provider.connection, makerTokenAccountB);
    const takerMintABalance = await getAccount(provider.connection, takerTokenAccountA);

    expect(Number(makerMintBBalance.amount)).to.equal(takerAmount.toNumber());
    expect(Number(takerMintABalance.amount)).to.equal(makerAmount.toNumber());

    // Verify PDA accounts are closed & rent reimbursed
    const offerInfo = await provider.connection.getAccountInfo(swapOfferPda);
    const vaultInfo = await provider.connection.getAccountInfo(vaultAccountPda);
    expect(offerInfo).to.be.null;
    expect(vaultInfo).to.be.null;

    const finalMakerSol = await provider.connection.getBalance(maker.publicKey);
    expect(finalMakerSol).to.be.greaterThan(initialMakerSol);
  });

  it("4. Allows maker to cancel unaccepted swap and recovers all tokens and rent", async () => {
    const cancelOfferId = new anchor.BN(99);
    const [cancelOfferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), maker.publicKey.toBuffer(), cancelOfferId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [cancelVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), cancelOfferPda.toBuffer()],
      program.programId
    );

    // Initialize
    await program.methods
      .initializeSwap(cancelOfferId, makerAmount, takerAmount, new anchor.BN(0))
      .accountsPartial({
        maker: maker.publicKey,
        taker: PublicKey.default,
        makerMint: mintA,
        takerMint: mintB,
        makerTokenAccount: makerTokenAccountA,
        swapOffer: cancelOfferPda,
        vaultAccount: cancelVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Cancel
    await program.methods
      .cancelSwap()
      .accountsPartial({
        maker: maker.publicKey,
        swapOffer: cancelOfferPda,
        makerMint: mintA,
        vaultAccount: cancelVaultPda,
        makerTokenAccount: makerTokenAccountA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Confirm offer and vault are deleted
    const offerInfo = await provider.connection.getAccountInfo(cancelOfferPda);
    const vaultInfo = await provider.connection.getAccountInfo(cancelVaultPda);
    expect(offerInfo).to.be.null;
    expect(vaultInfo).to.be.null;
  });
});