import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwapIoCore } from "../target/types/swap_io_core";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("swap_io_core Integration Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwapIoCore as Program<SwapIoCore>;

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;

  const maker = anchor.web3.Keypair.generate();
  const taker = anchor.web3.Keypair.generate();

  let makerAtaA: anchor.web3.PublicKey;
  let makerAtaB: anchor.web3.PublicKey;
  let takerAtaA: anchor.web3.PublicKey;
  let takerAtaB: anchor.web3.PublicKey;

  const seed = new anchor.BN(Math.floor(Math.random() * 1_000_000));
  const amountA = new anchor.BN(100_000_000); // 100 Tokens (6 Decimals)
  const amountB = new anchor.BN(250_000_000); // 250 Tokens (6 Decimals)

  before(async () => {
    // 1. Airdrop SOL to Maker and Taker
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(maker.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(taker.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // 2. Initialize Mints
    mintA = await createMint(provider.connection, maker, maker.publicKey, null, 6);
    mintB = await createMint(provider.connection, taker, taker.publicKey, null, 6);

    // 3. Create ATAs
    makerAtaA = await createAssociatedTokenAccount(provider.connection, maker, mintA, maker.publicKey);
    makerAtaB = await createAssociatedTokenAccount(provider.connection, maker, mintB, maker.publicKey);
    takerAtaA = await createAssociatedTokenAccount(provider.connection, taker, mintA, taker.publicKey);
    takerAtaB = await createAssociatedTokenAccount(provider.connection, taker, mintB, taker.publicKey);

    // 4. Fund Maker with Token A, Taker with Token B
    await mintTo(provider.connection, maker, mintA, makerAtaA, maker, 1_000_000_000);
    await mintTo(provider.connection, taker, mintB, takerAtaB, taker, 1_000_000_000);
  });

  it("Initializes swap escrow with locked vault funds", async () => {
    const currentSlot = await provider.connection.getSlot();
    const expirySlot = new anchor.BN(currentSlot + 100);

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("swap_escrow"), maker.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), escrowPda.toBuffer()],
      program.programId
    );

    const vaultTokenKeypair = anchor.web3.Keypair.generate();

    await program.methods
      .initializeSwap(seed, amountA, amountB, expirySlot)
      .accounts({
        maker: maker.publicKey,
        tokenAMint: mintA,
        tokenBMint: mintB,
        makerTokenA: makerAtaA,
        escrowState: escrowPda,
        vaultAuthority: vaultAuthority,
        vaultTokenA: vaultTokenKeypair.publicKey,
        tokenProgramA: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([maker, vaultTokenKeypair])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultTokenKeypair.publicKey);
    expect(Number(vaultAccount.amount)).to.equal(amountA.toNumber());

    const escrowData = await program.account.escrowState.fetch(escrowPda);
    expect(escrowData.maker.toBase58()).to.equal(maker.publicKey.toBase58());
    expect(escrowData.makerAmountIn.toNumber()).to.equal(amountA.toNumber());
    expect(escrowData.takerExpectedAmountOut.toNumber()).to.equal(amountB.toNumber());
  });

  it("Executes atomic swap across maker and taker accounts", async () => {
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("swap_escrow"), maker.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), escrowPda.toBuffer()],
      program.programId
    );

    // Derive the Vault Token Account associated with vault authority
    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount).to.not.be.null;

    // Fetch the program's vault token account by filtering on authority
    const tokenAccounts = await provider.connection.getTokenAccountsByOwner(vaultAuthority, {
      mint: mintA,
    });
    const vaultTokenAccount = tokenAccounts.value[0].pubkey;

    await program.methods
      .executeSwap()
      .accounts({
        taker: taker.publicKey,
        maker: maker.publicKey,
        tokenAMint: mintA,
        tokenBMint: mintB,
        escrowState: escrowPda,
        vaultAuthority: vaultAuthority,
        vaultTokenA: vaultTokenAccount,
        takerTokenA: takerAtaA,
        takerTokenB: takerAtaB,
        makerTokenB: makerAtaB,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Verify balances
    const takerTokenABalance = await getAccount(provider.connection, takerAtaA);
    const makerTokenBBalance = await getAccount(provider.connection, makerAtaB);

    expect(Number(takerTokenABalance.amount)).to.equal(amountA.toNumber());
    expect(Number(makerTokenBBalance.amount)).to.equal(amountB.toNumber());

    // Verify Escrow State PDA is closed
    const closedEscrow = await provider.connection.getAccountInfo(escrowPda);
    expect(closedEscrow).to.be.null;
  });
});