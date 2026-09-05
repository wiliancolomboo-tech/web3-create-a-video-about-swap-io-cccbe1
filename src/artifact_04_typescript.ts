import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwapIo } from "../target/types/swap_io";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("Swap.io Protocol QA Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIo as Program<SwapIo>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let poolPda: PublicKey;
  let poolBump: number;
  let vaultAPda: PublicKey;
  let vaultABump: number;
  let vaultBPda: PublicKey;
  let vaultBBump: number;

  let userTokenA: PublicKey;
  let userTokenB: PublicKey;

  const INITIAL_LIQUIDITY = 1_000_000_000n; // 1,000 tokens (decimals = 6)
  const SWAP_AMOUNT_IN = 10_000_000n;        // 10 tokens

  before(async () => {
    // 1. Create Token-2022 Mints
    mintA = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    mintB = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Ensure deterministic ordering for seeds
    if (Buffer.compare(mintA.toBuffer(), mintB.toBuffer()) > 0) {
      const temp = mintA;
      mintA = mintB;
      mintB = temp;
    }

    // 2. Derive PDAs
    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    [vaultAPda, vaultABump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer(), mintA.toBuffer()],
      program.programId
    );

    [vaultBPda, vaultBBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    // 3. Setup User Token Accounts
    userTokenA = await createAccount(
      provider.connection,
      payer,
      mintA,
      payer.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    userTokenB = await createAccount(
      provider.connection,
      payer,
      mintB,
      payer.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Mint test supplies
    await mintTo(
      provider.connection,
      payer,
      mintA,
      userTokenA,
      payer,
      INITIAL_LIQUIDITY * 2n,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      payer,
      mintB,
      userTokenB,
      payer,
      INITIAL_LIQUIDITY * 2n,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("Initializes the Swap.io Liquidity Pool successfully", async () => {
    const feeBps = 30; // 0.30%
    await program.methods
      .initializePool(poolBump, vaultABump, vaultBBump, feeBps)
      .accounts({
        initializer: payer.publicKey,
        mintA: mintA,
        mintB: mintB,
        poolState: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const poolAccount = await program.account.poolState.fetch(poolPda);
    assert.strictEqual(poolAccount.feeBasisPoints, feeBps);
    assert.isTrue(poolAccount.vaultA.equals(vaultAPda));
    assert.isTrue(poolAccount.vaultB.equals(vaultBPda));
    assert.isFalse(poolAccount.isLocked);

    // Seed Vaults with initial reserves
    await mintTo(
      provider.connection,
      payer,
      mintA,
      vaultAPda,
      payer,
      INITIAL_LIQUIDITY,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      payer,
      mintB,
      vaultBPda,
      payer,
      INITIAL_LIQUIDITY,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("Executes a valid swap within expected slippage bounds", async () => {
    const userBalanceBefore = (
      await getAccount(
        provider.connection,
        userTokenB,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    ).amount;

    // dy = (y * dx * 0.997) / (x + dx * 0.997)
    // dy ≈ (1,000,000,000 * 9,970,000) / (1,000,000,000 + 9,970,000) ≈ 9,871,580
    const minAmountOut = 9_800_000n;

    const txSignature = await program.methods
      .swap(new anchor.BN(SWAP_AMOUNT_IN.toString()), new anchor.BN(minAmountOut.toString()))
      .accounts({
        user: payer.publicKey,
        poolState: poolPda,
        mintIn: mintA,
        mintOut: mintB,
        vaultIn: vaultAPda,
        vaultOut: vaultBPda,
        userTokenIn: userTokenA,
        userTokenOut: userTokenB,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const userBalanceAfter = (
      await getAccount(
        provider.connection,
        userTokenB,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    ).amount;

    const delta = userBalanceAfter - userBalanceBefore;
    assert.isTrue(delta >= minAmountOut, "Received tokens must exceed slippage threshold");
    console.log(`[PASS] Swap succeeded. Transferred: ${delta.toString()} units. Tx: ${txSignature}`);
  });

  it("Reverts deterministically when slippage exceeds minimum allowed", async () => {
    const excessiveMinOut = 50_000_000n; // Impossible output requirement

    try {
      await program.methods
        .swap(new anchor.BN(SWAP_AMOUNT_IN.toString()), new anchor.BN(excessiveMinOut.toString()))
        .accounts({
          user: payer.publicKey,
          poolState: poolPda,
          mintIn: mintA,
          mintOut: mintB,
          vaultIn: vaultAPda,
          vaultOut: vaultBPda,
          userTokenIn: userTokenA,
          userTokenOut: userTokenB,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Transaction should have reverted with SlippageExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });

  it("Prevents unauthorized vault tampering", async () => {
    const rogueToken = await createAccount(
      provider.connection,
      payer,
      mintB,
      payer.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await program.methods
        .swap(new anchor.BN(SWAP_AMOUNT_IN.toString()), new anchor.BN(1n))
        .accounts({
          user: payer.publicKey,
          poolState: poolPda,
          mintIn: mintA,
          mintOut: mintB,
          vaultIn: vaultAPda,
          vaultOut: rogueToken, // Malicious substitution
          userTokenIn: userTokenA,
          userTokenOut: userTokenB,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Transaction should have failed constraint check for vault_out");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidVault");
    }
  });
});