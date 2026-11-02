import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SwapIo } from "../target/types/swap_io";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("swap-io protocol verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIo as Program<SwapIo>;
  const connection = provider.connection;

  let maker: Keypair;
  let taker: Keypair;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerTokenA: PublicKey;
  let takerTokenB: PublicKey;

  const orderId = new BN(1001);
  const amountA = new BN(50_000_000); // 50 Token A (6 decimals)
  const amountB = new BN(100_000_000); // 100 Token B (6 decimals)
  const expiryWindow = new BN(3600); // 1 hour

  before(async () => {
    maker = Keypair.generate();
    taker = Keypair.generate();

    // Fund SOL for rent and gas
    const airdropA = await connection.requestAirdrop(maker.publicKey, 5 * LAMPORTS_PER_SOL);
    const airdropB = await connection.requestAirdrop(taker.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropA);
    await connection.confirmTransaction(airdropB);

    // Create dual mints
    mintA = await createMint(connection, maker, maker.publicKey, null, 6);
    mintB = await createMint(connection, taker, taker.publicKey, null, 6);

    // Create user token accounts
    makerTokenA = await createAssociatedTokenAccount(connection, maker, mintA, maker.publicKey);
    takerTokenB = await createAssociatedTokenAccount(connection, taker, mintB, taker.publicKey);

    // Mint liquidity balances
    await mintTo(connection, maker, mintA, makerTokenA, maker, 100_000_000);
    await mintTo(connection, taker, mintB, takerTokenB, taker, 200_000_000);
  });

  it("1. Initializes order and deposits Token A into PDA Vault", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .initializeOrder(orderId, amountA, amountB, expiryWindow)
      .accounts({
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        makerTokenA: makerTokenA,
        tokenProgramA: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const vaultAccount = await getAccount(connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(50_000_000);

    const escrowState = await program.account.escrowState.fetch(escrowPda);
    expect(escrowState.maker.toBase58()).to.equal(maker.publicKey.toBase58());
    expect(escrowState.amountA.toNumber()).to.equal(50_000_000);
    expect(escrowState.expectedAmountB.toNumber()).to.equal(100_000_000);
  });

  it("2. Fills order atomically with Token B exchange", async () => {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), orderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .fillOrder()
      .accounts({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        takerTokenB: takerTokenB,
        escrowState: escrowPda,
        vaultA: vaultPda,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();

    // Verify Escrow and Vault PDAs are completely closed and rent recovered
    const closedEscrow = await connection.getAccountInfo(escrowPda);
    const closedVault = await connection.getAccountInfo(vaultPda);
    expect(closedEscrow).to.be.null;
    expect(closedVault).to.be.null;

    // Verify Taker received Token A
    const takerTokenA = anchor.utils.token.associatedAddress({
      mint: mintA,
      owner: taker.publicKey,
    });
    const takerAInfo = await getAccount(connection, takerTokenA);
    expect(Number(takerAInfo.amount)).to.equal(50_000_000);

    // Verify Maker received Token B
    const makerTokenB = anchor.utils.token.associatedAddress({
      mint: mintB,
      owner: maker.publicKey,
    });
    const makerBInfo = await getAccount(connection, makerTokenB);
    expect(Number(makerBInfo.amount)).to.equal(100_000_000);
  });

  it("3. Validates order cancellation flow", async () => {
    const cancelOrderId = new BN(1002);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), cancelOrderId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    // Initialize order 1002
    await program.methods
      .initializeOrder(cancelOrderId, new BN(10_000_000), new BN(20_000_000), new BN(600))
      .accounts({
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        makerTokenA: makerTokenA,
        tokenProgramA: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    // Cancel order
    await program.methods
      .cancelOrder()
      .accounts({
        maker: maker.publicKey,
        mintA: mintA,
        makerTokenA: makerTokenA,
        escrowState: escrowPda,
        vaultA: vaultPda,
        tokenProgramA: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const cancelledState = await connection.getAccountInfo(escrowPda);
    expect(cancelledState).to.be.null;
  });
});