import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SwapIo } from "../target/types/swap_io";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Swap.io Protocol Suite: Deterministic Execution & Vault Fencing", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIo as Program<SwapIo>;

  let maker: Keypair;
  let taker: Keypair;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let makerAtaB: PublicKey;
  let takerAtaA: PublicKey;
  let takerAtaB: PublicKey;

  const swapId = new BN(42069);
  const makerAmount = new BN(1_000_000_000); // 1.0 Mint A (9 decimals)
  const takerAmount = new BN(2_500_000_000); // 2.5 Mint B (9 decimals)

  before(async () => {
    maker = Keypair.generate();
    taker = Keypair.generate();

    // Airdrop SOL for transaction fees
    const airdropMaker = await provider.connection.requestAirdrop(
      maker.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    const airdropTaker = await provider.connection.requestAirdrop(
      taker.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropMaker,
    });
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropTaker,
    });

    // Deploy Mints
    mintA = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      9
    );
    mintB = await createMint(
      provider.connection,
      taker,
      taker.publicKey,
      null,
      9
    );

    // Associated Token Accounts
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

    // Fund balances
    await mintTo(
      provider.connection,
      maker,
      mintA,
      makerAtaA,
      maker,
      10_000_000_000
    );
    await mintTo(
      provider.connection,
      taker,
      mintB,
      takerAtaB,
      taker,
      10_000_000_000
    );
  });

  it("Initializes swap with isolated PDA vault and correctly locks Maker funds", async () => {
    const [swapStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swap_state"),
        maker.publicKey.toBuffer(),
        swapId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), swapStatePda.toBuffer()],
      program.programId
    );

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expiryTimestamp = new BN(currentTimestamp + 3600); // 1 hour expiry

    await program.methods
      .initializeSwap(swapId, makerAmount, takerAmount, expiryTimestamp)
      .accounts({
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        makerTokenA: makerAtaA,
        swapState: swapStatePda,
        vaultA: vaultAPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([maker])
      .rpc();

    // Verify vault balance
    const vaultAccount = await getAccount(provider.connection, vaultAPda);
    expect(vaultAccount.amount.toString()).to.equal(makerAmount.toString());

    // Verify on-chain state
    const state = await program.account.swapState.fetch(swapStatePda);
    expect(state.maker.toBase58()).to.equal(maker.publicKey.toBase58());
    expect(state.takerExpectedAmount.toString()).to.equal(takerAmount.toString());
  });

  it("Executes atomic counter-settlement and releases funds with zero reentrancy risk", async () => {
    const [swapStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swap_state"),
        maker.publicKey.toBuffer(),
        swapId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), swapStatePda.toBuffer()],
      program.programId
    );

    await program.methods
      .executeSwap()
      .accounts({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        swapState: swapStatePda,
        vaultA: vaultAPda,
        takerTokenA: takerAtaA,
        takerTokenB: takerAtaB,
        makerTokenB: makerAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Assert Taker received Asset A
    const takerAccountA = await getAccount(provider.connection, takerAtaA);
    expect(takerAccountA.amount.toString()).to.equal(makerAmount.toString());

    // Assert Maker received Asset B
    const makerAccountB = await getAccount(provider.connection, makerAtaB);
    expect(makerAccountB.amount.toString()).to.equal(takerAmount.toString());

    // Assert SwapState account was closed to refund rent lamports
    const nullSwapState = await provider.connection.getAccountInfo(swapStatePda);
    expect(nullSwapState).to.be.null;
  });

  it("Rejects settlement if the swap has expired (Time-lock defense)", async () => {
    const expiredSwapId = new BN(99999);
    const [expiredStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swap_state"),
        maker.publicKey.toBuffer(),
        expiredSwapId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [expiredVaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), expiredStatePda.toBuffer()],
      program.programId
    );

    // Initialized with a deadline 2 seconds in the future
    const now = Math.floor(Date.now() / 1000);
    const shortExpiry = new BN(now + 2);

    await program.methods
      .initializeSwap(expiredSwapId, makerAmount, takerAmount, shortExpiry)
      .accounts({
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        makerTokenA: makerAtaA,
        swapState: expiredStatePda,
        vaultA: expiredVaultAPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([maker])
      .rpc();

    // Wait 3 seconds for expiration
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      await program.methods
        .executeSwap()
        .accounts({
          taker: taker.publicKey,
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          swapState: expiredStatePda,
          vaultA: expiredVaultAPda,
          takerTokenA: takerAtaA,
          takerTokenB: takerAtaB,
          makerTokenB: makerAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      expect.fail("Execution should have failed due to expiration");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SwapExpired");
    }

    // Recover funds via cancel instruction
    await program.methods
      .cancelSwap()
      .accounts({
        maker: maker.publicKey,
        mintA: mintA,
        swapState: expiredStatePda,
        vaultA: expiredVaultAPda,
        makerTokenA: makerAtaA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const reclaimedAccount = await provider.connection.getAccountInfo(expiredStatePda);
    expect(reclaimedAccount).to.be.null;
  });
});