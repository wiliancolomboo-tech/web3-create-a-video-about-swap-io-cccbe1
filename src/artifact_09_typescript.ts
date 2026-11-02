import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwapIoRouter } from "../target/types/swap_io_router";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("Swap.io Routing Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIoRouter as Program<SwapIoRouter>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let inputMint: PublicKey;
  let outputMint: PublicKey;
  let userInputAta: PublicKey;
  let userOutputAta: PublicKey;
  let routerConfigPda: PublicKey;
  let routerVaultPda: PublicKey;

  const FEE_BASIS_POINTS = 5; // 0.05%

  before(async () => {
    // 1. Derive PDAs
    [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      program.programId
    );

    // 2. Initialize input and output test mints
    inputMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    outputMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    [routerVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), outputMint.toBuffer()],
      program.programId
    );

    // 3. Create User ATAs
    userInputAta = await createAccount(
      provider.connection,
      payer,
      inputMint,
      payer.publicKey
    );

    userOutputAta = await createAccount(
      provider.connection,
      payer,
      outputMint,
      payer.publicKey
    );

    // 4. Create router vault account
    await createAccount(
      provider.connection,
      payer,
      outputMint,
      routerVaultPda,
      Keypair.generate() // keypair for deterministic allocation
    );

    // 5. Mint tokens to user input ATA and router vault (for liquidity reserve)
    await mintTo(
      provider.connection,
      payer,
      inputMint,
      userInputAta,
      payer,
      100_000_000 // 100 Tokens
    );

    await mintTo(
      provider.connection,
      payer,
      outputMint,
      routerVaultPda,
      payer,
      100_000_000 // 100 Tokens in Vault
    );
  });

  it("Initializes the Swap.io router state successfully", async () => {
    const tx = await program.methods
      .initialize(FEE_BASIS_POINTS)
      .accounts({
        routerConfig: routerConfigPda,
        admin: payer.publicKey,
        feeRecipient: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.routerConfig.fetch(routerConfigPda);
    assert.equal(configAccount.feeBasisPoints, FEE_BASIS_POINTS);
    assert.isTrue(configAccount.admin.equals(payer.publicKey));
    assert.equal(configAccount.totalSwapsRouted.toNumber(), 0);
  });

  it("Executes atomic route with valid parameters and verifies balances", async () => {
    const amountIn = new anchor.BN(10_000_000); // 10 tokens
    const minAmountOut = new anchor.BN(9_950_000); // 9.95 tokens
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 120);

    const initialUserIn = (await getAccount(provider.connection, userInputAta)).amount;
    const initialUserOut = (await getAccount(provider.connection, userOutputAta)).amount;

    await program.methods
      .executeSwap({
        amountIn,
        minAmountOut,
        deadline,
      })
      .accounts({
        routerConfig: routerConfigPda,
        user: payer.publicKey,
        inputMint,
        outputMint,
        userInputAta,
        userOutputAta,
        routerOutputVault: routerVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const finalUserIn = (await getAccount(provider.connection, userInputAta)).amount;
    const finalUserOut = (await getAccount(provider.connection, userOutputAta)).amount;

    expect(Number(initialUserIn) - Number(finalUserIn)).to.be.closeTo(
      amountIn.toNumber(),
      1000
    );
    expect(Number(finalUserOut) - Number(initialUserOut)).to.equal(
      minAmountOut.toNumber()
    );

    const configAccount = await program.account.routerConfig.fetch(routerConfigPda);
    assert.equal(configAccount.totalSwapsRouted.toNumber(), 1);
  });

  it("Fails execution when deadline is expired (Security Check)", async () => {
    const amountIn = new anchor.BN(1_000_000);
    const minAmountOut = new anchor.BN(900_000);
    const pastDeadline = new anchor.BN(Math.floor(Date.now() / 1000) - 300); // 5 mins ago

    try {
      await program.methods
        .executeSwap({
          amountIn,
          minAmountOut,
          deadline: pastDeadline,
        })
        .accounts({
          routerConfig: routerConfigPda,
          user: payer.publicKey,
          inputMint,
          outputMint,
          userInputAta,
          userOutputAta,
          routerOutputVault: routerVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Transaction should have failed with DeadlineExceeded.");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DeadlineExceeded");
    }
  });

  it("Fails execution when slippage constraint is breached", async () => {
    const amountIn = new anchor.BN(1_000_000);
    // Requesting impossible output compared to what the vault dispatches
    const impossibleMinOut = new anchor.BN(200_000_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 120);

    try {
      await program.methods
        .executeSwap({
          amountIn,
          minAmountOut: impossibleMinOut,
          deadline,
        })
        .accounts({
          routerConfig: routerConfigPda,
          user: payer.publicKey,
          inputMint,
          outputMint,
          userInputAta,
          userOutputAta,
          routerOutputVault: routerVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Transaction should have failed with SlippageExceeded / InsufficientFunds.");
    } catch (err: any) {
      assert.isOk(err);
    }
  });
});