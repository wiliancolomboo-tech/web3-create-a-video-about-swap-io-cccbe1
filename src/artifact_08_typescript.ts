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
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

describe("Swap.io Protocol Invariant & CU Benchmark Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIo as Program<SwapIo>;

  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let poolPda: PublicKey;
  let poolBump: number;
  let vaultAPda: PublicKey;
  let vaultBPda: PublicKey;
  let lpMintPda: PublicKey;

  let creatorTokenA: PublicKey;
  let creatorTokenB: PublicKey;
  let creatorLpAccount: PublicKey;

  let userTokenA: PublicKey;
  let userTokenB: PublicKey;

  const user = Keypair.generate();
  const feeRecipient = Keypair.generate().publicKey;

  const INITIAL_A = new anchor.BN(10_000_000_000); // 10,000 units
  const INITIAL_B = new anchor.BN(20_000_000_000); // 20,000 units

  before(async () => {
    // Air-drop test sol
    const sig1 = await provider.connection.requestAirdrop(provider.wallet.publicKey, 100 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Create sorted mints
    const mint1 = await createMint(provider.connection, (provider.wallet as any).payer, provider.wallet.publicKey, null, 6);
    const mint2 = await createMint(provider.connection, (provider.wallet as any).payer, provider.wallet.publicKey, null, 6);

    // Canonical ordering check (A < B)
    if (Buffer.compare(mint1.toBuffer(), mint2.toBuffer()) < 0) {
      tokenAMint = mint1;
      tokenBMint = mint2;
    } else {
      tokenAMint = mint2;
      tokenBMint = mint1;
    }

    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("swap_pool"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );

    [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"), poolPda.toBuffer()],
      program.programId
    );

    [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"), poolPda.toBuffer()],
      program.programId
    );

    [lpMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), poolPda.toBuffer()],
      program.programId
    );

    creatorTokenA = await createAccount(provider.connection, (provider.wallet as any).payer, tokenAMint, provider.wallet.publicKey);
    creatorTokenB = await createAccount(provider.connection, (provider.wallet as any).payer, tokenBMint, provider.wallet.publicKey);
    creatorLpAccount = await createAccount(provider.connection, (provider.wallet as any).payer, lpMintPda, provider.wallet.publicKey);

    await mintTo(provider.connection, (provider.wallet as any).payer, tokenAMint, creatorTokenA, provider.wallet.publicKey, 100_000_000_000);
    await mintTo(provider.connection, (provider.wallet as any).payer, tokenBMint, creatorTokenB, provider.wallet.publicKey, 100_000_000_000);

    userTokenA = await createAccount(provider.connection, (provider.wallet as any).payer, tokenAMint, user.publicKey);
    userTokenB = await createAccount(provider.connection, (provider.wallet as any).payer, tokenBMint, user.publicKey);

    await mintTo(provider.connection, (provider.wallet as any).payer, tokenAMint, userTokenA, provider.wallet.publicKey, 5_000_000_000);
  });

  it("Initializes Pool Successfully with Canonical Invariants and Locked Liquidity", async () => {
    const tx = await program.methods
      .initializePool(25, 5, INITIAL_A, INITIAL_B) // 0.25% LP, 0.05% Protocol
      .accounts({
        creator: provider.wallet.publicKey,
        tokenAMint: tokenAMint,
        tokenBMint: tokenBMint,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        creatorTokenA: creatorTokenA,
        creatorTokenB: creatorTokenB,
        creatorLpAccount: creatorLpAccount,
        feeRecipient: feeRecipient,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolAccount = await program.account.pool.fetch(poolPda);
    assert.isTrue(poolAccount.reserveA.eq(INITIAL_A));
    assert.isTrue(poolAccount.reserveB.eq(INITIAL_B));
    assert.equal(poolAccount.feeLpBps, 25);
    assert.equal(poolAccount.feeProtocolBps, 5);

    const lpBalance = await provider.connection.getTokenAccountBalance(creatorLpAccount);
    // Expected LP: sqrt(10_000_000_000 * 20_000_000_000) - 1000 = 14142135623 - 1000 = 14142134623
    assert.equal(lpBalance.value.amount, "14142134623");
  });

  it("Executes Exact Token Swap (A to B) and Verifies Constant Product Invariant", async () => {
    const inputAmountA = new anchor.BN(1_000_000_000); // 1,000 units
    const minAmountOut = new anchor.BN(1_800_000_000); // Expected ~1,813 units

    const preReserveA = (await program.account.pool.fetch(poolPda)).reserveA;
    const preReserveB = (await program.account.pool.fetch(poolPda)).reserveB;

    const tx = await program.methods
      .swap(inputAmountA, minAmountOut, true)
      .accounts({
        user: user.publicKey,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        userSourceToken: userTokenA,
        userDestinationToken: userTokenB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const postPool = await program.account.pool.fetch(poolPda);
    const userBalanceB = await provider.connection.getTokenAccountBalance(userTokenB);

    assert.isTrue(postPool.reserveA.eq(preReserveA.add(inputAmountA)));
    assert.isTrue(postPool.reserveB.lt(preReserveB));
    assert.isTrue(new anchor.BN(userBalanceB.value.amount).gte(minAmountOut));

    // Invariant Check: (R_a * R_b) post must be >= (R_a * R_b) pre
    const kPre = preReserveA.mul(preReserveB);
    const kPost = postPool.reserveA.mul(postPool.reserveB);
    assert.isTrue(kPost.gte(kPre), "Invariant violated: kPost < kPre");
  });

  it("Rejects Frontrunning / Slippage Violations", async () => {
    const excessiveMinOut = new anchor.BN(5_000_000_000); // Impossible return

    try {
      await program.methods
        .swap(new anchor.BN(500_000_000), excessiveMinOut, true)
        .accounts({
          user: user.publicKey,
          pool: poolPda,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          userSourceToken: userTokenA,
          userDestinationToken: userTokenB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Transaction should have failed with SlippageExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });
});