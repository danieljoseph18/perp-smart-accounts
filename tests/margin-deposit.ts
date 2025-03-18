import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  getAccount,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { expect } from "chai";

describe("perp-margin-accounts deposit", () => {
  // Configure the client
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // For testing we need:
  let usdcMint: PublicKey;
  let solMint: PublicKey;
  let marginVault: PublicKey;
  let solVaultAccount: PublicKey;
  let usdcVaultAccount: PublicKey;

  // User accounts
  let userSolAccount: PublicKey;
  let userUsdcAccount: PublicKey;
  let userMarginAccount: PublicKey;

  // Test amounts
  const withdrawalTimelock = 24 * 60 * 60; // 24 hours in seconds
  const solDepositAmount = new anchor.BN(1_000_000_000); // 1 SOL (in lamports)
  const usdcDepositAmount = new anchor.BN(1_000_000); // 1 USDC (with 6 decimals)

  before(async () => {
    console.log("Program ID:", program.programId.toString());

    // Create mock USDC mint
    usdcMint = await createMint(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      6
    );
    console.log("Created USDC mint:", usdcMint.toString());

    // Use native SOL mint for SOL
    solMint = NATIVE_MINT;
    console.log("Using SOL mint:", solMint.toString());

    // Derive the margin vault PDA
    [marginVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault")],
      program.programId
    );
    console.log("Margin vault PDA:", marginVault.toString());

    // Create user token accounts
    const userSolAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      solMint,
      provider.wallet.publicKey
    );
    userSolAccount = userSolAccountInfo.address;
    console.log("User SOL account:", userSolAccount.toString());

    const userUsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      provider.wallet.publicKey
    );
    userUsdcAccount = userUsdcAccountInfo.address;
    console.log("User USDC account:", userUsdcAccount.toString());

    // Fund user USDC account
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      userUsdcAccount,
      provider.wallet.publicKey,
      10_000_000 // 10 USDC
    );
    console.log("Funded user USDC account with 10 USDC");

    // For wrapped SOL, we need to use the syncNative instruction
    // First, transfer SOL to the associated token account address
    const solToWrap = 5_000_000_000; // 5 SOL

    const wrapSolIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: userSolAccount,
      lamports: solToWrap,
    });

    // Create a sync native instruction to update the token account balance
    const syncNativeIx = createSyncNativeInstruction(userSolAccount);

    // Build and send the transaction
    const tx = new anchor.web3.Transaction().add(wrapSolIx).add(syncNativeIx);

    await provider.sendAndConfirm(tx);
    console.log("Funded and synced user SOL account with 5 SOL");

    // Create vault token accounts
    const solVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      solMint,
      marginVault,
      true
    );
    solVaultAccount = solVault.address;
    console.log("Created SOL vault:", solVaultAccount.toString());

    const usdcVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      marginVault,
      true
    );
    usdcVaultAccount = usdcVault.address;
    console.log("Created USDC vault:", usdcVaultAccount.toString());

    // Initialize the margin vault
    await program.methods
      .initialize(new anchor.BN(withdrawalTimelock))
      .accountsStrict({
        authority: provider.wallet.publicKey,
        marginVault: marginVault,
        solVault: solVaultAccount,
        usdcVault: usdcVaultAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("Initialized margin vault");

    // Derive the user's margin account PDA
    [userMarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );
    console.log("User margin account PDA:", userMarginAccount.toString());
  });

  it("Should initialize and deposit USDC to a new margin account", async () => {
    // Get initial USDC balance in user account
    const initialUserUsdcAccount = await getAccount(
      provider.connection,
      userUsdcAccount
    );
    const initialUserUsdcBalance = initialUserUsdcAccount.amount;

    // Get initial USDC balance in vault
    const initialVaultUsdcAccount = await getAccount(
      provider.connection,
      usdcVaultAccount
    );
    const initialVaultUsdcBalance = initialVaultUsdcAccount.amount;

    // Perform the deposit
    await program.methods
      .depositMargin(usdcDepositAmount)
      .accountsStrict({
        marginAccount: userMarginAccount,
        marginVault: marginVault,
        vaultTokenAccount: usdcVaultAccount,
        userTokenAccount: userUsdcAccount,
        owner: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Get final user USDC balance
    const finalUserUsdcAccount = await getAccount(
      provider.connection,
      userUsdcAccount
    );
    const finalUserUsdcBalance = finalUserUsdcAccount.amount;

    // Get final vault USDC balance
    const finalVaultUsdcAccount = await getAccount(
      provider.connection,
      usdcVaultAccount
    );
    const finalVaultUsdcBalance = finalVaultUsdcAccount.amount;

    // Verify token balances changed correctly
    expect(
      Number(initialUserUsdcBalance) - Number(finalUserUsdcBalance)
    ).to.equal(Number(usdcDepositAmount));
    expect(
      Number(finalVaultUsdcBalance) - Number(initialVaultUsdcBalance)
    ).to.equal(Number(usdcDepositAmount));

    // Verify margin account state
    const marginAccount = await program.account.marginAccount.fetch(
      userMarginAccount
    );
    expect(marginAccount.owner.toString()).to.equal(
      provider.wallet.publicKey.toString()
    );
    expect(marginAccount.usdcBalance.toString()).to.equal(
      usdcDepositAmount.toString()
    );
    expect(marginAccount.solBalance.toString()).to.equal("0");
    expect(marginAccount.pendingSolWithdrawal.toString()).to.equal("0");
    expect(marginAccount.pendingUsdcWithdrawal.toString()).to.equal("0");
  });

  it("Should deposit SOL to an existing margin account", async () => {
    // Get initial SOL balance in user account
    const initialUserSolAccount = await getAccount(
      provider.connection,
      userSolAccount
    );
    const initialUserSolBalance = initialUserSolAccount.amount;

    // Get initial SOL balance in vault
    const initialVaultSolAccount = await getAccount(
      provider.connection,
      solVaultAccount
    );
    const initialVaultSolBalance = initialVaultSolAccount.amount;

    // Deposit SOL to the same margin account
    await program.methods
      .depositMargin(solDepositAmount)
      .accountsStrict({
        marginAccount: userMarginAccount,
        marginVault: marginVault,
        vaultTokenAccount: solVaultAccount,
        userTokenAccount: userSolAccount,
        owner: provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Get final user SOL balance
    const finalUserSolAccount = await getAccount(
      provider.connection,
      userSolAccount
    );
    const finalUserSolBalance = finalUserSolAccount.amount;

    // Get final vault SOL balance
    const finalVaultSolAccount = await getAccount(
      provider.connection,
      solVaultAccount
    );
    const finalVaultSolBalance = finalVaultSolAccount.amount;

    // Verify token balances changed correctly
    expect(
      Number(initialUserSolBalance) - Number(finalUserSolBalance)
    ).to.equal(Number(solDepositAmount));
    expect(
      Number(finalVaultSolBalance) - Number(initialVaultSolBalance)
    ).to.equal(Number(solDepositAmount));

    // Verify margin account state is updated with both SOL and USDC balances
    const marginAccount = await program.account.marginAccount.fetch(
      userMarginAccount
    );
    expect(marginAccount.owner.toString()).to.equal(
      provider.wallet.publicKey.toString()
    );
    expect(marginAccount.usdcBalance.toString()).to.equal(
      usdcDepositAmount.toString()
    );
    expect(marginAccount.solBalance.toString()).to.equal(
      solDepositAmount.toString()
    );
  });

  it("Should fail to deposit with incorrect token account owner", async () => {
    // Create another wallet
    const otherWallet = Keypair.generate();

    // Airdrop some SOL to the other wallet
    const signature = await provider.connection.requestAirdrop(
      otherWallet.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);

    // Create a token account for the other wallet
    const otherUsdcAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      otherWallet.publicKey
    );

    // Fund the other wallet's USDC account
    await mintTo(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      otherUsdcAccount.address,
      provider.wallet.publicKey,
      1_000_000 // 1 USDC
    );

    try {
      // Try to deposit from the main wallet's margin account using the other wallet's token account
      await program.methods
        .depositMargin(new anchor.BN(100_000))
        .accountsStrict({
          marginAccount: userMarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: usdcVaultAccount,
          userTokenAccount: otherUsdcAccount.address,
          owner: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // If we reach here, the test should fail
      expect.fail("Should have thrown a constraint error");
    } catch (error: any) {
      // We expect a constraint error
      expect(error.toString()).to.include("Constraint");
    }
  });

  it("Should fail to deposit with incorrect vault token account", async () => {
    // Create a random token account that's not the vault
    const fakeVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as anchor.Wallet).payer,
      usdcMint,
      Keypair.generate().publicKey,
      true
    );

    try {
      // Try to deposit to a fake vault
      await program.methods
        .depositMargin(new anchor.BN(100_000))
        .accountsStrict({
          marginAccount: userMarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: fakeVault.address,
          userTokenAccount: userUsdcAccount,
          owner: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // If we reach here, the test should fail
      expect.fail("Should have thrown a constraint error");
    } catch (error: any) {
      // We expect a constraint error
      expect(error.toString()).to.include("Constraint");
    }
  });
});
