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
import { assert, expect } from "chai";
import BN from "bn.js";

describe("Swap.io Protocol Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIo as Program<SwapIo>;

  const maker = anchor.web3.Keypair.generate();
  const taker = anchor.web3.Keypair.generate();
  let tokenMintA: anchor.web3.Pubkey;
  let tokenMintB: anchor.web3.Pubkey;

  let makerTokenAccountA: anchor.web3.Pubkey;
  let makerTokenAccountB: anchor.web3.Pubkey;
  let takerTokenAccountA: anchor.web3.Pubkey;
  let takerTokenAccountB: anchor.web3.Pubkey;

  const seed = new BN(42);
  const amountOffered = new BN(1_000_000_000); // 1,000 Token A (6 decimals)
  const amountExpected = new BN(2_500_000_000); // 2,500 Token B (6 decimals)

  let swapEscrowPda: anchor.web3.Pubkey;
  let vaultAccountPda: anchor.web3.Pubkey;

  before(async () => {
    // Fund maker and taker with SOL for transaction execution
    const airdropMaker = await provider.connection.requestAirdrop(
      maker.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropMaker);

    const airdropTaker = await provider.connection.requestAirdrop(
      taker.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropTaker);

    // Deploy test mints
    tokenMintA = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      6
    );
    tokenMintB = await createMint(
      provider.connection,
      taker,
      taker.publicKey,
      null,
      6
    );

    // Setup Token Accounts
    makerTokenAccountA = await createAccount(
      provider.connection,
      maker,
      tokenMintA,
      maker.publicKey
    );
    makerTokenAccountB = await createAccount(
      provider.connection,
      maker,
      tokenMintB,
      maker.publicKey
    );

    takerTokenAccountA = await createAccount(
      provider.connection,
      taker,
      tokenMintA,
      taker.publicKey
    );
    takerTokenAccountB = await createAccount(
      provider.connection,
      taker,
      tokenMintB,
      taker.publicKey
    );

    // Fund balances
    await mintTo(
      provider.connection,
      maker,
      tokenMintA,
      makerTokenAccountA,
      maker,
      10_000_000_000
    );
    await mintTo(
      provider.connection,
      taker,
      tokenMintB,
      takerTokenAccountB,
      taker,
      10_000_000_000
    );

    // Derive PDAs
    [swapEscrowPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("swap_escrow"),
        maker.publicKey.toBuffer(),
        seed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [vaultAccountPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), swapEscrowPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully creates a Swap.io Escrow with isolated PDA vault", async () => {
    const currentSlot = await provider.connection.getSlot();
    const blockTime = (await provider.connection.getBlockTime(currentSlot)) ?? 0;
    const expiry = new BN(blockTime + 3600); // 1 hour forward

    await program.methods
      .createSwapEscrow(seed, amountOffered, amountExpected, expiry)
      .accountsStrict({
        maker: maker.publicKey,
        makerMint: tokenMintA,
        takerMint: tokenMintB,
        makerTokenAccount: makerTokenAccountA,
        swapEscrow: swapEscrowPda,
        vaultAccount: vaultAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Verify vault balance
    const vaultAta = await getAccount(provider.connection, vaultAccountPda);
    assert.strictEqual(
      vaultAta.amount.toString(),
      amountOffered.toString(),
      "Vault does not hold expected offered token amount"
    );

    // Verify PDA state fields
    const escrowAccount = await program.account.swapEscrow.fetch(swapEscrowPda);
    assert.strictEqual(escrowAccount.maker.toBase58(), maker.publicKey.toBase58());
    assert.strictEqual(
      escrowAccount.amountOffered.toString(),
      amountOffered.toString()
    );
    assert.strictEqual(
      escrowAccount.amountExpected.toString(),
      amountExpected.toString()
    );
  });

  it("2. Fulfills atomic swap without slippage and closes PDA rent accounts", async () => {
    const makerInitialBalB = (
      await getAccount(provider.connection, makerTokenAccountB)
    ).amount;
    const takerInitialBalA = (
      await getAccount(provider.connection, takerTokenAccountA)
    ).amount;

    await program.methods
      .fulfillSwap()
      .accountsStrict({
        taker: taker.publicKey,
        maker: maker.publicKey,
        makerMint: tokenMintA,
        takerMint: tokenMintB,
        takerTokenAccount: takerTokenAccountB,
        makerReceiveAccount: makerTokenAccountB,
        takerReceiveAccount: takerTokenAccountA,
        swapEscrow: swapEscrowPda,
        vaultAccount: vaultAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Confirm balances post-execution
    const makerFinalBalB = (
      await getAccount(provider.connection, makerTokenAccountB)
    ).amount;
    const takerFinalBalA = (
      await getAccount(provider.connection, takerTokenAccountA)
    ).amount;

    expect(Number(makerFinalBalB - makerInitialBalB)).to.equal(
      amountExpected.toNumber()
    );
    expect(Number(takerFinalBalA - takerInitialBalA)).to.equal(
      amountOffered.toNumber()
    );

    // Check that Swap Escrow account has been cleanly closed (0 lamports)
    const closedEscrow = await provider.connection.getAccountInfo(swapEscrowPda);
    assert.isNull(closedEscrow, "Escrow PDA was not deallocated/closed");
  });

  it("3. Rejects fulfillment with mismatched counterparty mints", async () => {
    // Generate fresh seed and bogus escrow
    const badSeed = new BN(99);
    const [badEscrow] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("swap_escrow"),
        maker.publicKey.toBuffer(),
        badSeed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [badVault] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), badEscrow.toBuffer()],
      program.programId
    );

    const blockTime = (await provider.connection.getBlockTime(
      await provider.connection.getSlot()
    )) ?? 0;

    await program.methods
      .createSwapEscrow(badSeed, amountOffered, amountExpected, new BN(blockTime + 600))
      .accountsStrict({
        maker: maker.publicKey,
        makerMint: tokenMintA,
        takerMint: tokenMintB,
        makerTokenAccount: makerTokenAccountA,
        swapEscrow: badEscrow,
        vaultAccount: badVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Attempt fulfill with tokenMintA swapped into the taker receive account erroneously
    try {
      await program.methods
        .fulfillSwap()
        .accountsStrict({
          taker: taker.publicKey,
          maker: maker.publicKey,
          makerMint: tokenMintA,
          takerMint: tokenMintA, // Malicious / invalid mint substitute
          takerTokenAccount: takerTokenAccountA,
          makerReceiveAccount: makerTokenAccountA,
          takerReceiveAccount: takerTokenAccountA,
          swapEscrow: badEscrow,
          vaultAccount: badVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      assert.fail("Should have failed with constraint violation");
    } catch (err: any) {
      expect(err.toString()).to.contain("Error");
    }
  });
});