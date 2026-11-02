// tests/swap_io.ts
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
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("swap_io integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIo as Program<SwapIo>;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let poolPda: PublicKey;
  let vaultAPda: PublicKey;
  let vaultBPda: PublicKey;

  let userAtaA: PublicKey;
  let userAtaB: PublicKey;

  const feeBps = 30; // 0.30%
  const initialLiquidityA = new anchor.BN(10_000_000_000); // 10,000 tokens (6 decimals)
  const initialLiquidityB = new anchor.BN(20_000_000_000); // 20,000 tokens (6 decimals)

  before(async () => {
    // 1. Create token mints
    mintA = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    mintB = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // 2. Derive PDAs
    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer(), mintA.toBuffer()],
      program.programId
    );

    [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    // 3. Create User ATAs
    userAtaA = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      mintA,
      provider.wallet.publicKey
    );

    userAtaB = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      mintB,
      provider.wallet.publicKey
    );

    // 4. Mint tokens to user
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      mintA,
      userAtaA,
      provider.wallet.publicKey,
      100_000_000_000
    );

    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      mintB,
      userAtaB,
      provider.wallet.publicKey,
      100_000_000_000
    );
  });

  it("Initializes the Swap.io Liquidity Pool", async () => {
    const tx = await program.methods
      .initialize(feeBps)
      .accounts({
        initializer: provider.wallet.publicKey,
        tokenAMint: mintA,
        tokenBMint: mintB,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const poolAccount = await program.account.poolState.fetch(poolPda);
    expect(poolAccount.feeBps).to.equal(feeBps);
    expect(poolAccount.tokenAMint.toBase58()).to.equal(mintA.toBase58());
    expect(poolAccount.tokenBMint.toBase58()).to.equal(mintB.toBase58());
  });

  it("Funds the Pool Vaults for Testing", async () => {
    // Direct funding of vaults to simulate active LP presence
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      mintA,
      vaultAPda,
      provider.wallet.publicKey,
      initialLiquidityA.toNumber()
    );

    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      mintB,
      vaultBPda,
      provider.wallet.publicKey,
      initialLiquidityB.toNumber()
    );

    const vaultAInfo = await getAccount(provider.connection, vaultAPda);
    const vaultBInfo = await getAccount(provider.connection, vaultBPda);

    expect(Number(vaultAInfo.amount)).to.equal(initialLiquidityA.toNumber());
    expect(Number(vaultBInfo.amount)).to.equal(initialLiquidityB.toNumber());
  });

  it("Executes an Atomic Swap: Token A -> Token B", async () => {
    const swapAmountIn = new anchor.BN(1_000_000_000); // 1,000 Token A
    // Math prediction:
    // dx = 1,000,000,000; fee = 30 bps -> 0.3% -> dx_net = 997,000,000
    // dy = (997,000,000 * 20,000,000,000) / (10,000,000,000 + 997,000,000)
    // dy ≈ 19,940,000,000,000,000,000 / 10,997,000,000 ≈ 1,813,221,787
    const expectedOutMin = new anchor.BN(1_800_000_000);

    const preUserB = await getAccount(provider.connection, userAtaB);

    await program.methods
      .swap(swapAmountIn, expectedOutMin)
      .accounts({
        user: provider.wallet.publicKey,
        pool: poolPda,
        tokenInMint: mintA,
        tokenOutMint: mintB,
        vaultIn: vaultAPda,
        vaultOut: vaultBPda,
        userTokenIn: userAtaA,
        userTokenOut: userAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postUserB = await getAccount(provider.connection, userAtaB);
    const receivedB = Number(postUserB.amount) - Number(preUserB.amount);

    expect(receivedB).to.be.gte(expectedOutMin.toNumber());
  });

  it("Enforces Slippage Guard Failures", async () => {
    const swapAmountIn = new anchor.BN(1_000_000_000);
    const unrealisticallyHighMinOut = new anchor.BN(10_000_000_000); // Impossible price

    try {
      await program.methods
        .swap(swapAmountIn, unrealisticallyHighMinOut)
        .accounts({
          user: provider.wallet.publicKey,
          pool: poolPda,
          tokenInMint: mintA,
          tokenOutMint: mintB,
          vaultIn: vaultAPda,
          vaultOut: vaultBPda,
          userTokenIn: userAtaA,
          userTokenOut: userAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Swap should have failed due to slippage");
    } catch (err: any) {
      expect(err.toString()).to.include("SlippageExceeded");
    }
  });
});